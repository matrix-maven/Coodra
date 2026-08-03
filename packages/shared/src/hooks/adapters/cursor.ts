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
  return event;
}
