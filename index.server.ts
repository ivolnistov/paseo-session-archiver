import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { archiverSchema, archiverSettings, readinessBlockers, type ArchiverConfig } from "./shared/settings";
import { markConsumedRpc, previewNowRpc, statusRpc, type PassSummary } from "./shared/rpc";
import { markConsumed, sdkPorts } from "./server/adapter";
import { Journal } from "./server/journal";
import { ConsumptionStore, defaultDataDir } from "./server/store";
import { ControlFile } from "./server/control";
import { bootstrapStandalone, type BootstrapState, type Connector, type StandaloneConnection } from "./server/bootstrap";
import { Sweeper } from "./server/sweeper";
import { join } from "node:path";

// Diagnostics carry codes and booleans only: no titles, prompts, paths of other agents or secrets.
const log = (code: string, extra: Record<string, unknown> = {}) => console.info(JSON.stringify({ component: "session-archiver", code, ...extra }));

// `connector` is the startup port injection point for tests (defaults to public createPaseoClient).
export default function contribute(server: PluginServerContext, connector?: Connector) {
  const settings = server.registerSettings(archiverSettings);
  let config: ArchiverConfig | null = null;
  let settingsState: "ready" | "invalid" | "unread" = "unread";
  let paseo: PaseoApi | null = null;
  // PluginServerContext exposes no SDK at startup (0.11.1). Bootstrap = first hook event (any agent
  // lifecycle on the daemon, no app needed) or any plugin RPC. Until then passes are not silent:
  // each tick journals no-sdk-context and status reports bootstrap "awaiting-sdk-context".
  let bootstrapSource: "hook" | "rpc" | "standalone" | null = null;
  let standalone: StandaloneConnection | null = null;
  let standaloneState: BootstrapState = "disabled";
  let standaloneStarted = false;
  let bootstrapAt: string | null = null;
  let ticksWithoutContext = 0;
  let dir = defaultDataDir();
  let journal = new Journal(join(dir, "journal.jsonl"));
  let store = new ConsumptionStore(dir);
  let control = new ControlFile(dir);
  let sweeper: Sweeper | null = null;
  let lastPass: PassSummary | null = null;
  let nextPassAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  // The server entry gets no SDK at startup; hook and RPC contexts carry the plugin's connection.
  const capture = (api: PaseoApi, source: "hook" | "rpc" | "standalone") => {
    if (disposed) return;
    // Prefer the host-provided context: it replaces a standalone connection, which is then closed.
    if (paseo && bootstrapSource === "standalone" && source !== "standalone") {
      paseo = api;
      bootstrapSource = source;
      const old = standalone;
      standalone = null;
      void old?.close().catch(() => undefined);
      log("sdk-context-switched", { source });
      return;
    }
    if (paseo) return;
    paseo = api;
    bootstrapSource = source;
    bootstrapAt = new Date().toISOString();
    log("sdk-context-ready", { source });
    void journal.append([{ ts: bootstrapAt, pass: "none", event: "diagnostic", code: `bootstrap:${source}` }]).catch(() => log("journal-append-failed"));
    // A pass missed for lack of context runs one startup delay after bootstrap, then the interval.
    if (config && ticksWithoutContext > 0) arm(config.startupDelayMinutes * 60_000);
  };

  const apply = (state: Awaited<ReturnType<typeof settings.read>>) => {
    const parsed = state.status === "ready" ? archiverSchema.safeParse(state.values) : null;
    if (!parsed?.success) { settingsState = "invalid"; config = null; log("settings-invalid"); return; }
    settingsState = "ready";
    config = parsed.data;
    dir = config.dataDir || defaultDataDir();
    journal = new Journal(join(dir, "journal.jsonl"));
    store = new ConsumptionStore(dir);
    control = new ControlFile(dir);
    log("settings-ready", { mode: config.mode, paused: config.paused, readinessBlockers: readinessBlockers(config) });
  };

  const runPass = async (mode: "preview" | "archive") => {
    if (!config) return { outcome: null, reason: "settings-unavailable" };
    if (!paseo) {
      ticksWithoutContext++;
      log("pass-blocked", { reason: "no-sdk-context" });
      await journal.append([{ ts: new Date().toISOString(), pass: "none", event: "diagnostic", code: "no-sdk-context" }]).catch(() => undefined);
      return { outcome: null, reason: "no-sdk-context" };
    }
    // One pass at a time across timer and RPC. Ports are rebuilt per pass so settings changes apply.
    if (sweeper?.busy) return { outcome: null, reason: "pass-in-progress" };
    sweeper = new Sweeper(sdkPorts(paseo, journal, store, config.paseoCliPath));
    // CLI pause (control.json) and settings pause both stop archiving; an invalid control file pauses.
    const effective = { ...config, paused: config.paused || await control.paused() };
    const outcome = await sweeper.run(effective, mode, true);
    if (outcome) lastPass = outcome.summary;
    return { outcome, reason: outcome ? null : "pass-in-progress" };
  };

  const scheduled = async () => {
    if (disposed || !config) return;
    if (config.paused || await control.paused()) { log("pass-paused"); return; }
    try {
      const { outcome, reason } = await runPass(config.mode);
      log("pass", outcome ? { effectiveMode: outcome.summary.effectiveMode, blockers: outcome.summary.blockers, archived: outcome.summary.archived, errors: outcome.summary.errors } : { skipped: reason });
    } catch { log("pass-failed"); }
  };

  const arm = (delayMs: number) => {
    if (timer) clearTimeout(timer);
    if (disposed) return;
    nextPassAt = Date.now() + delayMs;
    timer = setTimeout(() => {
      void scheduled().finally(() => arm((config?.intervalMinutes ?? 30) * 60_000));
    }, delayMs);
  };

  const startStandalone = () => {
    if (standaloneStarted || paseo || disposed || !config?.bootstrap.enabled) return;
    standaloneStarted = true;
    void bootstrapStandalone({
      url: config.bootstrap.daemonUrl, passwordEnv: config.bootstrap.passwordEnv,
      isCancelled: () => disposed || paseo !== null,
      onState: state => { standaloneState = state; if (state.startsWith("failed:")) log("bootstrap-failed", { state }); },
    }, connector).then(connection => {
      if (!connection) return;
      if (disposed || paseo) { void connection.close().catch(() => undefined); return; }
      standalone = connection;
      standaloneState = "ready";
      capture(connection.api, "standalone");
    });
  };

  const removeSettings = settings.subscribe(state => { apply(state); startStandalone(); });
  void settings.read().then(state => {
    apply(state);
    startStandalone();
    arm((config?.startupDelayMinutes ?? 5) * 60_000);
  }, () => { settingsState = "invalid"; log("settings-read-failed"); arm(5 * 60_000); });

  server.handle(statusRpc, async (_input, ctx) => {
    capture(ctx.paseo, "rpc");
    const diagnostics: string[] = [];
    if (await control.paused()) diagnostics.push("paused-by-control-file");
    if (bootstrapSource === null) diagnostics.push("NOT-RUNNING:awaiting-sdk-context");
    if (standaloneState.startsWith("failed:")) diagnostics.push(`standalone-${standaloneState}`);
    if (bootstrapSource === "rpc" && ticksWithoutContext > 0) diagnostics.push("bootstrapped-by-rpc-after-blocked-ticks");
    const current = config;
    if (!current) diagnostics.push("settings-unavailable");
    else {
      if (current.paused) diagnostics.push("paused");
      if (current.mode === "archive") for (const b of readinessBlockers(current)) diagnostics.push(`archive-blocked:${b}`);
    }
    return {
      settings: settingsState, sdkContext: paseo !== null,
      bootstrap: paseo ? "ready" as const : "awaiting-sdk-context" as const, bootstrapSource, bootstrapAt, ticksWithoutContext, standalone: standaloneState, running: sweeper?.busy ?? false,
      nextPassAt: nextPassAt ? new Date(nextPassAt).toISOString() : null, journalPath: journal.path, storePath: store.path, lastPass, diagnostics,
    };
  });

  server.handle(previewNowRpc, async (_input, ctx) => {
    capture(ctx.paseo, "rpc");
    const { outcome, reason } = await runPass("preview");
    return {
      summary: outcome?.summary ?? null, reason,
      rows: (outcome?.rows ?? []).filter(r => r.decision !== "skipped:archived").map(r => ({ agentId: r.agentId, kind: r.kind, decision: r.decision, ageHours: r.ageHours })),
    };
  });

  server.handle(markConsumedRpc, async ({ agentId }, ctx) => {
    capture(ctx.paseo, "rpc");
    try {
      const result = await markConsumed(ctx.paseo, store, agentId, Date.now());
      await journal.append([{ ts: new Date().toISOString(), pass: "none", event: "consumed", agentId, code: result.ok ? "recorded" : `refused:${result.reason}`, outcomeIdentity: result.ok ? result.updatedAt : null }]).catch(() => log("journal-append-failed"));
      return result.ok ? { ok: true, reason: null, updatedAt: result.updatedAt } : { ok: false, reason: result.reason, updatedAt: null };
    } catch {
      return { ok: false, reason: "store-error", updatedAt: null };
    }
  });

  const removers = [
    server.on("agent.turn_ended", (_e, ctx) => capture(ctx.paseo, "hook")),
    server.on("agent.created", (_e, ctx) => capture(ctx.paseo, "hook")),
    server.on("agent.turn_started", (_e, ctx) => capture(ctx.paseo, "hook")),
    server.on("agent.archived", (_e, ctx) => capture(ctx.paseo, "hook")),
    server.on("workspace.created", (_e, ctx) => capture(ctx.paseo, "hook")),
  ];
  log("loaded");

  return async () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    removeSettings();
    for (const remove of removers) remove();
    const connection = standalone;
    standalone = null;
    await connection?.close().catch(() => undefined);
  };
}
