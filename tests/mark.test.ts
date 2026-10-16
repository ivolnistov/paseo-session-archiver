import { test } from "node:test";
import assert from "node:assert/strict";
import { markConsumed } from "../server/adapter";
import { ConsumptionStore } from "../server/store";
import { fakePaseo, iso, NOW, snapshot, tempDir, HOUR } from "./helpers";

const P = { "paseo.parent-agent-id": "root" };
const root = snapshot("root");
const helperSnap = (over: Record<string, unknown> = {}) => snapshot("h", { labels: P, updatedAt: iso(HOUR), lastUserMessageAt: iso(2 * HOUR), ...over });

test("mark-consumed stores the exact snapshot strings and makes no other API call", async () => {
  const store = new ConsumptionStore(await tempDir());
  const h = helperSnap();
  const calls: string[] = [];
  const r = await markConsumed(fakePaseo({ list: [root, h], calls }), store, "h", NOW);
  assert.deepEqual(r, { ok: true, updatedAt: h.updatedAt });
  assert.deepEqual((await store.load())?.get("h"), { updatedAt: h.updatedAt, lastUserMessageAt: h.lastUserMessageAt, consumedAt: NOW });
  assert.deepEqual(calls, ["list:", "refresh:h"]);
});

test("mark-consumed refusals write nothing", async () => {
  const cases: [Record<string, unknown>[], string, Record<string, Record<string, unknown> | null> | undefined, string][] = [
    [[root], "h", undefined, "not-found"],
    [[root, helperSnap({ archivedAt: iso(1) })], "h", undefined, "archived"],
    [[root], "root", undefined, "not-a-helper"],
    [[root, helperSnap({ status: "running" })], "h", undefined, "not-idle"],
    [[root, helperSnap({ activeTurn: { id: "t" } })], "h", undefined, "not-idle"],
    [[root, helperSnap({ pendingPermissions: [{}] })], "h", undefined, "pending-permission"],
    [[root, helperSnap({ attentionReason: "permission" })], "h", undefined, "pending-permission"],
    [[root, helperSnap({ persistence: { metadata: { asyncQuestions: [{ status: "pending" }] } } })], "h", undefined, "async-question"],
    [[root, helperSnap({ persistence: { metadata: { asyncQuestions: [{ text: "?" }] } } })], "h", undefined, "async-question"],
    [[root, helperSnap({ updatedAt: "bad" })], "h", undefined, "bad-timestamp"],
    [[root, helperSnap(), snapshot("c", { labels: { "paseo.parent-agent-id": "h" } })], "h", undefined, "live-descendant"],
    [[snapshot("a", { labels: { "paseo.parent-agent-id": "b" } }), snapshot("b", { labels: { "paseo.parent-agent-id": "a" } })], "a", undefined, "parent-map-cycle"],
    // fresh refresh disagrees with the list: became running between list and refresh
    [[root, helperSnap()], "h", { h: helperSnap({ status: "running" }) }, "not-idle"],
    [[root, helperSnap()], "h", { h: null }, "not-found"],
  ];
  for (const [list, id, refreshOverride, reason] of cases) {
    const store = new ConsumptionStore(await tempDir());
    const r = await markConsumed(fakePaseo({ list, calls: [], refreshOverride }), store, id, NOW);
    assert.deepEqual(r, { ok: false, reason }, reason);
    assert.deepEqual(await store.load(), new Map(), reason);
  }
});

test("mark-consumed refuses on incomplete inventory", async () => {
  const broken = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: true, nextCursor: null } }) } };
  const store = new ConsumptionStore(await tempDir());
  assert.deepEqual(await markConsumed(broken as never, store, "h", NOW), { ok: false, reason: "inventory-incomplete" });
});

test("mark-consumed does not move updatedAt (no label write): the mark matches the next pass", async () => {
  const { decidePass, toFacts } = await import("../server/engine");
  const { readyConfig } = await import("./helpers");
  const store = new ConsumptionStore(await tempDir());
  const h = helperSnap();
  await markConsumed(fakePaseo({ list: [root, h], calls: [] }), store, "h", NOW - HOUR);
  const r = decidePass({ agents: [toFacts(root as never), toFacts(h as never)], inventoryComplete: true, schedules: { complete: true, agentIds: new Set() }, consumed: await store.load(), config: readyConfig(), now: NOW, mode: "archive", sdkContext: true, readiness: [] });
  assert.ok(r.actions.includes("h"));
});
