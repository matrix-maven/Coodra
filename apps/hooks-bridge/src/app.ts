import { createLogger } from '@coodra/contextos-shared';
import type { AuthEnv } from '@coodra/contextos-shared/auth';
import {
  adaptClaudeCode,
  adaptCursor,
  adaptWindsurf,
  ClaudeCodeHookPayloadSchema,
  CursorHookPayloadSchema,
  type HookEvent,
  WindsurfHookPayloadSchema,
} from '@coodra/contextos-shared/hooks';
import { Hono } from 'hono';

import { createAuthChainMiddleware } from './lib/auth-middleware.js';

/**
 * `apps/hooks-bridge/src/app.ts` — Hono app builder.
 *
 * S6 scope: per-agent payload validation + adapter dispatch +
 * fail-open on bad bodies. S7+ wires the real pre-tool policy /
 * post-tool RunRecorder / SessionStart / Stop / UserPromptSubmit
 * handlers behind the `dispatch(event)` callback.
 *
 * The builder takes deps as a parameter so test fixtures can inject
 * mock env / mock secrets / mock dispatch without going through
 * process.env.
 */

const appLogger = createLogger('hooks-bridge.app');

/**
 * S6 placeholder. Returns the structured response the agent expects
 * (Claude Code uses `hookSpecificOutput`; Windsurf and Cursor use
 * `{ decision, reason? }`). S7 replaces this with the policy
 * evaluator + per-agent decision translator.
 */
export type DispatchHookEvent = (event: HookEvent | null) => Promise<HookDispatchResult>;

export interface HookDispatchResult {
  /** What the agent should do — always 'allow' under the stub. */
  readonly permissionDecision: 'allow' | 'deny' | 'ask';
  readonly permissionDecisionReason?: string;
  /**
   * Optional Markdown blob the bridge wants Claude Code to fold into
   * the agent's turn-zero context (decision dec_83ba10c1, 2026-05-02
   * — system-architecture §16 Pattern 20). Currently emitted only by
   * the SessionStart handler with the project's Feature Pack body.
   * The Claude Code adapter forwards this verbatim to
   * `hookSpecificOutput.additionalContext`. Cursor and Windsurf
   * adapters ignore the field — neither's hook envelope has a first-
   * class context-injection slot.
   */
  readonly additionalContext?: string;
}

const allowAllDispatcher: DispatchHookEvent = async () => ({ permissionDecision: 'allow' });

export interface BuildAppDeps {
  readonly env: AuthEnv;
  readonly localHookSecret?: string | undefined;
  readonly serverStartedAt?: Date;
  /** Pluggable dispatch — defaults to always-allow. S7 wires the real handler. */
  readonly dispatch?: DispatchHookEvent;
}

export interface AppHandle {
  readonly hono: Hono;
  readonly serverStartedAt: Date;
}

/** Shared fail-open response when a payload doesn't parse. */
function failOpen(
  reason: string,
  hookEventName?: string,
): {
  ok: true;
  hookSpecificOutput: { hookEventName?: string; permissionDecision: 'allow'; permissionDecisionReason: string };
  decision: 'allow';
  reason: string;
} {
  return {
    ok: true,
    hookSpecificOutput: {
      ...(hookEventName !== undefined ? { hookEventName } : {}),
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
    },
    decision: 'allow',
    reason,
  };
}

