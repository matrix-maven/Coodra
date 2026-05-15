import { createLogger } from '@coodra/shared';
import {
  type AuthEnv,
  type Identity,
  SOLO_IDENTITY,
  verifyClerkJwt,
  verifyLocalHookSecret,
} from '@coodra/shared/auth';
import type { Context, MiddlewareHandler } from 'hono';

/**
 * `apps/hooks-bridge/src/lib/auth-middleware.ts` — Hono middleware
 * implementing the three-layer auth chain from
 * `system-architecture.md` §19, sourced from `@coodra/shared/auth`.
 *
 * Order locked by Module 02 decisions-log 2026-04-22 Q-02-1:
 *   (1) solo-bypass    — CLERK_SECRET_KEY === 'sk_test_replace_me'
 *   (2) X-Local-Hook   — header value matches LOCAL_HOOK_SECRET
 *   (3) Clerk JWT      — Authorization: Bearer <token>
 *
 * First match wins. No match → 401.
 *
 * On success: attaches the resolved Identity to the Hono context's
 * variable map under the key `identity`. Downstream handlers read it
 * via `c.get('identity')`.
 */

const SOLO_BYPASS_CLERK_SENTINEL = 'sk_test_replace_me' as const;

const authLogger = createLogger('hooks-bridge.auth-middleware');

export interface AuthMiddlewareDeps {
  readonly env: AuthEnv;
  readonly localHookSecret?: string | undefined;
}

declare module 'hono' {
  interface ContextVariableMap {
    identity: Identity;
  }
}

export function createAuthChainMiddleware(deps: AuthMiddlewareDeps): MiddlewareHandler {
  const { env, localHookSecret } = deps;
  // Solo-bypass triggers when EITHER signal says solo:
  //   - CLERK_SECRET_KEY is the literal sentinel, OR
  //   - COODRA_MODE is 'solo' (the canonical mode signal)
  // The MCP server's HTTP transport uses the same disjunction. Asymmetry
  // here previously broke the out-of-the-box flow: `coodra init` writes
  // .env with COODRA_MODE=solo + the sentinel, but `coodra start`
  // doesn't dotenv-load the file, so neither var reached the daemon and
  // every hook event 401'd.
  const isSoloBypass = env.CLERK_SECRET_KEY === SOLO_BYPASS_CLERK_SENTINEL || env.COODRA_MODE === 'solo';

  return async function authChain(c: Context, next) {
    // (1) solo-bypass — sentinel set or mode=solo; no header parsing required.
    if (isSoloBypass) {
      c.set('identity', SOLO_IDENTITY);
      return next();
    }

    // (2) X-Local-Hook-Secret — adapter scripts use this path.
    const presented = c.req.header('x-local-hook-secret');
    if (presented !== undefined && localHookSecret !== undefined && verifyLocalHookSecret(presented, localHookSecret)) {
      c.set('identity', {
        userId: 'local-hook-client',
        orgId: null,
        source: 'local-hook',
      });
      return next();
    }

    // (3) Clerk JWT — Authorization: Bearer <token>
    const authHeader = c.req.header('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice('Bearer '.length).trim();
      try {
        const identity = await verifyClerkJwt(token, env);
        c.set('identity', identity);
        return next();
      } catch (err) {
        authLogger.warn(
          { event: 'clerk_verify_failed', err: err instanceof Error ? err.message : String(err) },
          'Clerk JWT verification failed; falling through to 401',
        );
        // Fall through to 401.
      }
    }

    return c.json({ ok: false, error: 'unauthorized' }, 401);
  };
}
