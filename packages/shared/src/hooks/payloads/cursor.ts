import { z } from 'zod';

/**
 * Cursor hook payload shape per ADR-009 and the
 * `essentialsforclaude/11-adrs.md` Cursor adapter description.
 *
 * Cursor's hooks are command-based (stdin/stdout JSON) similar to
 * Windsurf. The shell adapter (`scripts/hook-adapters/cursor-
 * coodra.sh`, S11) reads stdin, normalizes field names, and POSTs
 * to `/v1/hooks/cursor`. Cursor uses `conversation_id` rather than
 * `session_id`; the adapter shell script may rename it before posting,
 * OR the server-side adapter accepts both. We accept `conversation_id`
 * directly here and the adapter maps it to the canonical session id.
 *
 * Cursor's hooks system is newer and the wire format is less stable
 * than Claude Code's or Windsurf's. The schema below reflects the
 * shape Coodra observes today — `.passthrough()` accepts the
 * fields we read while letting unknown future additions through
 * unchanged (Phase 3 Fix A, 2026-05-02 — the prior `.strict()` wrapper
 * rejected every real Claude Code envelope and we keep the same
 * widening discipline here so the same regression cannot bite Cursor
 * once we run it for real). The route still falls open with
 * `permissionDecision: 'allow'` + WARN log on outright shape errors,
 * preserving the agent's turn.
 */
export const CursorHookPayloadSchema = z
  .object({
    /** Cursor's session-equivalent. Run-key segment after normalization. */
    conversation_id: z.string().min(1),
    /** Lifecycle tag; cursor distinguishes pre vs post differently. */
    event_type: z.enum(['pre_tool_use', 'post_tool_use', 'session_start', 'session_end']),
    /** Optional turn id — analogous to Claude Code's tool_use_id. */
    tool_call_id: z.string().optional(),
    /** Tool name (Write, Edit, Bash, etc.) — same convention as Claude Code. */
    tool_name: z.string().optional(),
    /** Same passthrough convention as Claude Code's tool_input. */
    tool_input: z.unknown().optional(),
    /** Cwd is sometimes present, sometimes not — depends on Cursor's mode. */
    cwd: z.string().optional(),
  })
  .passthrough();

export type CursorHookPayload = z.infer<typeof CursorHookPayloadSchema>;
