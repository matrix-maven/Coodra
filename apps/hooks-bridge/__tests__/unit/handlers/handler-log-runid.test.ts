import type { DbHandle } from '@coodra/db';
import { createPolicyClientFromCheck } from '@coodra/policy';
import type { HookEvent } from '@coodra/shared/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F15 closure (verification 2026-04-27 — Phase 7 logger correlation).
 *
 * The pre-tool-use and post-tool-use handlers must call
 * `@coodra/db::lookupRunId` synchronously on the hot path so the
 * INFO log line carries `runId`. The actual log-output assertion is
 * impractical in vitest (pino uses sonic-boom and bypasses
 * process.stdout.write), so this suite mocks `lookupRunId` to verify:
 *
 *   - The handler awaits the lookup before returning.
 *   - The lookup is called with `(db, projectId, sessionId)` — i.e.,
 *     the resolved projectId or `__global__` fallback.
 *   - When projectId resolves, the lookup uses the real projectId.
 *   - When projectId is undefined, the lookup falls back to
 *     `__global__` (matches the F7 sentinel-project pattern).
 */

const lookupRunIdMock = vi.fn<(db: DbHandle, projectId: string, sessionId: string) => Promise<string | null>>();

vi.mock('@coodra/db', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    lookupRunId: (db: DbHandle, projectId: string, sessionId: string) => lookupRunIdMock(db, projectId, sessionId),
  };
});

// Imports MUST follow the vi.mock() so the handlers see the mocked
// lookupRunId at module-load time.
const { createPreToolUseHandler } = await import('../../../src/handlers/pre-tool-use.js');
const { createPostToolUseHandler } = await import('../../../src/handlers/post-tool-use.js');

const stubDb = {} as DbHandle;

// M04 Phase 2 S1 (F3): handlers now call resolveAndEnsure on the audit
// path. The unit-test stubs return the same shape for both methods.
const slugResolverProj = {
  resolve: vi.fn(async () => ({ slug: 'p', projectId: 'proj_42' })),
  resolveAndEnsure: vi.fn(async () => ({ slug: 'p', projectId: 'proj_42' })),
  invalidate: vi.fn(),
};
const slugResolverNoProj = {
  resolve: vi.fn(async () => ({ slug: undefined, projectId: undefined })),
  resolveAndEnsure: vi.fn(async () => ({ slug: undefined, projectId: undefined })),
  invalidate: vi.fn(),
};

const stubRecorder = {
  recordPolicyDecision: vi.fn(),
  recordPostToolUse: vi.fn(),
  recordUserPromptSubmit: vi.fn(),
  recordSessionStart: vi.fn(),
  recordSessionEnd: vi.fn(),
};

function makePreEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    agentType: 'claude_code',
    eventPhase: 'pre',
    sessionId: 'sess-f15',
    toolName: 'Write',
    toolInput: { file_path: 'src/x.ts' },
    rawAt: '2026-04-27T12:00:00.000Z',
    ...overrides,
  };
}

function makePostEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    agentType: 'claude_code',
    eventPhase: 'post',
    sessionId: 'sess-f15',
    toolName: 'Write',
    toolInput: { file_path: 'src/x.ts' },
    rawAt: '2026-04-27T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  lookupRunIdMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('F15 — pre-tool-use handler does sync lookupRunId', () => {
  it('calls lookupRunId with (db, projectId, sessionId) when projectId resolves', async () => {
    lookupRunIdMock.mockResolvedValue('run_abc');
    const policy = createPolicyClientFromCheck(async () => ({
      decision: 'allow',
      reason: 'no_rule_matched',
      matchedRuleId: null,
    }));
    const handler = createPreToolUseHandler({
      policy,
      projectSlugResolver: slugResolverProj,
      db: stubDb,
      runRecorder: stubRecorder,
    });
    await handler(makePreEvent());

    expect(lookupRunIdMock).toHaveBeenCalledTimes(1);
    expect(lookupRunIdMock).toHaveBeenCalledWith(stubDb, 'proj_42', 'sess-f15');
  });

  it('falls back to __global__ when projectId is undefined', async () => {
    lookupRunIdMock.mockResolvedValue(null);
    const policy = createPolicyClientFromCheck(async () => ({
      decision: 'allow',
      reason: 'no_rule_matched',
      matchedRuleId: null,
    }));
    const handler = createPreToolUseHandler({
      policy,
      projectSlugResolver: slugResolverNoProj,
      db: stubDb,
      runRecorder: stubRecorder,
    });
    await handler(makePreEvent());

    expect(lookupRunIdMock).toHaveBeenCalledWith(stubDb, '__global__', 'sess-f15');
  });

  it('does NOT call lookupRunId on event_phase_mismatch (defensive early-return)', async () => {
    lookupRunIdMock.mockResolvedValue(null);
    const policy = createPolicyClientFromCheck(async () => ({
      decision: 'deny',
      reason: 'should not be called',
      matchedRuleId: 'r',
    }));
    const handler = createPreToolUseHandler({
      policy,
      projectSlugResolver: slugResolverProj,
      db: stubDb,
      runRecorder: stubRecorder,
    });
    await handler(makePreEvent({ eventPhase: 'post' }));

    expect(lookupRunIdMock).not.toHaveBeenCalled();
  });

  it('lookupRunId throwing does not break the handler — falls through to allow + logs without runId', async () => {
    lookupRunIdMock.mockRejectedValue(new Error('DB connection lost'));
    const policy = createPolicyClientFromCheck(async () => ({
      decision: 'allow',
      reason: 'no_rule_matched',
      matchedRuleId: null,
    }));
    const handler = createPreToolUseHandler({
      policy,
      projectSlugResolver: slugResolverProj,
      db: stubDb,
      runRecorder: stubRecorder,
    });
    const result = await handler(makePreEvent());
    // Decision propagates; lookup failure is non-fatal.
    expect(result.permissionDecision).toBe('allow');
  });
});

describe('F15 — post-tool-use handler does sync lookupRunId', () => {
  it('calls lookupRunId with (db, projectId, sessionId) when projectId resolves', async () => {
    lookupRunIdMock.mockResolvedValue('run_xyz');
    const handler = createPostToolUseHandler({
      runRecorder: stubRecorder,
      projectSlugResolver: slugResolverProj,
      db: stubDb,
    });
    await handler(makePostEvent());

    expect(lookupRunIdMock).toHaveBeenCalledTimes(1);
    expect(lookupRunIdMock).toHaveBeenCalledWith(stubDb, 'proj_42', 'sess-f15');
  });

  it('falls back to __global__ when projectId is undefined', async () => {
    lookupRunIdMock.mockResolvedValue(null);
    const handler = createPostToolUseHandler({
      runRecorder: stubRecorder,
      projectSlugResolver: slugResolverNoProj,
      db: stubDb,
    });
    await handler(makePostEvent());

    expect(lookupRunIdMock).toHaveBeenCalledWith(stubDb, '__global__', 'sess-f15');
  });

  it('does NOT call lookupRunId on event_phase_mismatch (defensive early-return)', async () => {
    lookupRunIdMock.mockResolvedValue(null);
    const handler = createPostToolUseHandler({
      runRecorder: stubRecorder,
      projectSlugResolver: slugResolverProj,
      db: stubDb,
    });
    await handler(makePostEvent({ eventPhase: 'pre' }));

    expect(lookupRunIdMock).not.toHaveBeenCalled();
  });
});
