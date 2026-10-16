import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConsumptionStore, MAX_RECORDS } from "../server/store";
import { withFileLock } from "../server/lock";
import { ControlFile } from "../server/control";
import { tempDir } from "./helpers";

const rec = (n: number) => ({ updatedAt: `2026-10-16T00:00:0${n}.000Z`, lastUserMessageAt: null, consumedAt: n });

test("missing file -> empty map; corrupt / extra keys / oversized -> null", async () => {
  const dir = await tempDir();
  const store = new ConsumptionStore(dir);
  assert.deepEqual(await store.load(), new Map());
  await writeFile(store.path, "{not json");
  assert.equal(await store.load(), null);
  await writeFile(store.path, JSON.stringify({ version: 1, records: {}, extra: 1 }));
  assert.equal(await store.load(), null);
  await writeFile(store.path, JSON.stringify({ version: 1, records: { a: { ...rec(1), title: "x" } } }));
  assert.equal(await store.load(), null);
  const many: Record<string, unknown> = {};
  for (let i = 0; i <= MAX_RECORDS; i++) many[`a${i}`] = rec(1);
  await writeFile(store.path, JSON.stringify({ version: 1, records: many }));
  assert.equal(await store.load(), null);
});

test("update refuses to overwrite an invalid file and leaves it byte-identical", async () => {
  const dir = await tempDir();
  const store = new ConsumptionStore(dir);
  await writeFile(store.path, "garbage");
  await assert.rejects(store.update(r => { r.set("a", rec(1)); }));
  assert.equal(await readFile(store.path, "utf8"), "garbage");
});

test("update persists with mode 0600, dir 0700, and lock is released", async () => {
  const dir = join(await tempDir(), "nested");
  const store = new ConsumptionStore(dir);
  await store.update(r => { r.set("a", rec(1)); });
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  await assert.rejects(stat(`${store.path}.lock`));
  assert.deepEqual((await store.load())?.get("a"), rec(1));
});

test("concurrent updates across separate store instances (cross-process shape) all persist", async () => {
  const dir = await tempDir();
  const a = new ConsumptionStore(dir);
  const b = new ConsumptionStore(dir);
  await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).update(r => { r.set(`id${i}`, rec(i % 10)); })));
  assert.equal((await a.load())?.size, 8);
});

test("lock: second holder fails closed after bound; foreign lock never removed; own lock released on body error", async () => {
  const dir = await tempDir();
  const lock = join(dir, "x.lock");
  await writeFile(lock, "foreign-token");
  const started = Date.now();
  await assert.rejects(withFileLock(lock, async () => 1, { attempts: 3, delayMs: 10 }), /lock held/);
  assert.ok(Date.now() - started < 2000);
  assert.equal(await readFile(lock, "utf8"), "foreign-token");
  const own = join(dir, "own.lock");
  await assert.rejects(withFileLock(own, async () => { throw new Error("body"); }), /body/);
  await assert.rejects(stat(own));
  // a store whose lock is held by someone else refuses to write
  const store = new ConsumptionStore(dir);
  await writeFile(`${store.path}.lock`, "foreign");
  const { LOCK_LIMITS } = await import("../server/lock");
  const saved = { ...LOCK_LIMITS };
  LOCK_LIMITS.attempts = 2; LOCK_LIMITS.delayMs = 5;
  try { await assert.rejects(store.update(r => { r.set("a", rec(1)); }), /lock held/); }
  finally { Object.assign(LOCK_LIMITS, saved); }
  assert.deepEqual(await store.load(), new Map());
});

test("control file: missing = not paused, invalid = paused, pause/resume round trip", async () => {
  const dir = await tempDir();
  const c = new ControlFile(dir);
  assert.equal(await c.paused(), false);
  await c.setPaused(true, 0);
  assert.equal(await c.paused(), true);
  assert.equal((await stat(c.path)).mode & 0o777, 0o600);
  await c.setPaused(false, 0);
  assert.equal(await c.paused(), false);
  await writeFile(c.path, "{}");
  assert.equal(await c.paused(), true);
  await writeFile(c.path, "nope");
  assert.equal(await c.paused(), true);
});
