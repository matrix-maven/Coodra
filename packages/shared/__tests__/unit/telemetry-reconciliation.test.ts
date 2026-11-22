import { describe, expect, it } from 'vitest';

import {
  type HookObservation,
  nativeToolUseIdFromHookKey,
  type ReconcileInput,
  reconcileToolOperations,
  type TelemetryToolResult,
} from '../../src/telemetry-reconciliation.js';

const NOW = 10_000_000;
const key = (event: 'PreToolUse' | 'PostToolUse', tool: string, native: string, harness = 'claude_code') =>
  `lifecycle_event:${harness}:sess-1:${event}:${tool}:${native}`;
const hook = (
  phase: 'pre' | 'post',
  native: string,
  atMs = NOW - 600_000,
  tool = 'Read',
  outcome: string | null = 'allow',
): HookObservation => ({
  rowId: `row_${phase}_${native}`,
  phase,
  toolName: tool,
  toolUseId: key(phase === 'pre' ? 'PreToolUse' : 'PostToolUse', tool, native),
  outcome,
  atMs,
});
const tele = (native: string | null, over: Partial<TelemetryToolResult> = {}): TelemetryToolResult => ({
  evidenceId: `native_telemetry_${native ?? 'none'}_${over.sourceMs ?? 1}`,
  toolUseId: native,
  toolName: 'Read',
  success: true,
  durationMs: 5,
  sourceMs: NOW - 600_000,
  receivedMs: NOW - 599_000,
  ...over,
});
const run = (over: Partial<ReconcileInput>): ReturnType<typeof reconcileToolOperations> =>
  reconcileToolOperations({
    harness: 'claude_code',
    hooks: [],
    telemetry: [],
    telemetryEventCount: 1,
    hasRun: true,
    runEnded: false,
    nowMs: NOW,
    ...over,
  });

describe('nativeToolUseIdFromHookKey', () => {
  it('extracts the final segment of a Claude Code hook key', () => {
    expect(nativeToolUseIdFromHookKey(key('PreToolUse', 'Bash', 'toolu_abc'), 'claude_code')).toBe('toolu_abc');
    expect(nativeToolUseIdFromHookKey(key('PostToolUse', 'mcp__a__b', 'toolu_x'), 'claude_code')).toBe('toolu_x');
  });
  it('returns null for keys without a usable native id instead of guessing', () => {
    expect(nativeToolUseIdFromHookKey('no-turn', 'claude_code')).toBeNull();
    expect(nativeToolUseIdFromHookKey('lifecycle_event:claude_code:s:PreToolUse:Bash:', 'claude_code')).toBeNull();
    expect(nativeToolUseIdFromHookKey('lifecycle_event:claude_code:s:SessionStart:Bash:x', 'claude_code')).toBeNull();
    expect(nativeToolUseIdFromHookKey(key('PreToolUse', 'Bash', 'call_1', 'codex'), 'claude_code')).toBeNull();
  });
});

