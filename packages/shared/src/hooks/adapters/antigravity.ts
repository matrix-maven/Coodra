import type { HookEvent } from '../event.js';
import { normalizeSessionId } from '../normalize-session-id.js';
import type { AntigravityHookPayload } from '../payloads/antigravity.js';

/**
 * Antigravity has no `SessionStart`-equivalent hook event at all — the
 * closest thing is `PreInvocation`, which fires before EVERY model turn
 * in a conversation, not just the first. Naively firing Coodra's full
 * session contract / recent-context injection on every `PreInvocation`
 * would be noisy and costly (once per turn, not once per session).
 *
 * So the first `PreInvocation` of a conversation is canonicalized to the
 * shared `'SessionStart'` name, reusing 100% of the existing
 * `SessionStart`-gated logic in `lifecycle-event/handler.ts` unchanged;
 * every subsequent `PreInvocation` keeps its own name and maps to the
 * new `'pre_invocation'` eventPhase instead (see `event.ts`'s docblock).
 *
 * `invocationNum <= 1` (not `=== 0` or `=== 1`) deliberately covers both
 * possible indexing conventions — genuinely unconfirmed from docs which
 * one Antigravity uses, and this hasn't been verified against a live,
 * driven session. Flagged for live confirmation once possible.
 */
export function canonicalizeAntigravityEventName(payload: AntigravityHookPayload): string {
  if (payload.hookEventName === 'PreInvocation' && (payload.invocationNum ?? 0) <= 1) {
    return 'SessionStart';
  }
  return payload.hookEventName;
}

const PHASE_MAP: Readonly<Record<string, HookEvent['eventPhase']>> = {
  PreToolUse: 'pre',
  PostToolUse: 'post',
  SessionStart: 'session_start',
  PreInvocation: 'pre_invocation',
  PostInvocation: 'post_invocation',
  Stop: 'turn_end',
};

export interface AdaptAntigravityOptions {
  readonly now?: () => Date;
}

/**
 * Antigravity has no `ConfigChange`/`PreCompact`/`PostCompact`/
 * `SessionEnd`/`UserPromptSubmit`/`PermissionRequest`/`SubagentStart`/
 * `SubagentStop`-equivalent hook events, so an Antigravity-sourced
 * `HookEvent` never carries those `eventPhase` values (nor
 * `subagentType`/`subagentId`/`compactTrigger`/`denialReason`/
 * `errorType`/`errorMessage`).
 *
 * `canonicalName` is the output of `canonicalizeAntigravityEventName`,
 * not `payload.hookEventName` directly — callers must run that
 * translation first (see `parseAndAdapt`'s antigravity branch in
 * `lifecycle-event/handler.ts`).
 */
export function adaptAntigravity(
  payload: AntigravityHookPayload,
  canonicalName: string,
  options: AdaptAntigravityOptions = {},
): HookEvent {
  const now = options.now ?? (() => new Date());
  const phase = PHASE_MAP[canonicalName] ?? 'pre_invocation';

  const event: HookEvent = {
    agentType: 'antigravity',
    eventPhase: phase,
    sessionId: normalizeSessionId(payload.conversationId ?? 'unknown'),
    // Confirmed gap: PostToolUse's own documented payload never restates
    // the tool call (see payloads/antigravity.ts's docblock) — toolName
    // comes back empty for that event, not assumed from PreToolUse.
    toolName: payload.toolCall?.name ?? '',
    toolInput: payload.toolCall?.args,
    rawAt: now().toISOString(),
  };

  // Antigravity has nothing equivalent to Claude's tool_use_id — stepIdx
  // is the best available per-call correlator, an approximation, not a
  // confirmed stable turn identifier.
  if (payload.stepIdx !== undefined) {
    (event as { turnId?: string }).turnId = String(payload.stepIdx);
  }
  const filePath = extractFilePath(payload.toolCall?.args);
  if (filePath !== undefined) {
    (event as { filePath?: string }).filePath = filePath;
  }
  const cwd = payload.workspacePaths?.[0];
  if (cwd !== undefined) {
    (event as { cwd?: string }).cwd = cwd;
  }
  if (payload.error !== undefined && payload.error.length > 0) {
    (event as { toolError?: string }).toolError = payload.error;
  }
  return event;
}

function extractFilePath(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ['file_path', 'filePath', 'path', 'FilePath']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
