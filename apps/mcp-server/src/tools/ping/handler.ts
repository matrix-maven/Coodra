import type { ToolContext } from '../../framework/tool-context.js';

import type { PingInput, PingOutput } from './schema.js';

/**
 * Handler for `coodra__ping`. Pure, synchronous in intent (still
 * `async` to match the framework contract that every handler is a
 * promise-returning function). Returns a deterministic envelope that
 * the registry will validate against `pingOutputSchema` before it
 * reaches the transport.
 *
 * The handler does NOT read `process.env`, write to stdout, hit the
 * database, or touch the filesystem — deliberately. `ping` is our
 * oracle: if a round-trip works end-to-end, we know the registration,
 * manifest-from-zod, policy wrapper, stdio transport, and pino-to-
 * stderr plumbing are all correct. Any domain side effect here would
 * weaken that signal.
 *
 * Clock discipline (S7a user directive): `serverTime` is derived
 * from `ctx.now()` rather than the global Date constructor. The
 * registry routes `ctx.now()` through its injected `clock`
 * function, letting tests freeze the clock and lock deterministic
 * output. A guard test in
 * `__tests__/unit/tools/_no-raw-date.test.ts` enforces the rule by
 * grepping every file under `src/tools/**` and failing CI if any
 * handler reintroduces a raw Date constructor call.
 */
export async function pingHandler(input: PingInput, ctx: ToolContext): Promise<PingOutput> {
  return {
    ok: true,
    pong: true,
    serverTime: ctx.now().toISOString(),
    sessionId: ctx.sessionId,
    idempotencyKey: ctx.idempotencyKey.key,
    ...(input.echo !== undefined ? { echo: input.echo } : {}),
  };
}
