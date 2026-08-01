import type { HookEvent } from '../event.js';
import { normalizeSessionId } from '../normalize-session-id.js';
import type { CodexHookPayload } from '../payloads/codex.js';

const PHASE_MAP: Readonly<Record<CodexHookPayload['hook_event_name'], HookEvent['eventPhase']>> = {
  PreToolUse: 'pre',
  PostToolUse: 'post',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  Stop: 'turn_end',
  UserPromptSubmit: 'user_prompt',
  ConfigChange: 'config_change',
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

export interface AdaptCodexOptions {
  readonly now?: () => Date;
}

export function adaptCodex(payload: CodexHookPayload, options: AdaptCodexOptions = {}): HookEvent {
  const now = options.now ?? (() => new Date());
  const phase = PHASE_MAP[payload.hook_event_name];
  const isUserPrompt = payload.hook_event_name === 'UserPromptSubmit';

  const event: HookEvent = {
    agentType: 'codex',
    eventPhase: phase,
    sessionId: normalizeSessionId(payload.session_id),
    toolName: isUserPrompt ? 'user_prompt' : (payload.tool_name ?? ''),
    toolInput: isUserPrompt ? { prompt: payload.prompt ?? '' } : payload.tool_input,
    rawAt: now().toISOString(),
  };

  const turnId = payload.tool_use_id ?? payload.tool_call_id ?? payload.turn_id;
  if (turnId !== undefined) {
    (event as { turnId?: string }).turnId = turnId;
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
