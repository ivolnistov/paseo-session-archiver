import { test } from "node:test";
import assert from "node:assert/strict";
import { countAsyncQuestions, decidePass, toFacts, type AgentFacts, type ConsumptionRecord, type PassInput } from "../server/engine";
import { PLUGIN_VERSION, readinessBlockers } from "../shared/settings";
import { config, DAY, facts, HOUR, iso, MIN, NOW, readyConfig, snapshot } from "./helpers";

function input(agents: AgentFacts[], over: Partial<PassInput> = {}): PassInput {
  return { agents, inventoryComplete: true, schedules: { complete: true, agentIds: new Set() }, consumed: new Map(), config: readyConfig(), now: NOW, mode: "archive", sdkContext: true, readiness: [], ...over };
}
const decision = (r: ReturnType<typeof decidePass>, id: string) => r.rows.find(x => x.agentId === id)?.decision;

test("old idle root archives in ready archive mode; young root does not", () => {
  const r = decidePass(input([facts("old", { updatedAt: iso(7 * DAY + MIN) }), facts("young", { updatedAt: iso(6 * DAY) })]));
  assert.equal(r.effectiveMode, "archive");
  assert.deepEqual(r.actions, ["old"]);
  assert.equal(decision(r, "young"), "skipped:root-young");
});

test("lastUserMessageAt newer than updatedAt keeps a root young", () => {
  const r = decidePass(input([facts("r", { updatedAt: iso(9 * DAY), lastUserMessageAt: iso(HOUR) })]));
  assert.equal(decision(r, "r"), "skipped:root-young");
});

test("unsafe states are each skipped with their reason", () => {
  const cases: [Partial<AgentFacts>, string][] = [
    [{ status: "running" }, "skipped:not-idle"], [{ status: "initializing" }, "skipped:not-idle"],
    [{ status: "closed" }, "skipped:not-idle"], [{ status: "error" }, "skipped:not-idle"],
    [{ activeTurn: true }, "skipped:active-turn"], [{ pendingPermissions: 1 }, "skipped:pending-permission"],
    [{ attentionPermission: true }, "skipped:pending-permission"], [{ providerUnavailable: true }, "skipped:provider-unavailable"],
    [{ asyncQuestions: 2 }, "skipped:async-question-pending"], [{ asyncQuestions: "unknown" }, "skipped:async-question-unknown"],
    [{ keep: true }, "skipped:keep"], [{ archived: true }, "skipped:archived"],
    [{ updatedAt: null }, "skipped:bad-timestamp"], [{ updatedAt: "garbage" }, "skipped:bad-timestamp"],
    [{ updatedAt: iso(-10 * MIN) }, "skipped:bad-timestamp"], [{ lastUserMessageAt: iso(-10 * MIN) }, "skipped:bad-timestamp"],
  ];
  for (const [over, want] of cases) {
    const r = decidePass(input([facts("a", over)]));
    assert.equal(decision(r, "a"), want, JSON.stringify(over));
    assert.deepEqual(r.actions, [], JSON.stringify(over));
  }
});

test("toFacts: keep label with any value, missing pendingPermissions fails closed, no text leaks", () => {
  const f = toFacts(snapshot("a", { labels: { "lab.archive-keep": "", "paseo.parent-agent-id": "p" }, pendingPermissions: undefined }) as never);
  assert.equal(f.keep, true);
  assert.equal(f.parentAgentId, "p");
  assert.notEqual(f.pendingPermissions, 0);
  assert.ok(!JSON.stringify(f).includes("SECRET"));
  assert.equal(toFacts(snapshot("b", { attentionReason: "permission" }) as never).attentionPermission, true);
});

