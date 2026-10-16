import { randomUUID } from "node:crypto";
import type { PassSummary } from "../shared/rpc";
import { readinessBlockers, type ArchiverConfig } from "../shared/settings";
import { decidePass, evaluateAgent, liveDescendants, type AgentFacts, type ConsumptionRecord, type DecisionRow } from "./engine";
import type { JournalRow } from "./journal";

export interface SweepPorts {
  inventory(): Promise<{ agents: AgentFacts[]; complete: boolean }>;
  schedules(): Promise<{ complete: boolean; agentIds: ReadonlySet<string> }>;
  consumed(): Promise<ReadonlyMap<string, ConsumptionRecord> | null>;
  refresh(id: string): Promise<AgentFacts | null>;
  // Soft archive of exactly one agent. Never workspaces.archive, kill or delete.
  archive(id: string): Promise<void>;
  journal(rows: readonly JournalRow[]): Promise<void>;
  now(): number;
}

export interface SweepOutcome { summary: PassSummary; rows: DecisionRow[] }

export class Sweeper {
  private running = false;
  constructor(private readonly ports: SweepPorts) {}

  get busy(): boolean { return this.running; }

  // Returns null when another pass is in flight; passes never overlap.
  async run(config: ArchiverConfig, mode: "preview" | "archive", sdkContext: boolean): Promise<SweepOutcome | null> {
    if (this.running) return null;
    this.running = true;
    try { return await this.pass(config, mode, sdkContext); } finally { this.running = false; }
  }

  private async pass(config: ArchiverConfig, mode: "preview" | "archive", sdkContext: boolean): Promise<SweepOutcome> {
    const pass = randomUUID();
    const now = this.ports.now();
    const ts = new Date(now).toISOString();
    const diagnostics: JournalRow[] = [];
    let agents: AgentFacts[] = [];
    let inventoryComplete = false;
    let schedules: { complete: boolean; agentIds: ReadonlySet<string> } = { complete: false, agentIds: new Set() };
    let consumed: ReadonlyMap<string, ConsumptionRecord> | null = null;
    if (sdkContext) {
      try { ({ agents, complete: inventoryComplete } = await this.ports.inventory()); }
      catch { diagnostics.push({ ts, pass, event: "diagnostic", code: "inventory-failed" }); }
      schedules = await this.ports.schedules().catch(() => schedules);
      consumed = await this.ports.consumed().catch(() => null);
    }
    const readiness = readinessBlockers(config);
    const result = decidePass({ agents, inventoryComplete, schedules, consumed, config, now, mode, sdkContext, readiness });
    const rows = result.rows.map(r => ({ ...r }));
    let actions = result.actions;
    let blockers = result.blockers;
    let effectiveMode = result.effectiveMode;
    // The journal must be writable before any archive: a rejected append drops every action.
    if (actions.length > 0) {
      try { await this.ports.journal([{ ts, pass, event: "pass", mode: "archive", code: `planned=${actions.length}` }]); }
      catch {
        actions = [];
        blockers = [...blockers, "journal-unwritable"];
        effectiveMode = "preview";
        for (const r of rows) if (r.decision === "archive") r.decision = "preview";
      }
    }
    let archived = 0;
    let errors = 0;
    for (const id of actions) {
      const row = rows.find(r => r.agentId === id);
      if (!row) continue;
      try {
        const fresh = await this.ports.refresh(id);
        if (!fresh) { row.decision = "skipped:archived"; continue; }
        const live = liveDescendants(agents.map(a => a.id === id ? fresh : a));
        const again = live && evaluateAgent(fresh, { live, scheduled: schedules.agentIds, consumed, config, now: this.ports.now() });
        if (!again || again.decision !== "preview") { row.decision = again ? again.decision : "skipped:live-descendant"; continue; }
        // Residual race: state can change between this refresh and archive (no conditional archive).
        await this.ports.archive(id);
        archived++;
      } catch {
        row.decision = "error";
        errors++;
        diagnostics.push({ ts, pass, event: "diagnostic", agentId: id, code: "archive-error" });
      }
    }
    const decisions: Record<string, number> = {};
    for (const r of rows) decisions[r.decision] = (decisions[r.decision] ?? 0) + 1;
    const summary: PassSummary = { pass, at: ts, requestedMode: mode, effectiveMode, blockers, decisions, archived, errors };
    const journalRows: JournalRow[] = [
      ...rows.filter(r => r.decision !== "skipped:archived").map(r => ({
        ts, pass, event: "decision" as const, agentId: r.agentId, workspaceId: r.workspaceId, parentAgentId: r.parentAgentId,
        status: r.status, ageHours: r.ageHours, decision: r.decision === "archive" ? "archived" : r.decision,
        consumption: r.consumption, outcomeIdentity: r.outcomeIdentity,
      })),
      ...diagnostics,
      { ts, pass, event: "pass", mode: effectiveMode, blockers, code: `archived=${archived};errors=${errors}` },
    ];
    // A failed final append after archiving is surfaced to the caller; actions already happened.
    await this.ports.journal(journalRows);
    return { summary, rows };
  }
}
