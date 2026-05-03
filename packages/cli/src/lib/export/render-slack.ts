import type { RunWithEverything } from '@coodra/contextos-db';

/**
 * `lib/export/render-slack` — pure renderer for `contextos export
 * <runId> --format slack`. Slack mrkdwn (a truncated subset of
 * markdown — different syntax for bold, italics, code blocks).
 *
 * Per Slack mrkdwn:
 *   - bold: `*text*` (NOT `**text**`)
 *   - italic: `_text_`
 *   - code: `` `text` ``  (same as markdown)
 *   - block code: ``` ... ``` (same)
 *   - links: `<url|text>`
 *
 * Per OQ-7 lock, audit trail (policy_decisions) is excluded by default
 * for narrative formats. Slack output stays compact — meant for an
 * incoming-webhook channel post, not a deep-dive review.
 *
 * Output is just the message body string; the caller decides whether
 * to print it to stdout, write to a file, or POST it to a Slack
 * incoming-webhook URL as `{ text: <body> }`.
 */

export interface RenderSlackOptions {
  readonly includeAudit: boolean;
}

export function renderSlack(data: RunWithEverything, options: RenderSlackOptions): string {
  const { run, events, decisions, contextPack, policyDecisions } = data;
  const lines: string[] = [];

  lines.push(`*Run* \`${run.id}\``);
  lines.push(`_${run.agentType} • ${run.status} • started ${run.startedAt.toISOString()}_`);
  lines.push('');

  if (contextPack !== null) {
    lines.push(`*${contextPack.title}*`);
    const excerpt =
      contextPack.contentExcerpt.length > 600
        ? `${contextPack.contentExcerpt.slice(0, 600).trim()}…`
        : contextPack.contentExcerpt;
    lines.push(excerpt);
    lines.push('');
  }

  if (decisions.length > 0) {
    lines.push(`*Decisions (${decisions.length})*`);
    for (const d of decisions.slice(0, 5)) {
      lines.push(
        `• *${d.description}* — ${d.rationale.length > 200 ? `${d.rationale.slice(0, 200).trim()}…` : d.rationale}`,
      );
    }
    if (decisions.length > 5) {
      lines.push(`_…and ${decisions.length - 5} more decision(s)._`);
    }
    lines.push('');
  }

  if (events.length > 0) {
    const phases: Record<string, number> = {};
    const tools: Record<string, number> = {};
    for (const e of events) {
      phases[e.phase] = (phases[e.phase] ?? 0) + 1;
      tools[e.toolName] = (tools[e.toolName] ?? 0) + 1;
    }
    lines.push(
      `*Tool use:* ${events.length} event(s) — ${Object.entries(tools)
        .map(([t, n]) => `${t}×${n}`)
        .join(', ')}`,
    );
    lines.push('');
  }

  if (options.includeAudit && policyDecisions.length > 0) {
    const denies = policyDecisions.filter((p) => p.permissionDecision === 'deny').length;
    const asks = policyDecisions.filter((p) => p.permissionDecision === 'ask').length;
    const allows = policyDecisions.length - denies - asks;
    lines.push(`*Policy decisions:* ${policyDecisions.length} total — ${denies} deny, ${asks} ask, ${allows} allow`);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
