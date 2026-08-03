import { z } from 'zod';

/**
 * Cursor lifecycle hook payloads.
 *
 * Cursor command hooks receive one JSON object on stdin, same contract
 * shape as Claude Code/Codex. Field names below are taken from
 * cursor.com/docs/hooks (2026-08-02) — `hook_event_name` plus the
 * "Common Input (All Hooks)" fields (`conversation_id`, `session_id`)
 * and the per-event fields Coodra reads (`tool_name`, `tool_input`,
 * `tool_use_id`, `cwd`, `prompt`). This has NOT been verified against a
 * live Cursor hook invocation (cursor-agent requires a logged-in Cursor
 * account this environment doesn't have) — passthrough + all-optional
 * fields keep a wire-format surprise from crashing the hook rather than
 * failing open, matching the existing Codex/Claude Code schemas'
 * discipline. A prior, now-deleted Cursor adapter
 * (`git show 099742a~1:packages/shared/src/hooks/payloads/cursor.ts`)
 * assumed a different, snake_case `event_type` shape
 * (`pre_tool_use`/`post_tool_use`/`session_start`/`session_end`) — that
 * predates Cursor's current documented hook system and is not reused
 * here, though its choice of `conversation_id` as the session
 * identifier does match the current docs and is kept.
 */
export const CursorHookPayloadSchema = z
  .object({
    hook_event_name: z.enum(['sessionStart', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'stop', 'sessionEnd']),
    conversation_id: z.string().optional(),
    session_id: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_output: z.unknown().optional(),
    tool_use_id: z.string().optional(),
    cwd: z.string().optional(),
    prompt: z.string().optional(),
    reason: z.string().optional(),
    agent_message: z.string().optional(),
  })
  .passthrough();

export type CursorHookPayload = z.infer<typeof CursorHookPayloadSchema>;
