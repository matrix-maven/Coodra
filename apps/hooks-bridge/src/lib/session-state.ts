/**
 * `apps/hooks-bridge/src/lib/session-state.ts` — Module 05 §6.D.
 *
 * In-memory counter map for the mid-session compliance reminder.
 *
 * Tracks PostToolUse event counts per `runId`. When the count crosses
 * the threshold (default 15) for the first time, the bridge injects
 * a one-shot system reminder telling the agent to call
 * `save_context_pack` before exiting. The counter clears on
 * Stop / SessionEnd.
 *
 * Bridge-restart behaviour: this is a per-process Map. If the bridge
 * restarts mid-session the counter resets and the agent may receive
 * an extra reminder. That's an acceptable failure mode — the goal is
 * encouragement, not enforcement.
 */

interface SessionState {
  postToolUseCount: number;
  reminderFired: boolean;
  saveContextPackCalled: boolean;
}

const state: Map<string, SessionState> = new Map();

function getOrInit(runId: string): SessionState {
  let s = state.get(runId);
  if (s === undefined) {
    s = { postToolUseCount: 0, reminderFired: false, saveContextPackCalled: false };
    state.set(runId, s);
  }
  return s;
}

/**
 * Increment the PostToolUse counter. Returns true if this is the first
 * tool call to cross the threshold AND the agent has not yet called
 * save_context_pack — caller injects the reminder.
 */
export function recordPostToolUseAndCheckReminder(runId: string, threshold: number): boolean {
  if (typeof runId !== 'string' || runId.length === 0) return false;
  if (threshold <= 0) return false; // disabled
  const s = getOrInit(runId);
  s.postToolUseCount += 1;
  if (s.reminderFired || s.saveContextPackCalled) return false;
  if (s.postToolUseCount < threshold) return false;
  s.reminderFired = true;
  return true;
}

/**
 * Mark that `save_context_pack` was called for this run. Future
 * PostToolUse events do NOT fire the reminder (agent is already
 * compliant).
 */
export function markSaveContextPackCalled(runId: string): void {
  if (typeof runId !== 'string' || runId.length === 0) return;
  getOrInit(runId).saveContextPackCalled = true;
}

/**
 * Drop a run's counter. Called on Stop / SessionEnd. Idempotent.
 */
export function clearSessionState(runId: string): void {
  if (typeof runId !== 'string' || runId.length === 0) return;
  state.delete(runId);
}

/**
 * Test-only: clear all state. Production code should not call this —
 * `clearSessionState(runId)` is the per-run path.
 */
export function _clearAllSessionStateForTests(): void {
  state.clear();
}

/**
 * Test-only: read current counter state.
 */
export function _getSessionStateForTests(runId: string): SessionState | undefined {
  return state.get(runId);
}
