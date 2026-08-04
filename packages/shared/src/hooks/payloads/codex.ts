import { z } from 'zod';

/**
 * Codex lifecycle hook payloads.
 *
 * Codex command hooks receive one JSON object on stdin. The fields below
 * are the stable subset Coodra needs to normalize into HookEvent; the
 * schema is passthrough so new Codex fields do not break lifecycle capture.
 *
 * Five events added (Codex hook coverage expansion, mirroring Claude
 * Code's 91e8803 — see learn.chatgpt.com/docs/hooks):
 *   - `PermissionRequest` — tool-carrying, reuses the same
 *     tool_name/tool_input/tool_use_id/tool_call_id fields PreToolUse
 *     already has. No new fields.
 *   - `SubagentStart` / `SubagentStop` — carry `agent_type`/`agent_id`.
 *   - `PreCompact` / `PostCompact` — carry `trigger` (`'manual'` or
 *     `'auto'`).
 * `agent_type`/`agent_id`/`trigger` field names are inferred from
 * Codex's existing snake_case conventions and Claude Code's parallel
 * fields — the docs confirm these as *matcher* targets but not the
 * exact wire payload field names. Passthrough means a wrong guess
 * fails soft rather than rejecting the payload; verify against a live
 * Codex session before relying on them.
 */
export const CodexHookPayloadSchema = z
  .object({
    hook_event_name: z.enum([
      'PreToolUse',
      'PostToolUse',
      'SessionStart',
      'SessionEnd',
      'Stop',
      'UserPromptSubmit',
      'ConfigChange',
      'PermissionRequest',
      'PreCompact',
      'PostCompact',
      'SubagentStart',
      'SubagentStop',
    ]),
    session_id: z.string().min(1),
    turn_id: z.string().optional(),
    tool_name: z.string().optional(),
    tool_use_id: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    cwd: z.string().optional(),
    prompt: z.string().optional(),
    source: z.string().optional(),
    reason: z.string().optional(),
    model: z.string().optional(),
    agent_type: z.string().optional(),
    agent_id: z.string().optional(),
    trigger: z.string().optional(),
  })
  .passthrough();

export type CodexHookPayload = z.infer<typeof CodexHookPayloadSchema>;
