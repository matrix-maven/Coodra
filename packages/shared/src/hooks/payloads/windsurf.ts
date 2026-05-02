import { z } from 'zod';

/**
 * Windsurf Cascade hook payload shape per `system-architecture.md` §3.3.
 *
 * Windsurf fires hooks as **shell commands** (not HTTP). The hook
 * receives JSON on stdin. The adapter shell script (`scripts/hook-
 * adapters/windsurf-contextos.sh`, S11) curls the payload to
 * `POST /v1/hooks/windsurf` and translates the response back to
 * exit-code-based allow/deny.
 *
 * Body shape (verbatim from §3.3):
 *
 *     {
 *       "agent_action_name": "pre_write_code",
 *       "trajectory_id": "traj-abc123",
 *       "execution_id": "exec-xyz789",
 *       "timestamp": "2026-04-16T10:00:00Z",
 *       "model_name": "Claude Sonnet 4",
 *       "tool_info": {
 *         "file_path": "src/auth.ts",
 *         "edits": [{ "old_string": "...", "new_string": "..." }]
 *       }
 *     }
 *
 * `trajectory_id` = session ID. `execution_id` = turn ID. The 12 event
 * types Windsurf supports map to ContextOS's normalized eventPhase per
 * §3.3 — the adapter handles the mapping.
 *
 * `tool_info` is intentionally `z.unknown()` because its shape varies
 * by event (file_path + edits for write_code, command for run_command,
 * etc.). Adapters pull `file_path` out separately for path-glob
 * matching but leave the rest opaque.
 *
 * `.passthrough()` on the outer object accepts unknown top-level
 * fields unchanged (Phase 3 Fix A, 2026-05-02 — applied to every
 * agent payload schema after Phase 2 verification showed `.strict()`
 * rejected real Claude Code envelopes for fields outside our enum;
 * Windsurf will inevitably grow new fields too, and we want them to
 * pass through rather than fail-open).
 */
export const WindsurfHookPayloadSchema = z
  .object({
    agent_action_name: z.enum([
      'pre_write_code',
      'pre_run_command',
      'pre_mcp_tool_use',
      'pre_read_code',
      'pre_user_prompt',
      'post_write_code',
      'post_run_command',
      'post_mcp_tool_use',
      'post_cascade_response',
      // Three currently-unmapped events; see §3.3 mapping table.
      'post_read_code',
      'post_user_prompt',
      'pre_cascade_response',
    ]),
    trajectory_id: z.string().min(1),
    execution_id: z.string().optional(),
    timestamp: z.string().optional(),
    model_name: z.string().optional(),
    tool_info: z.unknown().optional(),
  })
  .passthrough();

export type WindsurfHookPayload = z.infer<typeof WindsurfHookPayloadSchema>;
