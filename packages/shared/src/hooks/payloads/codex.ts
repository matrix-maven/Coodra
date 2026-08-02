import { z } from 'zod';

/**
 * Codex lifecycle hook payloads.
 *
 * Codex command hooks receive one JSON object on stdin. The fields below
 * are the stable subset Coodra needs to normalize into HookEvent; the
 * schema is passthrough so new Codex fields do not break lifecycle capture.
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
  })
  .passthrough();

export type CodexHookPayload = z.infer<typeof CodexHookPayloadSchema>;
