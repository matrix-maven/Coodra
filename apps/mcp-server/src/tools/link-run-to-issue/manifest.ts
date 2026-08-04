import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createLinkRunToIssueHandler, type LinkRunToIssueHandlerDeps } from './handler.js';
import { type LinkRunToIssueInput, linkRunToIssueInputSchema, linkRunToIssueOutputSchema } from './schema.js';

/**
 * Registration factory for `coodra__link_run_to_issue` (Module 09 Track
 * 9A, ADR-016 — Jira = Direct). Factory-shaped because the handler closes
 * over the process's boot-time `DbHandle`; `src/tools/index.ts::registerAllTools`
 * is the single caller that supplies it.
 *
 * This is Coodra's half of the Direct-Jira fusion: Atlassian's Rovo MCP
 * provides the Jira tools; this tool records WHICH issue a run is for, so
 * Coodra's own history is queryable by Jira key. It adds zero dependency
 * on Rovo — the column write stands alone whether or not Jira is wired.
 *
 * The §24.3 description-anatomy assertion in
 * `@coodra/shared/test-utils::assertManifestDescriptionValid` is the CI
 * guard that the string below stays within the rules (imperative opener,
 * word count, mentions Returns).
 */

const linkRunToIssueIdempotencyKey: IdempotencyKeyBuilder<LinkRunToIssueInput> = (input) => {
  // Mutating (writes runs.issue_ref). Key on runId + the normalised key so
  // a retry with identical input dedupes in the registry's logs. The
  // `.slice(0, 200)` matches the registry's key-length invariant.
  const runId = typeof input?.runId === 'string' && input.runId.length > 0 ? input.runId : 'unknown';
  const issueRef =
    typeof input?.issueRef === 'string' && input.issueRef.length > 0 ? input.issueRef.toUpperCase() : 'none';
  return {
    kind: 'mutating',
    key: `link_run_to_issue:${runId}:${issueRef}`.slice(0, 200),
  };
};

export function createLinkRunToIssueToolRegistration(
  deps: LinkRunToIssueHandlerDeps,
): ToolRegistration<typeof linkRunToIssueInputSchema, typeof linkRunToIssueOutputSchema> {
  return {
    name: 'link_run_to_issue',
    title: 'Coodra: link_run_to_issue',
    description:
      'Call this when the user names or references a tracker issue this session is for — e.g. "work on PROJ-123", a ' +
      "branch like feature/PROJ-123, or after you confirm the issue via the provider's own MCP (Rovo for Jira, or " +
      'another tracker). Binds the current run to that issue key (runs.issueRef) so Coodra history becomes ' +
      'issue-aware: query_run_history and query_decisions can then answer "what touched PROJ-412?". Records a local ' +
      'link only — no provider API call. Returns { ok: true, runId, issueRef, previousIssueRef, updated } or ' +
      '{ ok: false, error: "run_not_found", howToFix }.',
    inputSchema: linkRunToIssueInputSchema,
    outputSchema: linkRunToIssueOutputSchema,
    idempotencyKey: linkRunToIssueIdempotencyKey,
    handler: createLinkRunToIssueHandler(deps),
  };
}
