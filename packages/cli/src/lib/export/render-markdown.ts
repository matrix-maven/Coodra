import type { RunWithEverything } from '@coodra/contextos-db';

/**
 * `lib/export/render-markdown` — pure renderer for `contextos export
 * <runId> --format markdown`. No I/O. Output is a single string.
 *
 * Per OQ-7 lock (2026-05-03), the audit trail (policy_decisions) is
 * excluded by default for narrative readability; `--include-audit`
 * appends a "Policy decisions" section. The decisions table
 * (record_decision body) is always included — it's the agent's
 * narrative of what it chose and why, which is the point of an
 * exported run.
 */

export interface RenderMarkdownOptions {
  readonly includeAudit: boolean;
}

export function renderMarkdown(data: RunWithEverything, options: RenderMarkdownOptions): string {
  const { run, events, decisions, policyDecisions, contextPack } = data;
  const lines: string[] = [];

  lines.push(`# Run \`${run.id}\``);
  lines.push('');
  lines.push(`- **Project:** \`${run.projectId}\``);
  lines.push(`- **Session:** \`${run.sessionId}\``);
  lines.push(`- **Agent:** ${run.agentType} (mode: ${run.mode})`);
  lines.push(`- **Status:** ${run.status}`);
  lines.push(`- **Started:** ${run.startedAt.toISOString()}`);
  lines.push(`- **Ended:**   ${run.endedAt?.toISOString() ?? '_(in progress)_'}`);
  if (run.issueRef !== null) lines.push(`- **Issue:** \`${run.issueRef}\``);
  if (run.prRef !== null) lines.push(`- **PR:** \`${run.prRef}\``);
  lines.push('');

  // Context Pack first — it's the headline narrative for the run.
  if (contextPack !== null) {
    lines.push('## Context Pack');
    lines.push('');
    lines.push(`**${contextPack.title}**`);
    lines.push('');
    lines.push(contextPack.contentExcerpt);
    lines.push('');
    lines.push(
      `<sub>Saved at ${contextPack.createdAt.toISOString()} (excerpt — full content in DB row \`${contextPack.id}\`)</sub>`,
    );
    lines.push('');
  }

  // Decisions (record_decision) — narrative of what was decided.
  lines.push(`## Decisions (${decisions.length})`);
  lines.push('');
  if (decisions.length === 0) {
    lines.push('_No decisions recorded for this run._');
  } else {
    for (const d of decisions) {
      lines.push(`### ${d.description}`);
      lines.push('');
      lines.push(`**Rationale:** ${d.rationale}`);
      if (d.alternatives !== null && d.alternatives.length > 0) {
        try {
          const parsed = JSON.parse(d.alternatives) as unknown;
          if (Array.isArray(parsed) && parsed.length > 0) {
            lines.push('');
            lines.push('**Alternatives considered:**');
            for (const a of parsed) {
              lines.push(`- ${String(a)}`);
            }
          }
        } catch {
          lines.push('');
          lines.push(`**Alternatives:** ${d.alternatives}`);
        }
      }
      lines.push('');
      lines.push(`<sub>Recorded at ${d.createdAt.toISOString()}</sub>`);
      lines.push('');
    }
  }

  // Events timeline — what tools the agent used.
  lines.push(`## Tool-use timeline (${events.length})`);
  lines.push('');
  if (events.length === 0) {
    lines.push('_No tool-use events recorded._');
  } else {
    lines.push('| Time | Phase | Tool | Tool-use id |');
    lines.push('|---|---|---|---|');
    for (const e of events) {
      lines.push(`| ${e.createdAt.toISOString()} | ${e.phase} | \`${e.toolName}\` | \`${e.toolUseId}\` |`);
    }
  }
  lines.push('');

  // Audit (policy_decisions) — opt-in for narrative formats.
  if (options.includeAudit) {
    lines.push(`## Policy decisions (${policyDecisions.length})`);
    lines.push('');
    if (policyDecisions.length === 0) {
      lines.push('_No policy decisions recorded for this run._');
    } else {
      lines.push('| Time | Decision | Tool | Reason |');
      lines.push('|---|---|---|---|');
      for (const p of policyDecisions) {
        lines.push(
          `| ${p.createdAt.toISOString()} | ${p.permissionDecision} | \`${p.toolName}\` | ${p.reason.replaceAll('|', '\\|')} |`,
        );
      }
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
