import type { ArchiverConfig } from "../shared/settings";
import { KEEP_LABEL, PARENT_LABEL } from "../shared/labels";

const HOUR = 3_600_000;
const FUTURE_TOLERANCE_MS = 60_000;

export type SkipReason =
  | "archived" | "not-idle" | "active-turn" | "pending-permission" | "provider-unavailable"
  | "async-question-pending" | "async-question-unknown" | "keep" | "bad-timestamp" | "live-descendant"
  | "scheduled" | "unconsumed" | "stale-consumption" | "consumption-store-invalid"
  | "grace" | "root-young" | "cap";

export type Decision = "preview" | "archive" | "error" | `skipped:${SkipReason}`;

// Minimal, sanitised view of an agent snapshot. No titles, prompts, question text or other labels.
export interface AgentFacts {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  status: string;
  archived: boolean;
  activeTurn: boolean;
  pendingPermissions: number;
  attentionPermission: boolean;
  providerUnavailable: boolean;
  asyncQuestions: number | "unknown";
  keep: boolean;
  updatedAt: string | null;
  lastUserMessageAt: string | null;
}

export interface DecisionRow {
  agentId: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  status: string;
  kind: "helper" | "root";
  ageHours: number | null;
  decision: Decision;
  consumption: "present" | "absent";
  outcomeIdentity: string | null;
}

// Written only by the mark-consumed RPC from an idle, turn-free snapshot. Exact strings, no slack.
export interface ConsumptionRecord {
  updatedAt: string;
  lastUserMessageAt: string | null;
  consumedAt: number;
}

export interface PassInput {
  agents: readonly AgentFacts[];
  inventoryComplete: boolean;
  schedules: { complete: boolean; agentIds: ReadonlySet<string> };
  // null: the store could not be read or validated; every helper fails closed.
  consumed: ReadonlyMap<string, ConsumptionRecord> | null;
  config: ArchiverConfig;
  now: number;
  mode: "preview" | "archive";
  sdkContext: boolean;
  readiness: string[];
}

export interface PassResult {
  effectiveMode: "preview" | "archive";
  blockers: string[];
  rows: DecisionRow[];
  actions: string[];
}

const RESOLVED = new Set(["resolved", "answered", "closed", "cancelled", "canceled", "dismissed", "expired"]);
const UNRESOLVED = new Set(["pending", "open", "unresolved", "waiting", "asked"]);

// Counts unresolved async questions from state fields only; text is never read. Unknown shapes fail closed.
export function countAsyncQuestions(metadata: unknown): number | "unknown" {
  if (metadata === undefined || metadata === null) return 0;
  if (typeof metadata !== "object") return "unknown";
  const raw = (metadata as Record<string, unknown>).asyncQuestions;
  if (raw === undefined || raw === null) return 0;
  const items = Array.isArray(raw) ? raw : typeof raw === "object" ? Object.values(raw) : null;
  if (!items) return "unknown";
  let open = 0;
  for (const item of items) {
    if (!item || typeof item !== "object") return "unknown";
    const q = item as Record<string, unknown>;
    if (q.resolved === true || typeof q.answeredAt === "string" || typeof q.resolvedAt === "string") continue;
    const state = typeof q.status === "string" ? q.status : typeof q.state === "string" ? q.state : null;
    if (state !== null && RESOLVED.has(state.toLowerCase())) continue;
    if (q.resolved === false || (state !== null && UNRESOLVED.has(state.toLowerCase()))) { open++; continue; }
    return "unknown";
  }
  return open;
}

interface SnapshotLike {
  id: string;
  workspaceId?: string | null;
  status: string;
  archivedAt?: string | null;
  activeTurn?: unknown;
  pendingPermissions?: readonly unknown[] | null;
  attentionReason?: string | null;
  providerUnavailable?: boolean;
  persistence?: { metadata?: unknown } | null;
  labels?: Record<string, string>;
  updatedAt?: string | null;
  lastUserMessageAt?: string | null;
}

export function toFacts(a: SnapshotLike): AgentFacts {
  const labels = a.labels ?? {};
  return {
    id: a.id,
    workspaceId: a.workspaceId ?? null,
    parentAgentId: labels[PARENT_LABEL] || null,
    status: a.status,
    archived: a.archivedAt !== null && a.archivedAt !== undefined,
    activeTurn: a.activeTurn !== null && a.activeTurn !== undefined,
    // A missing array is not proof of absence.
    pendingPermissions: Array.isArray(a.pendingPermissions) ? a.pendingPermissions.length : Number.POSITIVE_INFINITY,
    attentionPermission: a.attentionReason === "permission",
    providerUnavailable: a.providerUnavailable === true,
    asyncQuestions: countAsyncQuestions(a.persistence?.metadata),
    keep: Object.prototype.hasOwnProperty.call(labels, KEEP_LABEL),
    updatedAt: a.updatedAt ?? null,
    lastUserMessageAt: a.lastUserMessageAt ?? null,
  };
}

function parseTime(value: string | null, now: number): number | null | "bad" {
  if (value === null) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t) || t > now + FUTURE_TOLERANCE_MS) return "bad";
  return t;
}

