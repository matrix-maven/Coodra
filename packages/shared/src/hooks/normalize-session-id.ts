import { runKeySegmentSchema } from '../idempotency.js';

/**
 * `@coodra/shared/hooks/normalize-session-id` — single function that
 * turns an agent-supplied raw session id into a value safe to embed in
 * a Coodra run-key (`run:{projectId}:{sessionId}:{uuid}` per
 * `system-architecture.md` §4.3).
 *
 * Module 03 S6 closes the deeper carryover from verification §8.6 by
 * making `normalizeSessionId` the ONLY function that touches an
 * incoming session id at the hooks-bridge boundary. The Module 02 fix
 * (`runKeySegmentSchema` validation at the registry boundary) protects
 * the MCP read surface; this helper protects the hooks write surface.
 *
 * Real-world session-id shapes seen in fixtures:
 *   - Claude Code: `claude-code-{uuid}` or `claude-code-{uuid}:fork-{n}`
 *     (the second form has a colon — exactly what runKeySegmentSchema
 *     rejects).
 *   - Windsurf: `traj-{base32}` (no colon, but may carry whitespace
 *     in older Windsurf builds).
 *   - Cursor: `conv-{uuid}` (per ADR-009).
 *
 * Sanitization rules (in order):
 *   1. Replace every `<`, `>`, `:`, `"`, `/`, `\\`, `|`, `?`, `*`, or
 *      whitespace character with `-`.
 *   2. Collapse any run of `--` to a single `-`.
 *   3. Strip leading + trailing `-`.
 *   4. Final guard: parse the result against `runKeySegmentSchema`,
 *      which throws `ZodError` if the result is empty or still
 *      contains `:` (defence-in-depth — a future codepath that adds a
 *      new sanitization branch shouldn't be able to silently break the
 *      no-colon invariant).
 *
 * Lossy by design — Claude Code's `:fork-{n}` suffix collapses into
 * `-fork-{n}`. The fork-id is also surfaced separately on the hook
 * payload (`tool_use_id` for Claude Code), so the lossy sanitization
 * does not lose the fork lineage; it just normalises the session-id
 * field. If a future agent surfaces fork lineage only in the session
 * id, revisit.
 */
export function normalizeSessionId(raw: string): string {
  const cleaned = raw
    .replace(/[<>:"/\\|?*\s]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return runKeySegmentSchema.parse(cleaned);
}
