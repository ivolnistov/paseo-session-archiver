import { test } from "node:test";
import assert from "node:assert/strict";
import { listAllAgents, listScheduleTargets, type RunCli } from "../server/inventory";
import { fakePaseo, snapshot } from "./helpers";

test("pagination walks every page until hasMore:false, archived included", async () => {
  const calls: string[] = [];
  const list = Array.from({ length: 5 }, (_, i) => snapshot(`a${i}`, i === 0 ? { archivedAt: "2026-01-01T00:00:00Z" } : {}));
  const r = await listAllAgents(fakePaseo({ list, pageSize: 2, calls }), { pageSize: 2, maxPages: 10, maxSchedules: 10, cliTimeoutMs: 1, cliMaxBytes: 1 });
  assert.equal(r.complete, true);
  assert.equal(r.agents.length, 5);
  assert.deepEqual(calls, ["list:", "list:2", "list:4"]);
});

test("page bound reached -> incomplete; hasMore without cursor -> incomplete", async () => {
  const list = Array.from({ length: 5 }, (_, i) => snapshot(`a${i}`));
  const r = await listAllAgents(fakePaseo({ list, pageSize: 2, calls: [] }), { pageSize: 2, maxPages: 2, maxSchedules: 10, cliTimeoutMs: 1, cliMaxBytes: 1 });
  assert.equal(r.complete, false);
  const broken = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: true, nextCursor: null } }) } };
  assert.equal((await listAllAgents(broken as never)).complete, false);
});

const cli = (map: Record<string, string | Error>): RunCli => async args => {
  const v = map[args.join(" ")];
  if (v === undefined) throw new Error(`unexpected ${args.join(" ")}`);
  if (v instanceof Error) throw v;
  return v;
};

test("schedules: self/agent targets collected, new-agent ignored, complete", async () => {
  const r = await listScheduleTargets(cli({
    "schedule ls --json": JSON.stringify([{ id: "s1" }, { id: "s2" }, { id: "s3" }]),
    "schedule inspect s1 --json": JSON.stringify({ target: { type: "self", agentId: "A" } }),
    "schedule inspect s2 --json": JSON.stringify({ schedule: { target: { type: "agent", agentId: "B" } } }),
    "schedule inspect s3 --json": JSON.stringify({ target: { type: "new-agent", config: {} } }),
  }));
  assert.equal(r.complete, true);
  assert.deepEqual([...r.agentIds].sort(), ["A", "B"]);
});

test("schedules fail closed: malformed JSON, unknown target, missing agentId, timeout, too many", async () => {
  const cases: Record<string, string | Error>[] = [
    { "schedule ls --json": "not json" },
    { "schedule ls --json": JSON.stringify({ nope: [] }) },
    { "schedule ls --json": JSON.stringify([{ id: "s1" }]), "schedule inspect s1 --json": JSON.stringify({ target: { type: "webhook" } }) },
    { "schedule ls --json": JSON.stringify([{ id: "s1" }]), "schedule inspect s1 --json": JSON.stringify({ target: { type: "self" } }) },
    { "schedule ls --json": JSON.stringify([{ id: "s1" }]), "schedule inspect s1 --json": new Error("timeout") },
    { "schedule ls --json": new Error("ENOENT") },
  ];
  for (const c of cases) assert.equal((await listScheduleTargets(cli(c))).complete, false, JSON.stringify(Object.values(c).map(String)));
  const many = JSON.stringify(Array.from({ length: 3 }, (_, i) => ({ id: `s${i}` })));
  assert.equal((await listScheduleTargets(cli({ "schedule ls --json": many }), { pageSize: 1, maxPages: 1, maxSchedules: 2, cliTimeoutMs: 1, cliMaxBytes: 1 })).complete, false);
});

test("execCli runs without a shell: metacharacters are passed literally", async () => {
  const { execCli } = await import("../server/inventory");
  const { existsSync } = await import("node:fs");
  const out = await execCli("/bin/echo")(["a;touch /tmp/sa-shell-probe", "$(id)"]);
  assert.equal(out.trim(), "a;touch /tmp/sa-shell-probe $(id)");
  assert.equal(existsSync("/tmp/sa-shell-probe"), false);
});
