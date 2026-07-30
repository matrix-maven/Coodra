import type { AuthEnv } from '@coodra/shared/auth';
import { describe, expect, it, vi } from 'vitest';

import { buildApp, type DispatchHookEvent } from '../../src/app.js';

/**
 * End-to-end through the route → adapter → dispatch chain.
 *
 * Each agent's route gets exercised with a happy-path payload, a
 * malformed payload (Zod rejection → fail-open), and a non-JSON body
 * (parse rejection → fail-open). The dispatch callback is a vi.fn()
 * that captures the HookEvent the adapter produced — locks the wire
 * contract between adapter and downstream handlers.
 */

function makeEnv(): AuthEnv {
  return {
    COODRA_MODE: 'solo',
    CLERK_SECRET_KEY: 'sk_test_replace_me',
  };
}

describe('per-agent adapter dispatch on POST /v1/hooks/{agent}', () => {
  it('claude-code: happy path produces a HookEvent + ok response with hookSpecificOutput', async () => {
    const dispatch: DispatchHookEvent = vi.fn(async () => ({ permissionDecision: 'allow' as const }));
    const { hono } = buildApp({ env: makeEnv(), dispatch });

    const res = await hono.request('/v1/hooks/claude-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_name: 'Write',
        tool_input: { file_path: 'src/x.ts' },
        tool_use_id: 'tool-1',
        cwd: '/repo',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; hookSpecificOutput: { permissionDecision: string } };
    expect(body.ok).toBe(true);
    expect(body.hookSpecificOutput.permissionDecision).toBe('allow');

    expect(dispatch).toHaveBeenCalledTimes(1);
    const event = vi.mocked(dispatch).mock.calls[0]?.[0];
    expect(event).toMatchObject({
      agentType: 'claude_code',
      eventPhase: 'pre',
      sessionId: 'sess-1',
      toolName: 'Write',
      filePath: 'src/x.ts',
    });
  });

  it('windsurf: happy path produces a HookEvent + decision response', async () => {
    const dispatch: DispatchHookEvent = vi.fn(async () => ({ permissionDecision: 'allow' as const }));
    const { hono } = buildApp({ env: makeEnv(), dispatch });

    const res = await hono.request('/v1/hooks/windsurf', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_action_name: 'pre_write_code',
        trajectory_id: 'traj-1',
        execution_id: 'exec-1',
        tool_info: { file_path: 'src/x.ts' },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { decision: string };
    expect(body.decision).toBe('allow');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('cursor: happy path produces a HookEvent + decision response', async () => {
    const dispatch: DispatchHookEvent = vi.fn(async () => ({ permissionDecision: 'allow' as const }));
    const { hono } = buildApp({ env: makeEnv(), dispatch });

    const res = await hono.request('/v1/hooks/cursor', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversation_id: 'conv-1',
        event_type: 'pre_tool_use',
        tool_name: 'Edit',
        tool_call_id: 'call-1',
        tool_input: { file_path: 'src/x.ts' },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { decision: string };
    expect(body.decision).toBe('allow');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('codex: happy path produces a HookEvent + Codex hook response', async () => {
    const dispatch: DispatchHookEvent = vi.fn(async () => ({ permissionDecision: 'allow' as const }));
    const { hono } = buildApp({ env: makeEnv(), dispatch });

    const res = await hono.request('/v1/hooks/codex', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'thr-1',
        tool_name: 'apply_patch',
        tool_use_id: 'tool-1',
        tool_input: { file_path: 'src/x.ts' },
        cwd: '/repo',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { hookSpecificOutput: { permissionDecision: string } };
    expect(body.hookSpecificOutput.permissionDecision).toBe('allow');

    expect(dispatch).toHaveBeenCalledTimes(1);
    const event = vi.mocked(dispatch).mock.calls[0]?.[0];
    expect(event).toMatchObject({
      agentType: 'codex',
      eventPhase: 'pre',
      sessionId: 'thr-1',
      toolName: 'apply_patch',
      filePath: 'src/x.ts',
    });
  });

  it('codex: SessionStart additionalContext is returned in Codex hookSpecificOutput', async () => {
    const dispatch: DispatchHookEvent = vi.fn(async () => ({
      permissionDecision: 'allow' as const,
      additionalContext: 'Coodra context loaded.',
    }));
    const { hono } = buildApp({ env: makeEnv(), dispatch });

    const res = await hono.request('/v1/hooks/codex', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'thr-1',
        source: 'startup',
        cwd: '/repo',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(body.hookSpecificOutput).toEqual({
      hookEventName: 'SessionStart',
      additionalContext: 'Coodra context loaded.',
    });
  });

  it('claude-code: malformed payload (Zod rejection) → 200 + fail-open allow + reason invalid_hook_payload', async () => {
    const dispatch: DispatchHookEvent = vi.fn(async () => ({ permissionDecision: 'allow' as const }));
    const { hono } = buildApp({ env: makeEnv(), dispatch });

    const res = await hono.request('/v1/hooks/claude-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'NotAnEvent', session_id: 'sess' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(body.ok).toBe(true);
    expect(body.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(body.hookSpecificOutput.permissionDecisionReason).toBe('invalid_hook_payload');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('windsurf: non-JSON body → fail-open with decision=allow', async () => {
    const dispatch: DispatchHookEvent = vi.fn(async () => ({ permissionDecision: 'allow' as const }));
    const { hono } = buildApp({ env: makeEnv(), dispatch });

    const res = await hono.request('/v1/hooks/windsurf', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'this is not JSON',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { decision: string; reason: string };
    expect(body.decision).toBe('allow');
    expect(body.reason).toBe('invalid_hook_payload');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('windsurf: unmapped event (post_read_code) → ack with decision=allow + dispatch NOT called', async () => {
    const dispatch: DispatchHookEvent = vi.fn(async () => ({ permissionDecision: 'allow' as const }));
    const { hono } = buildApp({ env: makeEnv(), dispatch });

    const res = await hono.request('/v1/hooks/windsurf', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_action_name: 'post_read_code', trajectory_id: 'traj' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { decision: string };
    expect(body.decision).toBe('allow');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('claude-code: deny dispatch propagates to hookSpecificOutput', async () => {
    const dispatch: DispatchHookEvent = vi.fn(async () => ({
      permissionDecision: 'deny' as const,
      permissionDecisionReason: 'no writes to src/auth/**',
    }));
    const { hono } = buildApp({ env: makeEnv(), dispatch });

    const res = await hono.request('/v1/hooks/claude-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'sess',
        tool_name: 'Write',
        tool_input: { file_path: 'src/auth/index.ts' },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(body.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(body.hookSpecificOutput.permissionDecisionReason).toBe('no writes to src/auth/**');
  });
});
