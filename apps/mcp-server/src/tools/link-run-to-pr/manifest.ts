import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createLinkRunToPrHandler, type LinkRunToPrHandlerDeps } from './handler.js';
import { type LinkRunToPrInput, linkRunToPrInputSchema, linkRunToPrOutputSchema } from './schema.js';

/**
 * Registration factory for `coodra__link_run_to_pr` — sibling to
 * `link_run_to_issue`, binding a run to `runs.pr_ref` instead of
 * `runs.issue_ref`. Factory-shaped for the same reason: the handler
 * closes over the process's boot-time `DbHandle`;
 * `src/tools/index.ts::registerAllTools` is the single caller.
 */

const linkRunToPrIdempotencyKey: IdempotencyKeyBuilder<LinkRunToPrInput> = (input) => {
  // Mutating (writes runs.pr_ref). Key on runId + the trimmed ref.
  const runId = typeof input?.runId === 'string' && input.runId.length > 0 ? input.runId : 'unknown';
  const prRef = typeof input?.prRef === 'string' && input.prRef.length > 0 ? input.prRef.trim() : 'none';
  return {
    kind: 'mutating',
    key: `link_run_to_pr:${runId}:${prRef}`.slice(0, 200),
  };
};

export function createLinkRunToPrToolRegistration(
  deps: LinkRunToPrHandlerDeps,
): ToolRegistration<typeof linkRunToPrInputSchema, typeof linkRunToPrOutputSchema> {
  return {
    name: 'link_run_to_pr',
    title: 'Coodra: link_run_to_pr',
    description:
      'Call this when the user names or references a pull/merge request this session is for — e.g. "work on PR #88", ' +
      "or after you open/confirm a PR via GitHub/GitLab's own MCP. Binds the current run to that reference " +
      '(runs.prRef) so Coodra history becomes PR-aware, independent of and alongside any linked tracker issue ' +
      '(runs.issueRef) — a run can be bound to both at once. Records a local link only — no provider API call. ' +
      'Returns { ok: true, runId, prRef, previousPrRef, updated } or { ok: false, error: "run_not_found", howToFix }.',
    inputSchema: linkRunToPrInputSchema,
    outputSchema: linkRunToPrOutputSchema,
    idempotencyKey: linkRunToPrIdempotencyKey,
    handler: createLinkRunToPrHandler(deps),
  };
}
