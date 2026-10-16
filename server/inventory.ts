import { execFile } from "node:child_process";
import type { PaseoApi } from "@getpaseo/client";
import { toFacts, type AgentFacts } from "./engine";

export const LIMITS = { pageSize: 200, maxPages: 50, maxSchedules: 100, cliTimeoutMs: 15_000, cliMaxBytes: 1_048_576 };

// Full metadata inventory, archived agents included so the parent map is complete. Bounded.
export async function listAllAgents(paseo: Pick<PaseoApi, "agents">, limits = LIMITS): Promise<{ agents: AgentFacts[]; complete: boolean }> {
  const agents: AgentFacts[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < limits.maxPages; page++) {
    const result = await paseo.agents.list({ filter: { includeArchived: true }, page: cursor ? { limit: limits.pageSize, cursor } : { limit: limits.pageSize } });
    for (const entry of result.entries) agents.push(toFacts(entry.agent));
    if (!result.pageInfo.hasMore) return { agents, complete: true };
    if (!result.pageInfo.nextCursor) return { agents, complete: false };
    cursor = result.pageInfo.nextCursor;
  }
  return { agents, complete: false };
}

export type RunCli = (args: readonly string[]) => Promise<string>;

// No shell, bounded time and output. Output is parsed, never logged.
export function execCli(binary: string, limits = LIMITS): RunCli {
  return args => new Promise((resolve, reject) => {
    execFile(binary, [...args], { shell: false, timeout: limits.cliTimeoutMs, maxBuffer: limits.cliMaxBytes, windowsHide: true },
      (error, stdout) => error ? reject(new Error(`cli ${args.slice(0, 2).join(" ")} failed`)) : resolve(stdout));
  });
}

function scheduleIds(listing: unknown): string[] | null {
  const rows = Array.isArray(listing) ? listing
    : listing && typeof listing === "object" && Array.isArray((listing as { schedules?: unknown }).schedules) ? (listing as { schedules: unknown[] }).schedules
    : null;
  if (!rows) return null;
  const ids: string[] = [];
  for (const row of rows) {
    const id = row && typeof row === "object" ? (row as { id?: unknown }).id : undefined;
    if (typeof id !== "string" || !id) return null;
    ids.push(id);
  }
  return ids;
}

function targetOf(inspect: unknown): { type: string; agentId?: string } | null {
  if (!inspect || typeof inspect !== "object") return null;
  const record = inspect as Record<string, unknown>;
  const holder = record.schedule && typeof record.schedule === "object" ? record.schedule as Record<string, unknown> : record;
  const target = holder.target;
  if (!target || typeof target !== "object") return null;
  const t = target as Record<string, unknown>;
  if (typeof t.type !== "string") return null;
  return typeof t.agentId === "string" ? { type: t.type, agentId: t.agentId } : { type: t.type };
}

// Agents referenced by any schedule (any state). Heartbeats are assumed to be self/agent schedules;
// that assumption is gated separately by the heartbeat readiness evidence.
export async function listScheduleTargets(run: RunCli, limits = LIMITS): Promise<{ complete: boolean; agentIds: Set<string> }> {
  const agentIds = new Set<string>();
  try {
    const ids = scheduleIds(JSON.parse(await run(["schedule", "ls", "--json"])));
    if (!ids || ids.length > limits.maxSchedules) return { complete: false, agentIds };
    for (const id of ids) {
      const target = targetOf(JSON.parse(await run(["schedule", "inspect", id, "--json"])));
      if (!target) return { complete: false, agentIds };
      if (target.type === "self" || target.type === "agent") {
        if (!target.agentId) return { complete: false, agentIds };
        agentIds.add(target.agentId);
      } else if (target.type !== "new-agent") return { complete: false, agentIds };
    }
    return { complete: true, agentIds };
  } catch {
    return { complete: false, agentIds };
  }
}
