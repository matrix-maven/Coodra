import { z } from 'zod';

/**
 * Input schema for `coodra__link_run_to_issue` (§24.4, Module 09 Track 9A,
 * ADR-016).
 *
 * Binds a Coodra **Run** to a tracker issue reference (Jira, Linear,
 * GitHub Issues, etc.) by setting `runs.issue_ref`. This is Coodra's half
 * of the Direct-provider fusion: the agent's own provider MCP (Rovo for
 * Jira, or another tracker's MCP) provides the issue tools; Coodra records
 * WHICH issue a session is for, so its own history is issue-aware ("what
 * touched PROJ-412?"). No provider API call happens here — the tool only
 * writes a local column. The agent confirms the issue exists via its
 * provider MCP if it needs to.
 *
 * `runId` is the value from `get_run_id`. `issueRef` is deliberately not
 * format-validated beyond a length bound — the calling provider is the
 * authority on whether a reference is well-formed; a bad key surfaces as a
 * "not found" from that provider's own tools, not a Coodra-side rejection.
 * The handler still upper-cases the value for canonical storage (harmless
 * for non-Jira references), so `proj-123` and `PROJ-123` bind identically.
 */
export const linkRunToIssueInputSchema = z
  .object({
    runId: z
      .string()
      .min(1, 'runId is required')
      .max(256, 'runId must be at most 256 characters')
      .describe('The runId returned by get_run_id — the session/run to bind to the issue.'),
    issueRef: z
      .string()
      .min(1, 'issueRef is required')
      .max(64, 'issueRef must be at most 64 characters')
      .describe(
        'Tracker issue reference, e.g. PROJ-123 (Jira), ENG-42 (Linear), or an issue number. Case-normalised to upper.',
      ),
  })
  .strict()
  .describe('Input for coodra__link_run_to_issue.');

/**
 * Output schema — discriminated union on `ok` per the canonical
 * soft-failure shape (`essentialsforclaude/09-common-patterns.md §9.1.2`).
 *
 * Success carries the bound key, the previous key (null when the run was
 * unbound, or the old key on a rebind), and `updated` (false when the run
 * was already bound to this exact key — an idempotent no-op). The
 * soft-failure branch mirrors `record_decision`: an unknown `runId` is a
 * user-recoverable state, not a programming bug, so it is modelled as data
 * with a `howToFix` rather than thrown.
 */
const linkRunToIssueSuccess = z
  .object({
    ok: z.literal(true),
    runId: z.string().min(1),
    issueRef: z.string().min(1).describe('The issue reference now bound to the run (normalised uppercase).'),
    previousIssueRef: z
      .string()
      .nullable()
      .describe('The key the run was bound to before this call, or null if it was unbound.'),
    updated: z.boolean().describe('false when the run was already bound to this exact key (idempotent no-op).'),
  })
  .strict();

const linkRunToIssueRunNotFound = z
  .object({
    ok: z.literal(false),
    error: z.literal('run_not_found'),
    howToFix: z.string().min(1).describe('Agent-surfaceable remediation — call get_run_id first, then retry.'),
  })
  .strict();

export const linkRunToIssueOutputSchema = z.discriminatedUnion('ok', [
  linkRunToIssueSuccess,
  linkRunToIssueRunNotFound,
]);

export type LinkRunToIssueInput = z.infer<typeof linkRunToIssueInputSchema>;
export type LinkRunToIssueOutput = z.infer<typeof linkRunToIssueOutputSchema>;
