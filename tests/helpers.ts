import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { archiverSchema, PLUGIN_VERSION, type ArchiverConfig } from "../shared/settings";
import type { AgentFacts } from "../server/engine";

export const NOW = Date.parse("2026-10-16T12:00:00.000Z");
export const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export function config(over: Partial<ArchiverConfig> = {}): ArchiverConfig {
  return { ...archiverSchema.parse({}), ...over };
}

export function readyConfig(over: Partial<ArchiverConfig> = {}): ArchiverConfig {
  return config({ mode: "archive", readiness: { pluginVersion: PLUGIN_VERSION, restoreEvidence: "docker:2026-10-16:run-a", heartbeatEvidence: "docker:2026-10-16:run-b", turnBumpsUpdatedAtEvidence: "docker:2026-10-16:run-c" }, ...over });
}

export function facts(id: string, over: Partial<AgentFacts> = {}): AgentFacts {
  return { id, workspaceId: "ws-1", parentAgentId: null, status: "idle", archived: false, activeTurn: false, pendingPermissions: 0, attentionPermission: false, providerUnavailable: false, asyncQuestions: 0, keep: false, updatedAt: iso(8 * DAY), lastUserMessageAt: null, ...over };
}

// Raw AgentSnapshotPayload-like object, as returned inside agents.list entries.
export function snapshot(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, workspaceId: "ws-1", status: "idle", archivedAt: null, activeTurn: null, pendingPermissions: [], attentionReason: null, providerUnavailable: false, persistence: { metadata: {} }, labels: {}, updatedAt: iso(8 * DAY), lastUserMessageAt: null, title: "SECRET-TITLE", ...over };
}

export interface FakeAgents { list: Record<string, unknown>[]; pageSize?: number; refreshOverride?: Record<string, Record<string, unknown> | null>; calls: string[] }

// Minimal fake of the public agents API: list (paginated), ref(id).refresh/archive. Records every call.
export function fakePaseo(state: FakeAgents): PaseoApi {
  const pageSize = state.pageSize ?? 1000;
  const agents = {
    async list(opts: { page?: { limit: number; cursor?: string } }) {
      state.calls.push(`list:${opts.page?.cursor ?? ""}`);
      const start = opts.page?.cursor ? Number(opts.page.cursor) : 0;
      const slice = state.list.slice(start, start + pageSize);
      const next = start + pageSize;
      const hasMore = next < state.list.length;
      return { entries: slice.map(agent => ({ agent })), pageInfo: { hasMore, nextCursor: hasMore ? String(next) : null } };
    },
    ref(id: string) {
      return {
        async refresh() {
          state.calls.push(`refresh:${id}`);
          if (state.refreshOverride && id in state.refreshOverride) { const a = state.refreshOverride[id]; return a ? { agent: a } : null; }
          const a = state.list.find(x => x.id === id);
          return a ? { agent: a } : null;
        },
        async archive() { state.calls.push(`archive:${id}`); },
      };
    },
  };
  return new Proxy({ agents } as object, {
    get(target, prop) {
      if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
      if (prop === "then") return undefined;
      throw new Error(`unexpected PaseoApi access: ${String(prop)}`);
    },
  }) as PaseoApi;
}

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sa-test-"));
}
