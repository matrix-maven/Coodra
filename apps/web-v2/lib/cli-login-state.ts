import 'server-only';

/**
 * `apps/web-v2/lib/cli-login-state.ts` — single-use replay protection
 * for the `/auth/cli-login` browser-handoff flow.
 *
 * Each `coodra login` invocation mints a random `state` token and
 * passes it through the URL. The web echoes it back to the loopback
 * URL. The CLI verifies state matches before accepting the token.
 *
 * This module provides defense-in-depth: a `state` value can be
 * "consumed" exactly once on the web side. If an attacker captures
 * the cli-login URL and tries to replay it, the second hit gets
 * `state_already_consumed`.
 *
 * Limitations:
 *
 *   • In-memory only. A multi-replica team-hosted deployment loses
 *     the consumption record on process restart. That's OK because
 *     the legitimate flow consumes state exactly once before the
 *     redirect; the worst-case replay window is the period between
 *     consume + restart, typically seconds.
 *
 *   • No cross-replica coordination. Two replicas can each consume
 *     the same state once. Still strictly fewer reuses than no
 *     protection at all. If a real Phase-G+1 team needs cross-replica
 *     replay protection, swap this for Redis with SETNX.
 *
 * TTL: 5 minutes per state. After TTL, the record is GC'd to bound
 * memory growth; an unused state that times out behaves the same as
 * one that was never minted (next consume attempt is "first" → succeeds).
 * Since the CLI's loopback listener has its own 5min timeout, the
 * windows match.
 */

const TTL_MS = 5 * 60 * 1000;

interface ConsumedRecord {
  readonly consumedAt: number;
}

const consumed = new Map<string, ConsumedRecord>();

/**
 * Atomically check + record consumption. Returns `true` on first use
 * (caller proceeds), `false` on replay (caller refuses).
 *
 * The check is racy across event-loop ticks but this is OK in practice:
 * Node.js is single-threaded, and a real race would require two
 * concurrent requests to call this within the same microtask, which
 * doesn't happen for browser-initiated flows.
 */
export function consumeCliLoginState(state: string): boolean {
  gcExpired();
  if (consumed.has(state)) return false;
  consumed.set(state, { consumedAt: Date.now() });
  return true;
}

function gcExpired(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [state, record] of consumed.entries()) {
    if (record.consumedAt < cutoff) {
      consumed.delete(state);
    }
  }
}

/**
 * Test-only — reset the consumption map. Production code never calls
 * this; it's exposed so vitest can isolate test cases.
 */
export function __resetCliLoginStateForTest(): void {
  consumed.clear();
}

/**
 * Returns the number of currently-tracked state records. Test helper.
 */
export function __cliLoginStateCount(): number {
  gcExpired();
  return consumed.size;
}
