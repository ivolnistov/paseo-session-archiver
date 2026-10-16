// Session archiver admin CLI. Public @getpaseo/client SDK only; no internal RPC, no credential
// discovery. Shares the plugin's validated store, lock and control file under an explicit data dir.
// Usage: tsx admin/cli.ts --url <ws://host:port/ws> --data-dir <abs dir> [--password-env NAME]
//          [--paseo-cli <path>] <mark-consumed <agentId> | preview | pause | resume | status>
import { open, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
import { archiverSchema } from "../shared/settings";
import { markConsumed } from "../server/adapter";
import { ControlFile } from "../server/control";
import { toFacts } from "../server/engine";
import { execCli, listAllAgents, listScheduleTargets } from "../server/inventory";
import { ConsumptionStore } from "../server/store";
import { Sweeper } from "../server/sweeper";

export interface CliOptions { url: string | null; dataDir: string; passwordEnv: string | null; paseoCli: string; command: string; agentId: string | null }

export function parseArgs(argv: readonly string[]): CliOptions {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      flags.set(arg.slice(2), value);
    } else rest.push(arg);
  }
  for (const key of flags.keys()) if (!["url", "data-dir", "password-env", "paseo-cli"].includes(key)) throw new Error(`unknown flag --${key}`);
  const dataDir = flags.get("data-dir");
  if (!dataDir || !isAbsolute(dataDir)) throw new Error("--data-dir must be an absolute path matching the plugin dataDir");
  const [command, agentId, extra] = rest;
  if (!command || !["mark-consumed", "preview", "pause", "resume", "status"].includes(command) || extra !== undefined) throw new Error("unknown command");
  if ((command === "mark-consumed") !== (agentId !== undefined)) throw new Error("mark-consumed takes exactly one agent id");
  const url = flags.get("url") ?? null;
  if ((command === "mark-consumed" || command === "preview") && !url) throw new Error("--url is required for this command");
  if (url && !/^wss?:\/\//.test(url)) throw new Error("--url must be a ws:// or wss:// daemon endpoint");
  return { url, dataDir, passwordEnv: flags.get("password-env") ?? null, paseoCli: flags.get("paseo-cli") ?? "paseo", command, agentId: agentId ?? null };
}

async function connect(options: CliOptions): Promise<PaseoClient> {
  const password = options.passwordEnv ? process.env[options.passwordEnv] : undefined;
  if (options.passwordEnv && !password) throw new Error(`environment variable ${options.passwordEnv} is empty`);
  const client = createPaseoClient({ url: options.url!, clientId: "session-archiver-admin", connectTimeoutMs: 10_000, reconnect: { enabled: false }, ...(password ? { password } : {}) });
  await client.connect();
  return client;
}

async function journalTail(path: string): Promise<{ bootstrap: string | null; lastPass: string | null }> {
  try {
    const size = (await stat(path)).size;
    const length = Math.min(size, 65_536);
    const handle = await open(path, "r");
    const buffer = Buffer.alloc(length);
    try { await handle.read(buffer, 0, length, size - length); } finally { await handle.close(); }
    let bootstrap: string | null = null;
    let lastPass: string | null = null;
    for (const line of buffer.toString("utf8").split("\n")) {
      try {
        const row = JSON.parse(line) as { ts?: string; event?: string; code?: string; mode?: string };
        if (row.event === "diagnostic" && row.code?.startsWith("bootstrap:")) bootstrap = `${row.ts} ${row.code}`;
        if (row.event === "pass") lastPass = `${row.ts} ${row.mode ?? ""} ${row.code ?? ""}`.trim();
      } catch { /* partial first line */ }
    }
    return { bootstrap, lastPass };
  } catch { return { bootstrap: null, lastPass: null }; }
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  const store = new ConsumptionStore(options.dataDir);
  const control = new ControlFile(options.dataDir);
  if (options.command === "pause" || options.command === "resume") {
    await control.setPaused(options.command === "pause", Date.now());
    console.log(JSON.stringify({ paused: await control.paused() }));
    return 0;
  }
  if (options.command === "status") {
    const records = await store.load();
    console.log(JSON.stringify({ paused: await control.paused(), store: records ? { valid: true, records: records.size } : { valid: false }, ...(await journalTail(join(options.dataDir, "journal.jsonl"))) }));
    return 0;
  }
  const client = await connect(options);
  try {
    if (options.command === "mark-consumed") {
      const result = await markConsumed(client, store, options.agentId!, Date.now());
      console.log(JSON.stringify(result));
      return result.ok ? 0 : 2;
    }
    // Read-only preview with schema defaults; never archives and writes no journal.
    const sweeper = new Sweeper({
      inventory: () => listAllAgents(client), schedules: () => listScheduleTargets(execCli(options.paseoCli)), consumed: () => store.load(),
      async refresh(id) { const r = await client.agents.ref(id).refresh(); return r?.agent ? toFacts(r.agent) : null; },
      async archive() { throw new Error("preview never archives"); }, async journal() {}, now: () => Date.now(),
    });
    const outcome = await sweeper.run(archiverSchema.parse({}), "preview", true);
    console.log(JSON.stringify({ summary: outcome?.summary ?? null, rows: (outcome?.rows ?? []).filter(r => r.decision !== "skipped:archived").map(r => ({ agentId: r.agentId, kind: r.kind, decision: r.decision, ageHours: r.ageHours })) }));
    return 0;
  } finally { await client.close(); }
}

if (process.argv[1] && /admin[\\/]cli\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (error: unknown) => {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : "failed" }));
    process.exitCode = 1;
  });
}
