import type { HookEvent } from '../event.js';
import { normalizeSessionId } from '../normalize-session-id.js';
import type { DevinHookPayload } from '../payloads/devin.js';

const PHASE_MAP: Readonly<Record<DevinHookPayload['hook_event_name'], HookEvent['eventPhase']>> = {
  PreToolUse: 'pre',
  PostToolUse: 'post',
  PermissionRequest: 'permission_request',
  UserPromptSubmit: 'user_prompt',
  Stop: 'turn_end',
  PostCompaction: 'post_compact',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
};

function extractFilePath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ['file_path', 'filePath', 'path']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export interface AdaptDevinOptions {
  readonly now?: () => Date;
}

/**
 * Devin has no `ConfigChange`/`PreCompact`/`SubagentStart`/`SubagentStop`/
 * `PermissionDenied`/`PostToolUseFailure`/`StopFailure`-equivalent hook
 * events, so a Devin-sourced `HookEvent` never carries those `eventPhase`
 * values, nor `subagentType`/`subagentId`/`compactTrigger` (beyond
 * `'post_compact'` itself)/`denialReason`/`errorType`/`errorMessage`.
 */
export function adaptDevin(payload: DevinHookPayload, options: AdaptDevinOptions = {}): HookEvent {
  const now = options.now ?? (() => new Date());
  const phase = PHASE_MAP[payload.hook_event_name];
  const isUserPrompt = payload.hook_event_name === 'UserPromptSubmit';

  const event: HookEvent = {
    agentType: 'devin',
    eventPhase: phase,
    sessionId: normalizeSessionId(payload.session_id ?? 'unknown'),
    toolName: isUserPrompt ? 'user_prompt' : (payload.tool_name ?? ''),
    toolInput: isUserPrompt ? { prompt: payload.prompt ?? '' } : payload.tool_input,
    rawAt: now().toISOString(),
  };

  if (payload.prompt_id !== undefined) {
    (event as { turnId?: string }).turnId = payload.prompt_id;
  }
  const filePath = extractFilePath(payload.tool_input);
  if (filePath !== undefined) {
    (event as { filePath?: string }).filePath = filePath;
  }
  if (payload.cwd !== undefined) {
    (event as { cwd?: string }).cwd = payload.cwd;
  }
  // PostToolUse's tool_response is a nested {success, output, error}
  // object — structurally different from every other agent's flatter
  // error fields (Claude/Codex/Cursor all carry a plain string error
  // field directly on the event, not nested under a response object).
  if (payload.tool_response?.error !== undefined && payload.tool_response.error !== null) {
    (event as { toolError?: string }).toolError = payload.tool_response.error;
  }
  return event;
}
