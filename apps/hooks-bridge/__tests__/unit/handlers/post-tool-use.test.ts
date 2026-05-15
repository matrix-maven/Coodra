import type { DbHandle } from '@coodra/db';
import type { HookEvent } from '@coodra/shared/hooks';
import { describe, expect, it, vi } from 'vitest';

import { createPostToolUseHandler } from '../../../src/handlers/post-tool-use.js';
import type { ProjectSlugResolver } from '../../../src/lib/resolve-project-slug.js';
import type { RunRecorder } from '../../../src/lib/run-recorder.js';

function makeEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    agentType: 'claude_code',
    eventPhase: 'post',
    sessionId: 'sess',
    turnId: 'tool-1',
    toolName: 'Write',
    toolInput: { file_path: 'src/x.ts' },
    rawAt: '2026-04-25T12:00:00.000Z',
    ...overrides,
  };
}

const stubRecorder: RunRecorder = {
  recordPostToolUse: vi.fn(),
  recordUserPromptSubmit: vi.fn(),
  recordPolicyDecision: vi.fn(),
  recordSessionStart: vi.fn(),
  recordSessionEnd: vi.fn(),
};

// M04 Phase 2 S1 (F3): handler now calls resolveAndEnsure on the audit
// path. The stub returns the same shape for both methods.
const stubResolver: ProjectSlugResolver = {
  resolve: vi.fn().mockResolvedValue({ slug: 'verify', projectId: 'proj_test' }),
  resolveAndEnsure: vi.fn().mockResolvedValue({ slug: 'verify', projectId: 'proj_test' }),
  invalidate: vi.fn(),
};

const fakeDb = { kind: 'sqlite', db: {}, raw: {}, close: () => {} } as unknown as DbHandle;

describe('createPostToolUseHandler', () => {
  it('schedules the audit with resolved projectId + returns allow synchronously', async () => {
    const handler = createPostToolUseHandler({
      runRecorder: stubRecorder,
      projectSlugResolver: stubResolver,
      db: fakeDb,
    });
    const result = await handler(makeEvent());
    expect(result.permissionDecision).toBe('allow');
    expect(stubRecorder.recordPostToolUse).toHaveBeenCalledTimes(1);
    // F8 closure: handler now passes projectId to the recorder so
    // `run_events.run_id` can resolve.
    expect(stubRecorder.recordPostToolUse).toHaveBeenCalledWith(expect.any(Object), 'proj_test');
  });

  it('non-post event → defensive allow + reason event_phase_mismatch (audit NOT scheduled)', async () => {
    vi.mocked(stubRecorder.recordPostToolUse).mockClear();
    const handler = createPostToolUseHandler({
      runRecorder: stubRecorder,
      projectSlugResolver: stubResolver,
      db: fakeDb,
    });
    const result = await handler(makeEvent({ eventPhase: 'pre' }));
    expect(result.permissionDecision).toBe('allow');
    expect(result.permissionDecisionReason).toBe('event_phase_mismatch');
    expect(stubRecorder.recordPostToolUse).not.toHaveBeenCalled();
  });

  it('passes projectId=undefined when resolver returns no project (F7-related fallback path; M04 P2 S1: now via resolveAndEnsure)', async () => {
    vi.mocked(stubRecorder.recordPostToolUse).mockClear();
    // M04 Phase 2 S1 (F3): handler reads from resolveAndEnsure now;
    // override that mock instead. The fallback semantic is preserved:
    // when ensure returns undefined (reserved basename, derive failed),
    // the recorder still writes through __global__ (via the run-recorder
    // internal `effectiveProjectId = projectId ?? GLOBAL_PROJECT_ID`).
    vi.mocked(stubResolver.resolveAndEnsure).mockResolvedValueOnce({ slug: undefined, projectId: undefined });
    const handler = createPostToolUseHandler({
      runRecorder: stubRecorder,
      projectSlugResolver: stubResolver,
      db: fakeDb,
    });
    const result = await handler(makeEvent());
    expect(result.permissionDecision).toBe('allow');
    expect(stubRecorder.recordPostToolUse).toHaveBeenCalledWith(expect.any(Object), undefined);
  });
});
