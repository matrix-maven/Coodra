import type { HookEvent } from '../event.js';
import { normalizeSessionId } from '../normalize-session-id.js';
import type { ClaudeCodeHookPayload } from '../payloads/claude-code.js';

/**
 * Claude Code → HookEvent normalizer. Pure — no I/O, no clock except
 * the optional `now()` injection (defaulted to `Date.now`). Tests pin
 * the `rawAt` field by passing a frozen clock.
 */

const PHASE_MAP: Readonly<Record<ClaudeCodeHookPayload['hook_event_name'], HookEvent['eventPhase']>> = {
  PreToolUse: 'pre',
  PostToolUse: 'post',
  SessionStart: 'session_start',
  // Phase 3 Fix A (2026-05-02): SessionEnd carries the auto-Context-Pack
  // save trigger. Stop is per-turn end and acks at dispatch — see
  // event.ts docblock + apps/hooks-bridge/src/lib/dispatch.ts.
  SessionEnd: 'session_end',
  Stop: 'turn_end',
  UserPromptSubmit: 'user_prompt',
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

export interface AdaptClaudeCodeOptions {
  /** Clock injection for deterministic tests. */
  readonly now?: () => Date;
}

export function adaptClaudeCode(payload: ClaudeCodeHookPayload, options: AdaptClaudeCodeOptions = {}): HookEvent {
  const now = options.now ?? (() => new Date());
  const phase = PHASE_MAP[payload.hook_event_name];
  // UserPromptSubmit carries `prompt` text, not a tool. Fold the prompt
  // into toolInput so downstream RunRecorder can store it via the same
  // tool_input_snapshot column. toolName is set to a stable sentinel.
  const isUserPrompt = payload.hook_event_name === 'UserPromptSubmit';

  const event: HookEvent = {
    agentType: 'claude_code',
    eventPhase: phase,
    sessionId: normalizeSessionId(payload.session_id),
    toolName: isUserPrompt ? 'user_prompt' : (payload.tool_name ?? ''),
    toolInput: isUserPrompt ? { prompt: payload.prompt ?? '', promptId: payload.prompt_id } : payload.tool_input,
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
