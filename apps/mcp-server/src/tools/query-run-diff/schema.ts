import { runDiffFileEntrySchema } from '@coodra/shared';
import { z } from 'zod';

/**
 * Input + output schemas for `coodra__query_run_diff` (Module 06).
 *
 * Read-only tool. The bridge writes the row at SessionEnd; this tool
 * surfaces it back to agents for richer save_context_pack writeups, or
 * to humans via the web view's server action.
 *
 * Soft-failure shape per `09-common-patterns.md` §9.1.2:
 *   - `run_not_found`        — runId is not registered.
 *   - `analysis_pending`     — runs row exists but no run_diffs row yet
 *                              (SessionEnd hasn't fired, or fired with
 *                              no cwd, or the runner is mid-write).
 *   - `no_base_sha`          — diff baseline missing (non-git project).
 *   - `no_edits_in_run`      — run had no Edit/Write tool calls.
 *   - `git_diff_failed`      — `git diff` errored; `unifiedDiff` carries
 *                              the captured stderr for triage.
 *
 * Caller contract (per §9.1.2): both the outer `ok` (transport success)
 * and the inner `data.ok` (domain success) MUST be checked. Agents that
 * read the success branch unconditionally will see undefined fields on
 * a soft-failure response.
 */

export const queryRunDiffInputSchema = z
  .object({
    runId: z.string().min(1, 'runId is required').max(256),
  })
  .strict()
  .describe('Input for coodra__query_run_diff.');

const successBranch = z
  .object({
    ok: z.literal(true),
    runId: z.string().min(1),
    baseSha: z
      .string()
      .nullable()
      .describe('git rev-parse HEAD captured at SessionStart, or null on non-git projects.'),
    headSha: z.string().nullable().describe('git rev-parse HEAD at SessionEnd, or null when capture failed.'),
    unifiedDiff: z.string().describe('git diff output, scoped to files the agent edited. Possibly truncated.'),
    filesChanged: z.array(runDiffFileEntrySchema),
    truncated: z.boolean().describe('true when unifiedDiff was clipped at MAX_UNIFIED_DIFF_BYTES.'),
    generatedAt: z.string().datetime(),
  })
  .strict();

const runNotFoundBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('run_not_found'),
    howToFix: z.string().min(1),
  })
  .strict();

const analysisPendingBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('analysis_pending'),
    howToFix: z.string().min(1),
  })
  .strict();

const noBaseShaBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('no_base_sha'),
    howToFix: z.string().min(1),
  })
  .strict();

const noEditsBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('no_edits_in_run'),
    howToFix: z.string().min(1),
  })
  .strict();

const gitDiffFailedBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('git_diff_failed'),
    howToFix: z.string().min(1),
    stderr: z.string().describe('Captured git stderr for triage.'),
  })
  .strict();

export const queryRunDiffOutputSchema = z.union([
  successBranch,
  runNotFoundBranch,
  analysisPendingBranch,
  noBaseShaBranch,
  noEditsBranch,
  gitDiffFailedBranch,
]);

export type QueryRunDiffInput = z.infer<typeof queryRunDiffInputSchema>;
export type QueryRunDiffOutput = z.infer<typeof queryRunDiffOutputSchema>;
