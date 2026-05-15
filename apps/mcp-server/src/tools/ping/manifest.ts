import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { pingHandler } from './handler.js';
import { type PingInput, pingInputSchema, pingOutputSchema } from './schema.js';

/**
 * Registration manifest for `coodra__ping`. This is the walking-
 * skeleton tool for Module 02 S5 — its only job is to prove the
 * tool-registration framework works end-to-end before S6–S15 land
 * the eight real `coodra__*` tools.
 *
 * The description below is deliberately written as a mini-prompt per
 * `system-architecture.md` §24.3 and `essentialsforclaude/05-agent-
 * trigger-contract.md`. It explains, in plain agent-directed prose,
 * when to call the tool, what it does, and what shape it returns —
 * even though `ping` is trivial, we model the full contract so
 * S6+ tools have a canonical example to copy.
 */
const pingIdempotencyKey: IdempotencyKeyBuilder<PingInput> = (input, ctx) => {
  // `ping` is read-only — no durable write happens. The `readonly:`
  // prefix tells the registry to skip DB-backed dedupe. The key
  // itself is still deterministic per (sessionId, echo) so two
  // identical retries within the same session collide in logs.
  const echoPart = input.echo ?? '';
  return {
    kind: 'readonly',
    key: `readonly:ping:${ctx.sessionId}:${echoPart}`.slice(0, 200),
  };
};

export const pingToolRegistration: ToolRegistration<typeof pingInputSchema, typeof pingOutputSchema> = {
  name: 'ping',
  title: 'Coodra: ping',
  description:
    'Call this tool when you need a zero-cost health check of the Coodra MCP server. ' +
    'ping does NOT read your project, touch the filesystem, hit the database, or consult the ' +
    'Policy Engine in any meaningful way — it simply round-trips a server timestamp, the session ' +
    'id the framework bound to your call, and the idempotency key the registry computed for your ' +
    'input. Use ping to verify the server is reachable before you run a longer sequence of ' +
    'coodra__* calls, or as the first step of any agent bootstrap so you fail loudly on a ' +
    'broken connection instead of several tools in. Returns { ok: true, pong: true, serverTime, ' +
    'sessionId, idempotencyKey, echo? } on success.',
  inputSchema: pingInputSchema,
  outputSchema: pingOutputSchema,
  idempotencyKey: pingIdempotencyKey,
  handler: pingHandler,
};
