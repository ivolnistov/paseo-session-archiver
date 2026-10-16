import type { PaseoApi } from "@getpaseo/client";
import { liveDescendants, toFacts } from "./engine";
import { execCli, listAllAgents, listScheduleTargets } from "./inventory";
import type { Journal } from "./journal";
import type { ConsumptionStore } from "./store";
import type { SweepPorts } from "./sweeper";

export function sdkPorts(paseo: PaseoApi, journal: Journal, store: ConsumptionStore, cliPath: string): SweepPorts {
  return {
    inventory: () => listAllAgents(paseo),
    schedules: () => listScheduleTargets(execCli(cliPath)),
    consumed: () => store.load(),
    async refresh(id) {
      const result = await paseo.agents.ref(id).refresh();
      return result?.agent ? toFacts(result.agent) : null;
    },
    async archive(id) { await paseo.agents.ref(id).archive(); },
    journal: rows => journal.append(rows),
    now: () => Date.now(),
  };
}

export type MarkResult = { ok: true; updatedAt: string } | { ok: false; reason: string };

// Binds consumption to the exact current snapshot. Shared by the plugin RPC and the admin CLI.
// Refuses anything not idle and turn-free, with questions, or with an unarchived descendant.
export async function markConsumed(paseo: Pick<PaseoApi, "agents">, store: ConsumptionStore, agentId: string, now: number): Promise<MarkResult> {
  const inventory = await listAllAgents(paseo);
  if (!inventory.complete) return { ok: false, reason: "inventory-incomplete" };
  const live = liveDescendants(inventory.agents);
  if (!live) return { ok: false, reason: "parent-map-cycle" };
  if (live.get(agentId) !== false) return { ok: false, reason: live.has(agentId) ? "live-descendant" : "not-found" };
  const result = await paseo.agents.ref(agentId).refresh();
  const agent = result?.agent;
  if (!agent) return { ok: false, reason: "not-found" };
  const facts = toFacts(agent);
  if (facts.archived) return { ok: false, reason: "archived" };
  if (!facts.parentAgentId) return { ok: false, reason: "not-a-helper" };
  if (facts.status !== "idle" || facts.activeTurn) return { ok: false, reason: "not-idle" };
  if (facts.pendingPermissions !== 0 || facts.attentionPermission) return { ok: false, reason: "pending-permission" };
  if (facts.asyncQuestions !== 0) return { ok: false, reason: "async-question" };
  if (!facts.updatedAt || !Number.isFinite(Date.parse(facts.updatedAt))) return { ok: false, reason: "bad-timestamp" };
  const updatedAt = facts.updatedAt;
  await store.update(records => { records.set(agentId, { updatedAt, lastUserMessageAt: facts.lastUserMessageAt, consumedAt: now }); });
  return { ok: true, updatedAt };
}