export function buildApp(deps: BuildAppDeps): AppHandle {
  const serverStartedAt = deps.serverStartedAt ?? new Date();
  const dispatch = deps.dispatch ?? allowAllDispatcher;
  const hono = new Hono();

  // ---------------------------------------------------------------------
  // GET /healthz — no auth.
  // ---------------------------------------------------------------------
  hono.get('/healthz', (c) =>
    c.json({
      ok: true,
      service: 'hooks-bridge',
      mode: deps.env.CONTEXTOS_MODE ?? 'solo',
      serverStartedAt: serverStartedAt.toISOString(),
    }),
  );

  // ---------------------------------------------------------------------
  // Authed routes group.
  // ---------------------------------------------------------------------
  const auth = createAuthChainMiddleware({
    env: deps.env,
    ...(deps.localHookSecret !== undefined ? { localHookSecret: deps.localHookSecret } : {}),
  });

  // ---------------------------------------------------------------------
  // POST /v1/hooks/claude-code
  // ---------------------------------------------------------------------
  hono.post('/v1/hooks/claude-code', auth, async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      appLogger.warn({ event: 'invalid_hook_body', agent: 'claude_code' }, 'request body is not JSON; failing open');
      return c.json(failOpen('invalid_hook_payload'));
    }
    const parse = ClaudeCodeHookPayloadSchema.safeParse(raw);
    if (!parse.success) {
      appLogger.warn(
        { event: 'invalid_hook_payload', agent: 'claude_code', issues: parse.error.issues },
        'Claude Code payload failed Zod parse; failing open',
      );
      return c.json(failOpen('invalid_hook_payload'));
    }
    const event = adaptClaudeCode(parse.data);
    appLogger.info(
      {
        event: 'hook_ingress',
        agent: event.agentType,
        eventPhase: event.eventPhase,
        sessionId: event.sessionId,
        toolName: event.toolName,
      },
      'hook ingress',
    );
    const result = await dispatch(event);
    return c.json({
      ok: true,
      hookSpecificOutput: {
        hookEventName: parse.data.hook_event_name,
        permissionDecision: result.permissionDecision,
        ...(result.permissionDecisionReason !== undefined
          ? { permissionDecisionReason: result.permissionDecisionReason }
          : {}),
        // Pattern 20 (decision dec_83ba10c1, 2026-05-02): SessionStart
        // returns the project's Feature Pack body in this slot so the
        // agent receives full project context at turn zero without
        // calling `contextos__get_feature_pack` itself.
        ...(result.additionalContext !== undefined ? { additionalContext: result.additionalContext } : {}),
      },
    });
  });

  // ---------------------------------------------------------------------
  // POST /v1/hooks/windsurf
  // ---------------------------------------------------------------------
  hono.post('/v1/hooks/windsurf', auth, async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      appLogger.warn({ event: 'invalid_hook_body', agent: 'windsurf' }, 'request body is not JSON; failing open');
      return c.json({ decision: 'allow', reason: 'invalid_hook_payload' });
    }
    const parse = WindsurfHookPayloadSchema.safeParse(raw);
    if (!parse.success) {
      appLogger.warn(
        { event: 'invalid_hook_payload', agent: 'windsurf', issues: parse.error.issues },
        'Windsurf payload failed Zod parse; failing open',
      );
      return c.json({ decision: 'allow', reason: 'invalid_hook_payload' });
    }
    const event = adaptWindsurf(parse.data);
    if (event === null) {
      // Unmapped event — ack but don't dispatch.
      return c.json({ decision: 'allow' });
    }
    appLogger.info(
      {
        event: 'hook_ingress',
        agent: event.agentType,
        eventPhase: event.eventPhase,
        sessionId: event.sessionId,
        toolName: event.toolName,
      },
      'hook ingress',
    );
    const result = await dispatch(event);
    return c.json({
      decision: result.permissionDecision === 'deny' ? 'deny' : 'allow',
      ...(result.permissionDecisionReason !== undefined ? { reason: result.permissionDecisionReason } : {}),
    });
  });

  // ---------------------------------------------------------------------
  // POST /v1/hooks/cursor
  // ---------------------------------------------------------------------
  hono.post('/v1/hooks/cursor', auth, async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      appLogger.warn({ event: 'invalid_hook_body', agent: 'cursor' }, 'request body is not JSON; failing open');
      return c.json({ decision: 'allow', reason: 'invalid_hook_payload' });
    }
    const parse = CursorHookPayloadSchema.safeParse(raw);
    if (!parse.success) {
      appLogger.warn(
        { event: 'invalid_hook_payload', agent: 'cursor', issues: parse.error.issues },
        'Cursor payload failed Zod parse; failing open',
      );
      return c.json({ decision: 'allow', reason: 'invalid_hook_payload' });
    }
    const event = adaptCursor(parse.data);
    appLogger.info(
      {
        event: 'hook_ingress',
        agent: event.agentType,
        eventPhase: event.eventPhase,
        sessionId: event.sessionId,
        toolName: event.toolName,
      },
      'hook ingress',
    );
    const result = await dispatch(event);
    return c.json({
      decision: result.permissionDecision === 'deny' ? 'deny' : 'allow',
      ...(result.permissionDecisionReason !== undefined ? { reason: result.permissionDecisionReason } : {}),
    });
  });

  return { hono, serverStartedAt };
}
