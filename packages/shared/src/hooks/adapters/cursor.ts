import type { HookEvent } from '../event.js';
import { normalizeSessionId } from '../normalize-session-id.js';
import type { CursorHookPayload } from '../payloads/cursor.js';

const PHASE_MAP: Readonly<Record<CursorHookPayload['hook_event_name'], HookEvent['eventPhase']>> = {
  sessionStart: 'session_start',
  beforeSubmitPrompt: 'user_prompt',
  preToolUse: 'pre',
  postToolUse: 'post',
  stop: 'turn_end',
  sessionEnd: 'session_end',
  postToolUseFailure: 'post_tool_use_failure',
  subagentStart: 'subagent_start',
  subagentStop: 'subagent_stop',
  preCompact: 'pre_compact',
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

export interface AdaptCursorOptions {
  readonly now?: () => Date;
}

/**
 * Cursor has no `ConfigChange`-equivalent hook event, so `eventPhase`
 * never resolves to `'config_change'` for a Cursor-sourced `HookEvent`.
 */
export function adaptCursor(payload: CursorHookPayload, options: AdaptCursorOptions = {}): HookEvent {
  const now = options.now ?? (() => new Date());
  const phase = PHASE_MAP[payload.hook_event_name];
  const isUserPrompt = payload.hook_event_name === 'beforeSubmitPrompt';

  const event: HookEvent = {
    agentType: 'cursor',
    eventPhase: phase,
    sessionId: normalizeSessionId(payload.conversation_id ?? payload.session_id ?? 'unknown'),
    toolName: isUserPrompt ? 'user_prompt' : (payload.tool_name ?? ''),
    toolInput: isUserPrompt ? { prompt: payload.prompt ?? '' } : payload.tool_input,
    rawAt: now().toISOString(),
  };

  if (payload.tool_use_id !== undefined) {
    (event as { turnId?: string }).turnId = payload.tool_use_id;
  }
  const filePath = extractFilePath(payload.tool_input);
  if (filePath !== undefined) {
    (event as { filePath?: string }).filePath = filePath;
  }
  if (payload.cwd !== undefined) {
    (event as { cwd?: string }).cwd = payload.cwd;
  }
  if (payload.subagent_type !== undefined) {
    (event as { subagentType?: string }).subagentType = payload.subagent_type;
  }
  if (payload.subagent_id !== undefined) {
    (event as { subagentId?: string }).subagentId = payload.subagent_id;
  }
  if (payload.summary !== undefined) {
    (event as { lastAssistantMessage?: string }).lastAssistantMessage = payload.summary;
  }
  if (payload.trigger !== undefined) {
    (event as { compactTrigger?: string }).compactTrigger = payload.trigger;
  }
  if (payload.error_message !== undefined) {
    (event as { toolError?: string }).toolError =
      payload.failure_type !== undefined ? `${payload.failure_type}: ${payload.error_message}` : payload.error_message;
  }
  return event;
}
