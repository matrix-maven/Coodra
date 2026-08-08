import type { RunWithEverything } from '@coodra/db';

/**
 * `lib/export/render-json` — pure renderer for
 * `coodra export <runId> --format json`. Per OQ-7 lock the JSON
 * format ALWAYS includes the audit trail — machine-readable consumers
 * (CI exports, future SOC2 review tooling) need full fidelity. There
 * is no `--include-audit` toggle for JSON.
 */

export function renderJson(data: RunWithEverything): string {
  const payload = {
    run: {
      id: data.run.id,
      projectId: data.run.projectId,
      sessionId: data.run.sessionId,
      agentType: data.run.agentType,
      mode: data.run.mode,
      status: data.run.status,
      issueRef: data.run.issueRef,
      prRef: data.run.prRef,
      startedAt: data.run.startedAt.toISOString(),
      endedAt: data.run.endedAt?.toISOString() ?? null,
    },
    // Array (2026-08-08 — was a single `contextPack: X | null`; a run can
    // accumulate several packs across distinct pieces of work).
    contextPacks: data.contextPacks.map((cp) => ({
      id: cp.id,
      title: cp.title,
      contentExcerpt: cp.contentExcerpt,
      createdAt: cp.createdAt.toISOString(),
    })),
    events: data.events.map((e) => ({
      id: e.id,
      phase: e.phase,
      toolName: e.toolName,
      toolUseId: e.toolUseId,
      toolInput: e.toolInput,
      outcome: e.outcome,
      createdAt: e.createdAt.toISOString(),
    })),
    decisions: data.decisions.map((d) => ({
      id: d.id,
      idempotencyKey: d.idempotencyKey,
      description: d.description,
      rationale: d.rationale,
      alternatives: d.alternatives,
      createdAt: d.createdAt.toISOString(),
    })),
    policyDecisions: data.policyDecisions.map((p) => ({
      id: p.id,
      idempotencyKey: p.idempotencyKey,
      sessionId: p.sessionId,
      agentType: p.agentType,
      eventType: p.eventType,
      toolName: p.toolName,
      permissionDecision: p.permissionDecision,
      matchedRuleId: p.matchedRuleId,
      reason: p.reason,
      createdAt: p.createdAt.toISOString(),
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
