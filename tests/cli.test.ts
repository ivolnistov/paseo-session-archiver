import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { main, parseArgs } from "../admin/cli";
import { tempDir } from "./helpers";

test("parseArgs accepts valid forms", () => {
  assert.deepEqual(parseArgs(["--url", "ws://127.0.0.1:6767/ws", "--data-dir", "/d", "mark-consumed", "A"]), { url: "ws://127.0.0.1:6767/ws", dataDir: "/d", passwordEnv: null, paseoCli: "paseo", command: "mark-consumed", agentId: "A" });
  assert.equal(parseArgs(["--data-dir", "/d", "status"]).command, "status");
});

test("parseArgs rejects invalid input", () => {
  const bad: string[][] = [
    ["--data-dir", "rel/dir", "status"], ["status"], ["--data-dir", "/d", "--bogus", "x", "status"],
    ["--data-dir", "/d", "frobnicate"], ["--data-dir", "/d"], ["--data-dir", "/d", "status", "extra"],
    ["--data-dir", "/d", "mark-consumed"], ["--url", "ws://x/ws", "--data-dir", "/d", "mark-consumed", "A", "B"],
    ["--data-dir", "/d", "preview", "A"], ["--data-dir", "/d", "mark-consumed", "A"], ["--data-dir", "/d", "preview"],
    ["--url", "http://127.0.0.1/ws", "--data-dir", "/d", "preview"], ["--data-dir"],
  ];
  for (const argv of bad) assert.throws(() => parseArgs(argv), Error, argv.join(" "));
});

test("pause/resume/status touch only the given data dir and need no daemon", async () => {
  const dir = await tempDir();
  const log = console.log;
  const out: string[] = [];
  console.log = (s: string) => { out.push(s); };
  try {
    assert.equal(await main(["--data-dir", dir, "pause"]), 0);
    assert.equal(await main(["--data-dir", dir, "status"]), 0);
    assert.equal(await main(["--data-dir", dir, "resume"]), 0);
  } finally { console.log = log; }
  assert.deepEqual(JSON.parse(out[0]!), { paused: true });
  const status = JSON.parse(out[1]!);
  assert.equal(status.paused, true);
  assert.deepEqual(status.store, { valid: true, records: 0 });
  assert.deepEqual(JSON.parse(out[2]!), { paused: false });
  assert.deepEqual((await readdir(dir)).sort(), ["control.json"]);
});
