import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// Allowlisted fields only: no titles, prompts, question text, credentials or other label values.
export interface JournalRow {
  ts: string;
  pass: string;
  event: "decision" | "pass" | "diagnostic" | "consumed";
  agentId?: string;
  workspaceId?: string | null;
  parentAgentId?: string | null;
  status?: string;
  ageHours?: number | null;
  decision?: string;
  consumption?: "present" | "absent";
  outcomeIdentity?: string | null;
  mode?: string;
  blockers?: string[];
  code?: string;
}

const KEYS: readonly (keyof JournalRow)[] = ["ts", "pass", "event", "agentId", "workspaceId", "parentAgentId", "status", "ageHours", "decision", "consumption", "outcomeIdentity", "mode", "blockers", "code"];

export function sanitize(row: JournalRow): JournalRow {
  const out: Record<string, unknown> = {};
  for (const key of KEYS) if (row[key] !== undefined) out[key] = row[key];
  return out as unknown as JournalRow;
}

export class Journal {
  private ready: Promise<void> | undefined;
  constructor(readonly path: string) {}

  async append(rows: readonly JournalRow[]): Promise<void> {
    if (rows.length === 0) return;
    this.ready ??= mkdir(dirname(this.path), { recursive: true, mode: 0o700 }).then(() => undefined);
    await this.ready;
    await appendFile(this.path, rows.map(r => JSON.stringify(sanitize(r))).join("\n") + "\n", { mode: 0o600 });
    await chmod(this.path, 0o600);
  }
}