describe('reconcileToolOperations', () => {
  it('matches an operation seen by both channels', () => {
    const r = run({ hooks: [hook('pre', 't1'), hook('post', 't1')], telemetry: [tele('t1')] });
    expect(r.operations).toHaveLength(1);
    expect(r.operations[0]).toMatchObject({ nativeToolUseId: 't1', status: 'matched', disagreements: [] });
    expect(r.operations[0]?.hook?.rowIds).toEqual(['row_pre_t1', 'row_post_t1']);
    expect(r.summary).toMatchObject({ matched: 1, matchedWithDisagreement: 0, total: 1 });
  });

  it('reports a failed tool with only a PreToolUse hook as consistent, not a disagreement', () => {
    const r = run({ hooks: [hook('pre', 't1')], telemetry: [tele('t1', { success: false })] });
    expect(r.operations[0]).toMatchObject({ status: 'matched', disagreements: [] });
  });

  it('flags channel disagreements on matched operations', () => {
    const missingPost = run({ hooks: [hook('pre', 't1')], telemetry: [tele('t1', { success: true })] });
    expect(missingPost.operations[0]?.disagreements).toEqual(['post_hook_missing']);
    const postAfterFailure = run({
      hooks: [hook('pre', 't1'), hook('post', 't1')],
      telemetry: [tele('t1', { success: false })],
    });
    expect(postAfterFailure.operations[0]?.disagreements).toEqual(['post_hook_after_failure']);
    const missingPre = run({ hooks: [hook('post', 't1')], telemetry: [tele('t1')] });
    expect(missingPre.operations[0]?.disagreements).toEqual(['pre_hook_missing']);
    expect(missingPost.summary.matchedWithDisagreement).toBe(1);
  });

  it('does not infer a status check when telemetry did not report success', () => {
    const r = run({ hooks: [hook('pre', 't1')], telemetry: [tele('t1', { success: null })] });
    expect(r.operations[0]?.disagreements).toEqual([]);
  });

  it('reports hook-only once the grace window has passed and the other channel exists', () => {
    const r = run({ hooks: [hook('pre', 't1'), hook('post', 't1')], telemetry: [tele('other')] });
    expect(r.operations.find((o) => o.nativeToolUseId === 't1')?.status).toBe('hook_only');
  });

  it('reports telemetry-only once the grace window has passed', () => {
    const r = run({ hooks: [], telemetry: [tele('t9')] });
    expect(r.operations[0]).toMatchObject({ status: 'telemetry_only', nativeToolUseId: 't9' });
  });

  it('keeps one-sided recent operations as awaiting arrival, and closes the window when the Run ended', () => {
    const recentHook = run({ hooks: [hook('pre', 't1', NOW - 10_000)], telemetry: [tele('other')] });
    expect(recentHook.operations.find((o) => o.nativeToolUseId === 't1')?.status).toBe('awaiting_arrival');
    const recentTelemetry = run({ telemetry: [tele('t2', { receivedMs: NOW - 5_000 })] });
    expect(recentTelemetry.operations[0]?.status).toBe('awaiting_arrival');
    const ended = run({ hooks: [hook('pre', 't1', NOW - 10_000)], telemetry: [tele('other')], runEnded: true });
    expect(ended.operations.find((o) => o.nativeToolUseId === 't1')?.status).toBe('hook_only');
  });

  it('never matches on session or time proximity alone', () => {
    const r = run({
      hooks: [hook('pre', 'hook-id', NOW - 600_000)],
      telemetry: [tele('different-id', { sourceMs: NOW - 600_000 })],
    });
    expect(r.summary).toMatchObject({ matched: 0, hookOnly: 1, telemetryOnly: 1 });
  });

  it('marks hooks not comparable when the telemetry channel was never observed', () => {
    const r = run({ hooks: [hook('pre', 't1')], telemetry: [], telemetryEventCount: 0 });
    expect(r.operations[0]).toMatchObject({ status: 'not_comparable', reason: 'telemetry_channel_not_observed' });
    expect(r.limitations.join(' ')).toContain('No native telemetry was received');
  });

  it('reports records without a usable id as not comparable instead of merging them', () => {
    const r = run({
      hooks: [
        { rowId: 'r', phase: 'pre', toolName: 'Bash', toolUseId: 'no-turn', outcome: 'allow', atMs: NOW - 600_000 },
      ],
      telemetry: [tele(null)],
    });
    expect(r.operations.map((o) => o.reason).sort()).toEqual([
      'hook_key_without_native_id',
      'telemetry_without_tool_use_id',
    ]);
    expect(r.limitations.join(' ')).toContain('no native tool-use id');
  });

  it('keeps distinct telemetry occurrences of one id visible', () => {
    const r = run({
      hooks: [hook('pre', 't1'), hook('post', 't1')],
      telemetry: [tele('t1', { sourceMs: 1 }), tele('t1', { sourceMs: 2 })],
    });
    expect(r.operations).toHaveLength(1);
    expect(r.operations[0]?.telemetry?.occurrences).toBe(2);
  });

  it('notes name differences without counting them as disagreement', () => {
    const r = run({
      hooks: [hook('pre', 't1'), hook('post', 't1')],
      telemetry: [tele('t1', { toolName: 'mcp_tool' })],
    });
    expect(r.operations[0]).toMatchObject({ toolNameDiffers: true, disagreements: [] });
  });

  it('treats a session with no Run as telemetry-only evidence with an explicit limitation', () => {
    const r = run({ hasRun: false, hooks: [], telemetry: [tele('t1', { receivedMs: NOW - 1_000 })] });
    expect(r.operations[0]?.status).toBe('telemetry_only');
    expect(r.limitations.join(' ')).toContain('No Run exists');
  });

  it('refuses to compare harnesses without a telemetry adapter', () => {
    const r = reconcileToolOperations({
      harness: 'codex',
      hooks: [{ ...hook('pre', 'call_1'), toolUseId: key('PreToolUse', 'Bash', 'call_1', 'codex') }],
      telemetry: [],
      telemetryEventCount: 0,
      hasRun: true,
      runEnded: true,
      nowMs: NOW,
    });
    expect(r.limitations.join(' ')).toContain('No native telemetry adapter');
    expect(r.operations.every((o) => o.status === 'not_comparable')).toBe(true);
  });
});
