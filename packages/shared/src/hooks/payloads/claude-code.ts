import { z } from 'zod';

/**
 * Claude Code hook payload shape per `system-architecture.md` §3.2 and
 * the canonical hook docs at code.claude.com/docs/en/hooks.
 *
 * Claude Code fires hooks as HTTP POST. The wire envelope is wider than
 * the six fields ContextOS reads — every event also carries
 * `transcript_path`, tool-call events add `permission_mode`,
 * SessionStart adds `source` + `model`, and subagent paths add
 * `agent_id` + `agent_type`. Phase 2 verification (2026-04-28) used a
 * `.strict()` wrapper that rejected every real envelope it saw with
 * `invalid_hook_payload`; Phase 3 Fix A switches the wrapper to
 * `.passthrough()` so unknown top-level fields are accepted unchanged.
 * The route still bypasses bad payloads via `safeParse → failOpen` for
 * outright shape violations; `.passthrough()` only widens the contract
 * for unknown-but-tolerated fields, which is exactly what real Claude
 * Code envelopes carry today.
 *
 * Body shape (the fields ContextOS reads — passthrough preserves the rest):
 *
 *     {
 *       "hook_event_name": "PreToolUse",
 *       "session_id": "abc123",
 *       "tool_name": "Write",
 *       "tool_input": { "file_path": "src/auth.ts", "content": "..." },
 *       "tool_use_id": "tool-uuid-456",
 *       "cwd": "/home/dev/myapp"
 *     }
 *
 * `hook_event_name` is locked to the six events ContextOS cares about.
 * Stop fires per-turn; SessionEnd fires once per session-termination
 * (matcher reasons: `clear` / `resume` / `logout` / `prompt_input_exit`
 * / `bypass_permissions_disabled` / `other`). The adapter routes Stop
 * to phase `'turn_end'` (plain ack) and SessionEnd to `'session_end'`
 * (auto-context-pack save + runs row close).
 *
 * `tool_input` is intentionally `z.unknown()` because tool inputs vary
 * by tool (Write has `file_path` + `content`, Bash has `command`, etc.)
 * The adapter passes `tool_input` through unchanged.
 *
 * `prompt` + `prompt_id` are present on `UserPromptSubmit` events
 * only. They're optional here because the same schema is reused for
 * pre/post/session events.
 */
export const ClaudeCodeHookPayloadSchema = z
  .object({
    hook_event_name: z.enum(['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'Stop', 'UserPromptSubmit']),
    session_id: z.string().min(1),
    tool_name: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_use_id: z.string().optional(),
    cwd: z.string().optional(),
    prompt: z.string().optional(),
    prompt_id: z.string().optional(),
  })
  .passthrough();

export type ClaudeCodeHookPayload = z.infer<typeof ClaudeCodeHookPayloadSchema>;
