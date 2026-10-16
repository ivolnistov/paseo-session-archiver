import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import contribute from "../index.server";
import { statusRpc } from "../shared/rpc";
import type { Connector } from "../server/bootstrap";
import { fakePaseo, tempDir } from "./helpers";

type Handler = (input: unknown, ctx: { paseo: unknown }) => Promise<unknown>;

async function setup(connector: Connector) {
  const dir = await tempDir();
  const handlers = new Map<string, Handler>();
  const hooks = new Map<string, (e: unknown, ctx: { paseo: unknown }) => void>();
  const server = {
    registerSettings: () => ({ read: async () => ({ status: "ready", values: { dataDir: dir } }), subscribe: () => () => {} }),
    handle: (def: { name: string }, fn: Handler) => { handlers.set(def.name, fn); return () => {}; },
    on: (name: string, fn: (e: unknown, ctx: { paseo: unknown }) => void) => { hooks.set(name, fn); return () => {}; },
  };
  const info = console.info;
  console.info = () => {};
  const cleanup = contribute(server as never, connector);
  console.info = info;
  return { dir, handlers, hooks, cleanup };
}

const settle = () => new Promise(r => setTimeout(r, 30));

test("standalone bootstrap captures context and journals bootstrap:standalone; an RPC context then replaces it", async () => {
  let closed = 0;
  const api = fakePaseo({ list: [], calls: [] });
  const { dir, handlers, cleanup } = await setup(async () => ({ api, close: async () => { closed++; } }));
  const info = console.info; console.info = () => {};
  try {
    await settle();
    const journal = await readFile(join(dir, "journal.jsonl"), "utf8");
    assert.match(journal, /"code":"bootstrap:standalone"/);
    assert.equal(closed, 0);
    const status = await handlers.get(statusRpc.name)!({}, { paseo: api }) as { bootstrapSource: string; standalone: string };
    assert.equal(status.bootstrapSource, "rpc");
    assert.equal(status.standalone, "ready");
    await settle();
    assert.equal(closed, 1);
  } finally { await cleanup(); console.info = info; }
});

test("cleanup closes a live standalone connection", async () => {
  let closed = 0;
  const { cleanup } = await setup(async () => ({ api: fakePaseo({ list: [], calls: [] }), close: async () => { closed++; } }));
  await settle();
  const info = console.info; console.info = () => {};
  await cleanup();
  console.info = info;
  assert.equal(closed, 1);
});

test("hook context replaces standalone connection, which is closed", async () => {
  let closed = 0;
  const api = fakePaseo({ list: [], calls: [] });
  const { hooks, handlers, cleanup } = await setup(async () => ({ api, close: async () => { closed++; } }));
  await settle();
  const info = console.info; console.info = () => {};
  hooks.get("agent.turn_ended")!({}, { paseo: fakePaseo({ list: [], calls: [] }) });
  await settle();
  const status = await handlers.get(statusRpc.name)!({}, { paseo: api }) as { bootstrapSource: string };
  await cleanup();
  console.info = info;
  assert.equal(status.bootstrapSource, "hook");
  assert.equal(closed, 1);
});

test("failed standalone bootstrap is visible in status and never claims readiness", async () => {
  const { handlers, cleanup } = await setup(async () => { throw new Error("Cannot find module '@getpaseo/client'"); });
  await settle();
  // the status RPC itself provides a context, so read bootstrap diagnostics from that first call
  const status = await handlers.get(statusRpc.name)!({}, { paseo: fakePaseo({ list: [], calls: [] }) }) as { standalone: string; diagnostics: string[] };
  const info = console.info; console.info = () => {};
  await cleanup();
  console.info = info;
  assert.equal(status.standalone, "failed:client-dependency-missing");
  assert.ok(status.diagnostics.includes("standalone-failed:client-dependency-missing"));
  assert.ok(status.diagnostics.some(d => d.startsWith("archive-blocked")) === false); // default mode preview
});
