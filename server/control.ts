import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { withFileLock } from "./lock";

// Operator pause written by the admin CLI, alongside the settings `paused` flag. A missing file
// means not paused; an unreadable or invalid file means paused (fail closed).
const controlSchema = z.object({ version: z.literal(1), paused: z.boolean(), changedAt: z.string().max(64) }).strict();

export class ControlFile {
  readonly path: string;
  constructor(dir: string) { this.path = join(dir, "control.json"); }

  async paused(): Promise<boolean> {
    let text: string;
    try { text = await readFile(this.path, "utf8"); }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
    try { const parsed = controlSchema.safeParse(JSON.parse(text)); return !parsed.success || parsed.data.paused; }
    catch { return true; }
  }

  async setPaused(paused: boolean, now: number): Promise<void> {
    const dir = join(this.path, "..");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await withFileLock(`${this.path}.lock`, async () => {
      const tmp = join(dir, `.control.${randomUUID()}.tmp`);
      await writeFile(tmp, JSON.stringify({ version: 1, paused, changedAt: new Date(now).toISOString() }) + "\n", { mode: 0o600, flag: "wx" });
      await rename(tmp, this.path);
    });
  }
}
