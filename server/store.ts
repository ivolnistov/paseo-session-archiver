import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ConsumptionRecord } from "./engine";
import { withFileLock } from "./lock";

export const MAX_RECORDS = 5000;

export function defaultDataDir(): string {
  return join(homedir(), ".paseo", "session-archiver");
}

const recordSchema = z.object({
  updatedAt: z.string().min(1).max(64),
  lastUserMessageAt: z.string().min(1).max(64).nullable(),
  consumedAt: z.number().int().nonnegative(),
}).strict();
const fileSchema = z.object({ version: z.literal(1), records: z.record(z.string().min(1).max(128), recordSchema) }).strict();

// Plugin-private consumption store. Written only by mark-consumed; never by label writes.
// Reads fail closed: an unreadable or invalid file yields null, which blocks every helper.
export class ConsumptionStore {
  private queue: Promise<unknown> = Promise.resolve();
  readonly path: string;
  constructor(dir: string) { this.path = join(dir, "consumed.json"); }

  async load(): Promise<Map<string, ConsumptionRecord> | null> {
    let text: string;
    try { text = await readFile(this.path, "utf8"); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? new Map() : null; }
    try {
      const parsed = fileSchema.safeParse(JSON.parse(text));
      if (!parsed.success || Object.keys(parsed.data.records).length > MAX_RECORDS) return null;
      return new Map(Object.entries(parsed.data.records));
    } catch { return null; }
  }

  // Read-modify-write under a cross-process lock (plugin and admin CLI), fresh read inside the lock,
  // atomic rename. Refuses to overwrite an invalid store; a held lock fails closed after a bounded wait.
  update(change: (records: Map<string, ConsumptionRecord>) => void): Promise<void> {
    const run = this.queue.then(async () => {
      const dir = join(this.path, "..");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await withFileLock(`${this.path}.lock`, async () => {
        const records = await this.load();
        if (!records) throw new Error("consumption store invalid");
        change(records);
        if (records.size > MAX_RECORDS) throw new Error("consumption store full");
        const tmp = join(dir, `.consumed.${randomUUID()}.tmp`);
        await writeFile(tmp, JSON.stringify({ version: 1, records: Object.fromEntries(records) }) + "\n", { mode: 0o600, flag: "wx" });
        await rename(tmp, this.path);
      });
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
