import { test } from "node:test";
import assert from "node:assert/strict";
import { Sweeper, type SweepPorts } from "../server/sweeper";
import type { AgentFacts } from "../server/engine";
import type { JournalRow } from "../server/journal";
import { sanitize } from "../server/journal";
import { config, DAY, facts, iso, NOW, readyConfig } from "./helpers";

function ports(agents: AgentFacts[], over: Partial<SweepPorts> = {}) {
  const calls: string[] = [];
  const journal: JournalRow[][] = [];
  const p: SweepPorts = {
    inventory: async () => ({ agents, complete: true }),
    schedules: async () => ({ complete: true, agentIds: new Set() }),
    consumed: async () => new Map(),
    refresh: async id => { calls.push(`refresh:${id}`); return agents.find(a => a.id === id) ?? null; },
    archive: async id => { calls.push(`archive:${id}`); },
    journal: async rows => { journal.push([...rows]); },
    now: () => NOW,
    ...over,
  };
  return { p, calls, journal };
}

test("ready archive pass archives eligible agents after a fresh refresh and journals it", async () => {
  const { p, calls, journal } = ports([facts("a"), facts("b", { updatedAt: iso(DAY) })]);
  const out = await new Sweeper(p).run(readyConfig(), "archive", true);
  assert.equal(out?.summary.archived, 1);
  assert.deepEqual(calls, ["refresh:a", "archive:a"]);
  assert.equal(journal[0]?.[0]?.event, "pass"); // planned row before any archive
  const last = journal.at(-1)!;
  assert.ok(last.some(r => r.agentId === "a" && r.decision === "archived"));
});

test("refresh-before-archive drops an agent that became running, kept, or gone", async () => {
  for (const fresh of [facts("a", { status: "running" }), facts("a", { keep: true }), null]) {
    const { p, calls } = ports([facts("a")], { refresh: async () => fresh });
    const out = await new Sweeper(p).run(readyConfig(), "archive", true);
    assert.equal(out?.summary.archived, 0);
    assert.ok(!calls.some(c => c.startsWith("archive")));
  }
});

test("archive error is journaled once and not retried; other actions continue", async () => {
  let attempts = 0;
  const { p, journal } = ports([facts("a", { updatedAt: iso(30 * DAY) }), facts("b")], { archive: async id => { if (id === "a") { attempts++; throw new Error("boom"); } } });
  const out = await new Sweeper(p).run(readyConfig(), "archive", true);
  assert.equal(attempts, 1);
  assert.equal(out?.summary.errors, 1);
  assert.equal(out?.summary.archived, 1);
  assert.ok(journal.at(-1)!.some(r => r.event === "diagnostic" && r.code === "archive-error" && r.agentId === "a"));
});

test("passes never overlap", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const { p } = ports([facts("a")], { inventory: async () => { await gate; return { agents: [], complete: true }; } });
  const s = new Sweeper(p);
  const first = s.run(config(), "preview", true);
  assert.equal(s.busy, true);
  assert.equal(await s.run(config(), "preview", true), null);
  release();
  assert.notEqual(await first, null);
  assert.equal(s.busy, false);
});

test("rejecting journal before actions -> zero archive calls, journal-unwritable, readiness unchanged", async () => {
  let n = 0;
  const cfg = readyConfig();
  const before = JSON.stringify(cfg);
  const { p, calls } = ports([facts("a")], { journal: async () => { if (n++ === 0) throw new Error("EROFS"); } });
  const out = await new Sweeper(p).run(cfg, "archive", true);
  assert.deepEqual(calls, []);
  assert.ok(out?.summary.blockers.includes("journal-unwritable"));
  assert.equal(out?.summary.effectiveMode, "preview");
  assert.equal(JSON.stringify(cfg), before);
});

test("cap respected end to end; paused config archives nothing", async () => {
  const agents = Array.from({ length: 8 }, (_, i) => facts(`a${i}`, { updatedAt: iso((10 + i) * DAY) }));
  const { p, calls } = ports(agents);
  await new Sweeper(p).run(readyConfig({ maxActionsPerPass: 3 }), "archive", true);
  assert.deepEqual(calls.filter(c => c.startsWith("archive")), ["archive:a7", "archive:a6", "archive:a5"]);
  const paused = ports(agents);
  const out = await new Sweeper(paused.p).run(readyConfig({ paused: true }), "archive", true);
  assert.deepEqual(paused.calls, []);
  assert.ok(out?.summary.blockers.includes("paused"));
});

test("inventory/schedule/store port failures fail closed", async () => {
  const { p, calls } = ports([facts("a")], { inventory: async () => { throw new Error("x"); }, schedules: async () => { throw new Error("y"); }, consumed: async () => { throw new Error("z"); } });
  const out = await new Sweeper(p).run(readyConfig(), "archive", true);
  assert.deepEqual(calls, []);
  for (const b of ["inventory-incomplete", "schedules-incomplete", "consumption-store-invalid"]) assert.ok(out?.summary.blockers.includes(b), b);
});

test("no sdk context: ports are not touched", async () => {
  const touched: string[] = [];
  const { p } = ports([], { inventory: async () => { touched.push("inv"); return { agents: [], complete: true }; } });
  const out = await new Sweeper(p).run(readyConfig(), "archive", false);
  assert.deepEqual(touched, []);
  assert.ok(out?.summary.blockers.includes("no-sdk-context"));
});

test("journal sanitize keeps only allowlisted keys", () => {
  const row = sanitize({ ts: "t", pass: "p", event: "decision", agentId: "a", title: "SECRET", prompt: "SECRET", labels: { x: "SECRET" } } as unknown as JournalRow);
  assert.deepEqual(Object.keys(row).sort(), ["agentId", "event", "pass", "ts"]);
});

test("journal file rows contain no titles or label values", async () => {
  const { Journal } = await import("../server/journal");
  const { tempDir } = await import("./helpers");
  const { readFile, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const j = new Journal(join(await tempDir(), "d", "journal.jsonl"));
  await j.append([{ ts: "t", pass: "p", event: "pass", title: "SECRET" } as unknown as JournalRow]);
  assert.ok(!(await readFile(j.path, "utf8")).includes("SECRET"));
  assert.equal((await stat(j.path)).mode & 0o777, 0o600);
});
