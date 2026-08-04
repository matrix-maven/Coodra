import { z } from 'zod';

/**
 * Input schema for `coodra__link_run_to_pr` (Module 09, sibling to
 * `link_run_to_issue`).
 *
 * Binds a Coodra **Run** to a pull/merge request reference (GitHub PR,
 * GitLab MR, etc.) by setting `runs.pr_ref` — a column that already
 * existed alongside `runs.issue_ref` but had no writer. A run can be bound
 * to a tracker issue AND a PR/MR at the same time (two independent
 * columns), which is the common flow: pull a Jira issue, then open a PR
 * against it. No provider API call happens here — the tool only writes a
 * local column. The agent confirms the PR/MR exists via its own provider
 * MCP if it needs to.
 *
 * `prRef` is deliberately not format-validated beyond a length bound — PR
 * references vary by provider (a bare number, `owner/repo#123`, a URL);
 * the calling provider is the authority on whether it's well-formed.
 * Unlike `issueRef`, this is NOT case-normalised — PR references aren't
 * conventionally uppercase.
 */
export const linkRunToPrInputSchema = z
  .object({
    runId: z
      .string()
      .min(1, 'runId is required')
      .max(256, 'runId must be at most 256 characters')
      .describe('The runId returned by get_run_id — the session/run to bind to the PR/MR.'),
    prRef: z
      .string()
      .min(1, 'prRef is required')
      .max(128, 'prRef must be at most 128 characters')
      .describe('PR/MR reference, e.g. "88", "owner/repo#88", or a PR URL. Stored as-is, no case normalisation.'),
  })
  .strict()
  .describe('Input for coodra__link_run_to_pr.');

/**
 * Output schema — discriminated union on `ok`, mirroring
 * `link_run_to_issue`'s shape exactly (§9.1.2 canonical soft-failure
 * pattern).
 */
const linkRunToPrSuccess = z
  .object({
    ok: z.literal(true),
    runId: z.string().min(1),
    prRef: z.string().min(1).describe('The PR/MR reference now bound to the run.'),
    previousPrRef: z
      .string()
      .nullable()
      .describe('The reference the run was bound to before this call, or null if it was unbound.'),
    updated: z.boolean().describe('false when the run was already bound to this exact reference (idempotent no-op).'),
  })
  .strict();

const linkRunToPrRunNotFound = z
  .object({
    ok: z.literal(false),
    error: z.literal('run_not_found'),
    howToFix: z.string().min(1).describe('Agent-surfaceable remediation — call get_run_id first, then retry.'),
  })
  .strict();

export const linkRunToPrOutputSchema = z.discriminatedUnion('ok', [linkRunToPrSuccess, linkRunToPrRunNotFound]);

export type LinkRunToPrInput = z.infer<typeof linkRunToPrInputSchema>;
export type LinkRunToPrOutput = z.infer<typeof linkRunToPrOutputSchema>;