test("countAsyncQuestions: state fields only, unknown shapes fail closed, never reads text", () => {
  assert.equal(countAsyncQuestions(undefined), 0);
  assert.equal(countAsyncQuestions({}), 0);
  assert.equal(countAsyncQuestions({ asyncQuestions: [{ status: "pending", text: "SECRET" }, { status: "answered" }, { resolved: true }] }), 1);
  assert.equal(countAsyncQuestions({ asyncQuestions: { q1: { resolvedAt: "2026-10-16" } } }), 0);
  assert.equal(countAsyncQuestions({ asyncQuestions: [{ text: "SECRET" }] }), "unknown");
  assert.equal(countAsyncQuestions({ asyncQuestions: "x" }), "unknown");
  assert.equal(countAsyncQuestions({ asyncQuestions: [null] }), "unknown");
  const r = decidePass(input([toFacts(snapshot("q", { persistence: { metadata: { asyncQuestions: [{ question: "SECRET-Q" }] } } }) as never)]));
  assert.equal(decision(r, "q"), "skipped:async-question-unknown");
  assert.ok(!JSON.stringify(r).includes("SECRET"));
});

const helper = (id: string, over: Partial<AgentFacts> = {}) => facts(id, { parentAgentId: "root", updatedAt: iso(HOUR), lastUserMessageAt: iso(2 * HOUR), ...over });
const parent = facts("root", { updatedAt: iso(HOUR) });
const rec = (h: AgentFacts, consumedAgo = 30 * MIN): ConsumptionRecord => ({ updatedAt: h.updatedAt!, lastUserMessageAt: h.lastUserMessageAt, consumedAt: NOW - consumedAgo });

test("helper consumption: unconsumed, exact match, stale after reuse or any updatedAt change, grace", () => {
  const h = helper("h");
  assert.equal(decision(decidePass(input([parent, h])), "h"), "skipped:unconsumed");
  const ok = decidePass(input([parent, h], { consumed: new Map([["h", rec(h)]]) }));
  assert.deepEqual(ok.actions, ["h"]);
  assert.equal(ok.rows.find(r => r.agentId === "h")?.outcomeIdentity, h.updatedAt);
  // reuse: new user message after the mark
  const reused = { ...h, lastUserMessageAt: iso(HOUR - 1) };
  assert.equal(decision(decidePass(input([parent, reused], { consumed: new Map([["h", rec(h)]]) })), "h"), "skipped:stale-consumption");
  // label write / provider turn moves updatedAt by one millisecond only: no slack allowed
  const bumped = { ...h, updatedAt: new Date(Date.parse(h.updatedAt!) + 1).toISOString() };
  assert.equal(decision(decidePass(input([parent, bumped], { consumed: new Map([["h", rec(h)]]) })), "h"), "skipped:stale-consumption");
  // lastUserMessageAt null vs recorded value is a difference too
  assert.equal(decision(decidePass(input([parent, { ...h, lastUserMessageAt: null }], { consumed: new Map([["h", rec(h)]]) })), "h"), "skipped:stale-consumption");
  // grace: consumed 5 minutes ago
  assert.equal(decision(decidePass(input([parent, h], { consumed: new Map([["h", rec(h, 5 * MIN)]]) })), "h"), "skipped:grace");
  // grace from last activity when that is more recent than consumedAt
  const fresh = helper("f", { updatedAt: iso(2 * MIN) });
  assert.equal(decision(decidePass(input([parent, fresh], { consumed: new Map([["f", rec(fresh, 60 * MIN)]]) })), "f"), "skipped:grace");
  // future consumedAt
  assert.equal(decision(decidePass(input([parent, h], { consumed: new Map([["h", rec(h, -10 * MIN)]]) })), "h"), "skipped:consumption-store-invalid");
});

test("invalid store blocks archive mode and helpers, roots still evaluate", () => {
  const r = decidePass(input([facts("old"), helper("h")], { consumed: null }));
  assert.equal(r.effectiveMode, "preview");
  assert.ok(r.blockers.includes("consumption-store-invalid"));
  assert.equal(decision(r, "h"), "skipped:consumption-store-invalid");
  assert.equal(decision(r, "old"), "preview");
  assert.deepEqual(r.actions, []);
});

