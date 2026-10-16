import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const counts = z.record(z.string(), z.number());

export const passSummary = z.object({
  pass: z.string(), at: z.string(), requestedMode: z.enum(["preview", "archive"]),
  effectiveMode: z.enum(["preview", "archive"]), blockers: z.array(z.string()),
  decisions: counts, archived: z.number(), errors: z.number(),
});
export type PassSummary = z.infer<typeof passSummary>;

export const statusRpc = defineRpc({
  name: "session-archiver.status",
  input: z.object({}),
  output: z.object({
    settings: z.enum(["ready", "invalid", "unread"]),
    sdkContext: z.boolean(),
    bootstrap: z.enum(["ready", "awaiting-sdk-context"]), bootstrapSource: z.enum(["hook", "rpc", "standalone"]).nullable(), standalone: z.string(),
    bootstrapAt: z.string().nullable(), ticksWithoutContext: z.number(), running: z.boolean(), nextPassAt: z.string().nullable(),
    journalPath: z.string(), storePath: z.string(), lastPass: passSummary.nullable(), diagnostics: z.array(z.string()),
  }),
});

// Records that the caller consumed the helper's CURRENT outcome. The server snapshots the exact
// updatedAt/lastUserMessageAt itself; any later activity makes the record stale.
export const markConsumedRpc = defineRpc({
  name: "session-archiver.mark-consumed",
  input: z.object({ agentId: z.string().min(1).max(128) }),
  output: z.object({ ok: z.boolean(), reason: z.string().nullable(), updatedAt: z.string().nullable() }),
});

// Forced preview: never archives, regardless of mode. Returns IDs and decisions only.
export const previewNowRpc = defineRpc({
  name: "session-archiver.preview-now",
  input: z.object({}),
  output: z.object({
    summary: passSummary.nullable(), reason: z.string().nullable(),
    rows: z.array(z.object({ agentId: z.string(), kind: z.enum(["helper", "root"]), decision: z.string(), ageHours: z.number().nullable() })),
  }),
});
