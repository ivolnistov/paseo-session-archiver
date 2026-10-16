import { randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";

export const LOCK_LIMITS = { attempts: 40, delayMs: 50 };

// Cross-process exclusive lock by O_EXCL create. Bounded wait, then fail closed. Only a lock whose
// token this process wrote is ever removed; an unknown or stale lock is left for the operator.
export async function withFileLock<T>(lockPath: string, body: () => Promise<T>, limits = LOCK_LIMITS): Promise<T> {
  const token = `${process.pid}.${randomUUID()}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try { await handle.writeFile(token); } finally { await handle.close(); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("lock unavailable");
      if (attempt + 1 >= limits.attempts) throw new Error(`lock held: ${lockPath}`);
      await new Promise(resolve => setTimeout(resolve, limits.delayMs));
    }
  }
  try { return await body(); }
  finally {
    const current = await readFile(lockPath, "utf8").catch(() => null);
    if (current === token) await unlink(lockPath).catch(() => undefined);
  }
}