test("descendants: live transitive descendant protects; fully archived subtree does not", () => {
  const root = facts("r");
  const mid = facts("m", { parentAgentId: "r", archived: true });
  const leaf = facts("l", { parentAgentId: "m", status: "running" });
  assert.equal(decision(decidePass(input([root, mid, leaf])), "r"), "skipped:live-descendant");
  const leafArchived = { ...leaf, archived: true };
  assert.deepEqual(decidePass(input([root, mid, leafArchived])).actions, ["r"]);
});

test("parent cycle blocks the pass", () => {
  const r = decidePass(input([facts("a", { parentAgentId: "b" }), facts("b", { parentAgentId: "a" }), facts("old")]));
  assert.ok(r.blockers.includes("parent-map-cycle"));
  assert.equal(r.effectiveMode, "preview");
  assert.deepEqual(r.actions, []);
});

test("schedules: scheduled agent skipped; failed enumeration blocks archive mode", () => {
  const sched = decidePass(input([facts("s"), facts("o")], { schedules: { complete: true, agentIds: new Set(["s"]) } }));
  assert.equal(decision(sched, "s"), "skipped:scheduled");
  assert.deepEqual(sched.actions, ["o"]);
  const failed = decidePass(input([facts("o")], { schedules: { complete: false, agentIds: new Set() } }));
  assert.ok(failed.blockers.includes("schedules-incomplete"));
  assert.deepEqual(failed.actions, []);
  assert.equal(decision(failed, "o"), "preview");
});

test("cap: oldest first, overflow skipped:cap, ties by id", () => {
  const agents = [facts("c", { updatedAt: iso(10 * DAY) }), facts("a", { updatedAt: iso(30 * DAY) }), facts("b", { updatedAt: iso(20 * DAY) }), facts("d", { updatedAt: iso(30 * DAY) })];
  const r = decidePass(input(agents, { config: readyConfig({ maxActionsPerPass: 2 }) }));
  assert.deepEqual(r.actions, ["a", "d"]);
  assert.equal(decision(r, "b"), "skipped:cap");
  assert.equal(decision(r, "c"), "skipped:cap");
});

test("each archive-mode blocker yields preview with zero actions, but rows are still computed", () => {
  const variants: [Partial<PassInput>, string][] = [
    [{ config: readyConfig({ paused: true }) }, "paused"], [{ sdkContext: false }, "no-sdk-context"],
    [{ inventoryComplete: false }, "inventory-incomplete"], [{ readiness: ["restore-unverified"] }, "restore-unverified"],
  ];
  for (const [over, blocker] of variants) {
    const r = decidePass(input([facts("old")], over));
    assert.ok(r.blockers.includes(blocker), blocker);
    assert.equal(r.effectiveMode, "preview");
    assert.deepEqual(r.actions, []);
    assert.equal(decision(r, "old"), "preview");
  }
  const preview = decidePass(input([facts("old")], { mode: "preview" }));
  assert.deepEqual(preview.actions, []);
});

test("readinessBlockers: wrong version, empty and malformed evidence never activate", () => {
  assert.deepEqual(readinessBlockers(readyConfig()), []);
  assert.deepEqual(readinessBlockers(config()), ["readiness-version-mismatch", "restore-unverified", "heartbeat-coverage-unverified", "outcome-identity-unverified"]);
  const base = readyConfig().readiness;
  assert.deepEqual(readinessBlockers(readyConfig({ readiness: { ...base, pluginVersion: "0.1.1" } })), ["readiness-version-mismatch"]);
  for (const bad of ["docker:2026-10-16:", "docker:2026-10-16:ab", "ok", "docker:16-10-2026:run1", " docker:2026-10-16:run1", "docker:2026-10-16:run 1"]) {
    assert.deepEqual(readinessBlockers(readyConfig({ readiness: { ...base, restoreEvidence: bad } })), ["restore-unverified"], bad);
  }
  assert.equal(PLUGIN_VERSION, "0.1.0");
});
