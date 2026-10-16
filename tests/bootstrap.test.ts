import { test } from "node:test";
import assert from "node:assert/strict";
import { bootstrapStandalone, validateLoopbackUrl, type Connector } from "../server/bootstrap";

test("validateLoopbackUrl table", () => {
  const table: [string, string | null][] = [
    ["ws://127.0.0.1:6767/ws", null], ["ws://localhost:6767/ws", null], ["ws://[::1]:6767/ws", null],
    ["wss://127.0.0.1:6767/ws", "not-ws"], ["http://127.0.0.1/ws", "not-ws"], ["ws://10.0.0.1:6767/ws", "not-loopback"],
    ["ws://127.0.0.1.evil.com/ws", "not-loopback"], ["ws://u:p@127.0.0.1:6767/ws", "credentials-in-url"],
    ["ws://127.0.0.1:6767/", "path-not-ws"], ["ws://127.0.0.1:6767/ws/x", "path-not-ws"], ["nope", "invalid-url"],
  ];
  for (const [url, want] of table) assert.equal(validateLoopbackUrl(url), want, url);
});

const opts = (over: Partial<Parameters<typeof bootstrapStandalone>[0]> = {}) => {
  const states: string[] = [];
  return { states, o: { url: "ws://127.0.0.1:6767/ws", passwordEnv: "", isCancelled: () => false, onState: (s: string) => { states.push(s); }, ...over } };
};

test("bounded attempts with sleep between, then failed:connect-exhausted", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const connector: Connector = async () => { calls++; throw new Error("ECONNREFUSED"); };
  const { o, states } = opts();
  const r = await bootstrapStandalone(o, connector, { attempts: 3, delayMs: 7, connectTimeoutMs: 1 }, async ms => { sleeps.push(ms); });
  assert.equal(r, null);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [7, 7]);
  assert.equal(states.at(-1), "failed:connect-exhausted");
});

test("missing client dependency stops immediately", async () => {
  let calls = 0;
  const { o, states } = opts();
  await bootstrapStandalone(o, async () => { calls++; throw new Error("Cannot find package '@getpaseo/client'"); }, { attempts: 5, delayMs: 1, connectTimeoutMs: 1 }, async () => {});
  assert.equal(calls, 1);
  assert.equal(states.at(-1), "failed:client-dependency-missing");
});

test("password env named but empty -> failure without connecting; set -> passed through, not logged", async () => {
  let calls = 0;
  const a = opts({ passwordEnv: "SA_TEST_PW_EMPTY" });
  delete process.env.SA_TEST_PW_EMPTY;
  assert.equal(await bootstrapStandalone(a.o, async () => { calls++; throw new Error("x"); }), null);
  assert.equal(calls, 0);
  assert.equal(a.states.at(-1), "failed:password-env-empty");
  process.env.SA_TEST_PW = "pw-SECRET";
  const b = opts({ passwordEnv: "SA_TEST_PW" });
  let seen: string | undefined;
  const conn = await bootstrapStandalone(b.o, async ({ password }) => { seen = password; return { api: {} as never, close: async () => {} }; });
  assert.ok(conn);
  assert.equal(seen, "pw-SECRET");
  assert.ok(!b.states.join().includes("SECRET"));
  delete process.env.SA_TEST_PW;
});

test("invalid URL refused without connecting", async () => {
  let calls = 0;
  const { o, states } = opts({ url: "ws://192.168.1.2:6767/ws" });
  assert.equal(await bootstrapStandalone(o, async () => { calls++; throw new Error(); }), null);
  assert.equal(calls, 0);
  assert.equal(states.at(-1), "failed:not-loopback");
});

test("cancellation during connect closes the late connection", async () => {
  let cancelled = false;
  let closed = 0;
  const { o } = opts({ isCancelled: () => cancelled });
  const r = await bootstrapStandalone(o, async () => { cancelled = true; return { api: {} as never, close: async () => { closed++; } }; });
  assert.equal(r, null);
  assert.equal(closed, 1);
});