// Map of agent ID -> whether any transitive descendant is unarchived. Null on a parent cycle.
export function liveDescendants(agents: readonly AgentFacts[]): Map<string, boolean> | null {
  const children = new Map<string, AgentFacts[]>();
  for (const a of agents) {
    if (!a.parentAgentId) continue;
    const list = children.get(a.parentAgentId) ?? [];
    list.push(a);
    children.set(a.parentAgentId, list);
  }
  const result = new Map<string, boolean>();
  const visiting = new Set<string>();
  const visit = (id: string): boolean | null => {
    const known = result.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return null;
    visiting.add(id);
    let live = false;
    for (const child of children.get(id) ?? []) {
      const below = visit(child.id);
      if (below === null) return null;
      if (!child.archived || below) live = true;
    }
    visiting.delete(id);
    result.set(id, live);
    return live;
  };
  for (const a of agents) if (visit(a.id) === null) return null;
  return result;
}

export function evaluateAgent(a: AgentFacts, ctx: { live: ReadonlyMap<string, boolean>; scheduled: ReadonlySet<string>; consumed: ReadonlyMap<string, ConsumptionRecord> | null; config: ArchiverConfig; now: number }): Omit<DecisionRow, "decision"> & { decision: Decision; lastActivity: number | null } {
  const kind = a.parentAgentId ? "helper" : "root";
  const record = ctx.consumed?.get(a.id);
  const consumption = record ? "present" : "absent";
  const updated = parseTime(a.updatedAt, ctx.now);
  const lastUser = parseTime(a.lastUserMessageAt, ctx.now);
  const valid = updated !== "bad" && updated !== null && lastUser !== "bad";
  const lastActivity = valid ? Math.max(updated, lastUser ?? 0) : null;
  const base = {
    agentId: a.id, workspaceId: a.workspaceId, parentAgentId: a.parentAgentId, status: a.status, kind,
    ageHours: lastActivity === null ? null : Math.floor((ctx.now - lastActivity) / HOUR), consumption,
    outcomeIdentity: a.updatedAt, lastActivity,
  } as const;
  const skip = (reason: SkipReason) => ({ ...base, decision: `skipped:${reason}` as Decision });
  if (a.archived) return skip("archived");
  if (a.status !== "idle") return skip("not-idle");
  if (a.activeTurn) return skip("active-turn");
  if (a.pendingPermissions !== 0 || a.attentionPermission) return skip("pending-permission");
  if (a.providerUnavailable) return skip("provider-unavailable");
  if (a.asyncQuestions === "unknown") return skip("async-question-unknown");
  if (a.asyncQuestions > 0) return skip("async-question-pending");
  if (a.keep) return skip("keep");
  if (lastActivity === null || updated === "bad" || updated === null) return skip("bad-timestamp");
  if (ctx.live.get(a.id) !== false) return skip("live-descendant");
  if (ctx.scheduled.has(a.id)) return skip("scheduled");
  if (kind === "root") {
    return ctx.now - lastActivity >= ctx.config.rootMaxIdleDays * 24 * HOUR ? { ...base, decision: "preview" } : skip("root-young");
  }
  // Identity is the exact (updatedAt, lastUserMessageAt) pair the coordinator consumed. Any later
  // state write that moves either value (new prompt, provider-initiated turn, label write) fails closed.
  // That every turn moves updatedAt is gated by turnBumpsUpdatedAtEvidence before archive mode acts.
  if (ctx.consumed === null) return skip("consumption-store-invalid");
  if (!record) return skip("unconsumed");
  if (record.updatedAt !== a.updatedAt || record.lastUserMessageAt !== a.lastUserMessageAt) return skip("stale-consumption");
  if (!Number.isFinite(record.consumedAt) || record.consumedAt > ctx.now + FUTURE_TOLERANCE_MS) return skip("consumption-store-invalid");
  if (ctx.now - Math.max(record.consumedAt, lastActivity) < ctx.config.childGraceMinutes * 60_000) return skip("grace");
  return { ...base, decision: "preview" };
}

export function decidePass(input: PassInput): PassResult {
  const blockers: string[] = [...input.readiness];
  if (input.config.paused) blockers.push("paused");
  if (!input.sdkContext) blockers.push("no-sdk-context");
  if (!input.inventoryComplete) blockers.push("inventory-incomplete");
  if (!input.schedules.complete) blockers.push("schedules-incomplete");
  if (input.consumed === null) blockers.push("consumption-store-invalid");
  const live = liveDescendants(input.agents);
  if (!live) blockers.push("parent-map-cycle");
  const effectiveMode = input.mode === "archive" && blockers.length === 0 ? "archive" : "preview";
  const evaluated = input.agents.map(a => evaluateAgent(a, { live: live ?? new Map(), scheduled: input.schedules.agentIds, consumed: input.consumed, config: input.config, now: input.now }));
  const eligible = evaluated.filter(r => r.decision === "preview").sort((x, y) => (x.lastActivity ?? 0) - (y.lastActivity ?? 0) || x.agentId.localeCompare(y.agentId));
  const selected = new Set(eligible.slice(0, input.config.maxActionsPerPass).map(r => r.agentId));
  const rows: DecisionRow[] = evaluated.map(({ lastActivity: _unused, ...row }) => {
    if (row.decision !== "preview") return row;
    if (!selected.has(row.agentId)) return { ...row, decision: "skipped:cap" };
    return effectiveMode === "archive" ? { ...row, decision: "archive" } : row;
  });
  const actions = effectiveMode === "archive" ? eligible.filter(r => selected.has(r.agentId)).map(r => r.agentId) : [];
  return { effectiveMode, blockers, rows, actions };
}
