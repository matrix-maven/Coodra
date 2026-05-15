import type { IdempotencyKey } from '@coodra/shared';

/**
 * Per-tool idempotency-key builder contract.
 *
 * `system-architecture.md` §4.3 and §16 pattern 3 require that every
 * mutating tool call be idempotent: retries with the same inputs must
 * not produce duplicate side effects (duplicate runs, duplicate
 * context_packs rows, etc.). The durable enforcement lives in the
 * database — unique indexes on `idempotency_key` columns in `runs`,
 * `context_packs`, `policy_decisions`, and the `pending_jobs` outbox
 * — but the server needs a deterministic way to compute the key that
 * goes into each insert.
 *
 * The tool-registration framework takes that "deterministic way"
 * as an object of this shape. It is **required** at registration
 * time: no handler is allowed to run without one. Read-only tools
 * (e.g. `get_feature_pack`, `ping`) opt out of durable writes by
 * returning a key that starts with the literal prefix `'readonly:'`;
 * the registration framework recognises that prefix and skips the
 * database-backed dedupe path. It does NOT skip the builder itself —
 * the key is still emitted so every call carries a trace id.
 *
 * Constraints:
 *   1. Pure: same `(input, ctx)` must produce the same key byte-for-
 *      byte. No `Date.now()`, no `crypto.randomUUID()`. Idempotency
 *      only works if the key is a pure function of the caller's
 *      request. Retries with the same inputs MUST collide.
 *   2. Small: ≤ 200 chars so it fits comfortably in a Postgres
 *      `text` column's B-tree index without being truncated by
 *      operator tooling.
 *   3. Opaque: treat the key as an opaque identifier, not a
 *      structured data carrier. Debugging-friendly prefixes
 *      (`run:`, `ctx:`, `dec:`, `readonly:`) are fine, but callers
 *      must not parse these apart — the DB is the authority.
 */

/**
 * Context passed to every idempotency-key builder at call time.
 * Shape is intentionally narrow; anything a builder needs beyond
 * these fields must be derivable from the typed tool input.
 */
export interface IdempotencyContext {
  /**
   * Opaque session id from the MCP client. `stdio` transport sets
   * this to the stdin/stdout pair id; `http` transport sets it to
   * the JWT `sub` or to a generated request-scoped id for unauth'd
   * calls. Stable across retries within one session.
   */
  readonly sessionId: string;
  /**
   * Timestamp the request was received. Builders should NOT use
   * this field; it is exposed so handlers that need it for row
   * timestamps can read it without pulling Date themselves. Using
   * it inside a builder would break the purity contract above —
   * the framework's unit test locks that.
   */
  readonly receivedAt: Date;
}

/**
 * Signature every tool registration must declare.
 *
 * Returns a discriminated-shape result rather than a bare string so the
 * framework can statically distinguish read-only calls (which skip DB
 * dedupe) from mutating ones. Read-only → `{ kind: 'readonly', key }`;
 * mutating → `{ kind: 'mutating', key }` (the framework forwards the
 * key to the handler's call context and expects DB operations to use it
 * for ON CONFLICT dedupe).
 */
export type IdempotencyKeyBuilder<Input> = (input: Input, ctx: IdempotencyContext) => IdempotencyKey;

// `IdempotencyKey` (the discriminated value-shape) moved to
// `@coodra/shared/idempotency` in Module 03 S3 so the cross-package
// `PolicyInput` (in `@coodra/policy`) can reference it without
// depending on this mcp-server-specific framework. The framework-level
// `IdempotencyKeyBuilder<Input>` + `IdempotencyContext` +
// `assertIdempotencyKeyBuilder` helpers stay here — those are tool-
// registration concerns, not wire-shape concerns. New consumers
// import from `@coodra/shared`.
export type { IdempotencyKey };

/**
 * Runtime validator — called at registration time by the registry.
 * Rejects builders that clearly break the contract (not a function,
 * wrong arity, returns malformed value on a smoke-test input).
 *
 * A pure function check is impossible at runtime; we settle for
 * "does it return a well-shaped key given a well-shaped input" and
 * document purity in the JSDoc above. A follow-up slice can add a
 * determinism test that calls the builder twice and asserts the
 * two keys match — for S5 we rely on review + the per-tool unit
 * test.
 */
export function assertIdempotencyKeyBuilder<I>(
  builder: IdempotencyKeyBuilder<I>,
  probe: { input: I; ctx: IdempotencyContext },
): void {
  if (typeof builder !== 'function') {
    throw new TypeError('idempotencyKey builder must be a function');
  }
  if (builder.length < 1 || builder.length > 2) {
    throw new TypeError(`idempotencyKey builder must take 1 or 2 args (input[, ctx]); got ${builder.length}`);
  }
  const probeResult = builder(probe.input, probe.ctx);
  if (
    typeof probeResult !== 'object' ||
    probeResult === null ||
    (probeResult.kind !== 'readonly' && probeResult.kind !== 'mutating') ||
    typeof probeResult.key !== 'string' ||
    probeResult.key.length === 0 ||
    probeResult.key.length > 200
  ) {
    throw new TypeError(
      `idempotencyKey builder returned an invalid key: ${JSON.stringify(probeResult)}. ` +
        "Expected { kind: 'readonly' | 'mutating', key: string (1..200 chars) }.",
    );
  }
}
