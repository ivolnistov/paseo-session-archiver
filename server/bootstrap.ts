import type { PaseoApi } from "@getpaseo/client";

export interface StandaloneConnection { api: PaseoApi; close(): Promise<void> }
// Injectable for tests; production uses the public createPaseoClient.
export type Connector = (options: { url: string; password?: string; connectTimeoutMs: number }) => Promise<StandaloneConnection>;

export const BOOTSTRAP_LIMITS = { attempts: 6, delayMs: 30_000, connectTimeoutMs: 10_000 };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

// Only an explicit loopback ws:// daemon endpoint is accepted; anything else is refused.
export function validateLoopbackUrl(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "invalid-url"; }
  if (parsed.protocol !== "ws:") return "not-ws";
  if (!LOOPBACK.has(parsed.hostname)) return "not-loopback";
  if (parsed.username || parsed.password) return "credentials-in-url";
  if (parsed.pathname !== "/ws") return "path-not-ws";
  return null;
}

export const publicConnector: Connector = async ({ url, password, connectTimeoutMs }) => {
  // Loaded lazily so the plugin still loads (and reports readiness) if the runtime dependency is absent.
  const { createPaseoClient } = await import("@getpaseo/client");
  const client = createPaseoClient({ url, clientId: "session-archiver-plugin", connectTimeoutMs, reconnect: { enabled: true }, ...(password ? { password } : {}) });
  try { await client.connect(); } catch (error) { await client.close().catch(() => undefined); throw error; }
  return { api: client, close: () => client.close() };
};

export type BootstrapState = "disabled" | "connecting" | "ready" | `failed:${string}`;

// Bounded attempts; resolves with a connection or a failure code. Never logs the password.
export async function bootstrapStandalone(
  options: { url: string; passwordEnv: string; isCancelled(): boolean; onState(state: BootstrapState): void },
  connector: Connector = publicConnector, limits = BOOTSTRAP_LIMITS, sleep = (ms: number) => new Promise(r => setTimeout(r, ms)),
): Promise<StandaloneConnection | null> {
  const invalid = validateLoopbackUrl(options.url);
  if (invalid) { options.onState(`failed:${invalid}`); return null; }
  let password: string | undefined;
  if (options.passwordEnv) {
    password = process.env[options.passwordEnv];
    if (!password) { options.onState("failed:password-env-empty"); return null; }
  }
  for (let attempt = 1; attempt <= limits.attempts; attempt++) {
    if (options.isCancelled()) return null;
    options.onState("connecting");
    try {
      const connection = await connector({ url: options.url, connectTimeoutMs: limits.connectTimeoutMs, ...(password ? { password } : {}) });
      if (options.isCancelled()) { await connection.close().catch(() => undefined); return null; }
      return connection;
    } catch (error) {
      const missing = error instanceof Error && /Cannot find (module|package)/.test(error.message);
      if (missing) { options.onState("failed:client-dependency-missing"); return null; }
      if (attempt === limits.attempts) { options.onState("failed:connect-exhausted"); return null; }
      await sleep(limits.delayMs);
    }
  }
  return null;
}
