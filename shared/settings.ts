import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const PLUGIN_VERSION = "0.1.0";

// Archive-mode readiness is evidence bound to this exact plugin version. A missing, malformed or
// other-version attestation keeps every pass in preview; preview itself never needs it.
const evidence = z.string().max(200).default("");

export const archiverSchema = z.object({
  mode: z.enum(["preview", "archive"]).default("preview"),
  paused: z.boolean().default(false),
  intervalMinutes: z.number().int().min(5).max(1440).default(30),
  startupDelayMinutes: z.number().int().min(1).max(60).default(5),
  rootMaxIdleDays: z.number().int().min(1).max(365).default(7),
  childGraceMinutes: z.number().int().min(1).max(1440).default(15),
  maxActionsPerPass: z.number().int().min(1).max(20).default(5),
  readiness: z.object({
    pluginVersion: z.string().max(40).default(""),
    restoreEvidence: evidence,
    heartbeatEvidence: evidence,
    turnBumpsUpdatedAtEvidence: evidence,
  }).default({ pluginVersion: "", restoreEvidence: "", heartbeatEvidence: "", turnBumpsUpdatedAtEvidence: "" }),
  // Empty means ~/.paseo/session-archiver/. Must be absolute when set.
  dataDir: z.string().max(512).refine(p => p === "" || p.startsWith("/"), "absolute path required").default(""),
  paseoCliPath: z.string().min(1).max(512).default("paseo"),
  // Autonomous startup through the public SDK on an explicit loopback endpoint. A hook or RPC context,
  // when one arrives, replaces it. passwordEnv names a daemon-process environment variable, if needed.
  bootstrap: z.object({
    enabled: z.boolean().default(true),
    daemonUrl: z.string().max(200).default("ws://127.0.0.1:6767/ws"),
    passwordEnv: z.string().regex(/^([A-Z_][A-Z0-9_]{0,63})?$/).default(""),
  }).default({ enabled: true, daemonUrl: "ws://127.0.0.1:6767/ws", passwordEnv: "" }),
});

export type ArchiverConfig = z.output<typeof archiverSchema>;

export const archiverSettings = defineSettings({ id: "archiver", scope: "host", version: 1, schema: archiverSchema });

// Evidence reference format: docker:<YYYY-MM-DD>:<short id of the recorded run>.
const EVIDENCE = /^docker:\d{4}-\d{2}-\d{2}:[A-Za-z0-9._-]{4,64}$/;

export function readinessBlockers(config: ArchiverConfig): string[] {
  const r = config.readiness;
  const blockers: string[] = [];
  if (r.pluginVersion !== PLUGIN_VERSION) blockers.push("readiness-version-mismatch");
  if (!EVIDENCE.test(r.restoreEvidence)) blockers.push("restore-unverified");
  if (!EVIDENCE.test(r.heartbeatEvidence)) blockers.push("heartbeat-coverage-unverified");
  if (!EVIDENCE.test(r.turnBumpsUpdatedAtEvidence)) blockers.push("outcome-identity-unverified");
  return blockers;
}
