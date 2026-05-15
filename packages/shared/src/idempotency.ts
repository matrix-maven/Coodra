import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { ValidationError } from './errors/index.js';

/**
 * Zod schema for any segment that participates in a run-key encoding —
 * the shape `run:{projectId}:{sessionId}:{uuid}`. Used at the registry
 * boundary so callers get a structured `invalid_input` envelope instead
 * of a buried `handler_threw` when they pass a colon-bearing sessionId.
 *
 * Closes verification finding §8.6 — the no-colon constraint used to
 * live only in `assertRunKeySegment` (called from `generateRunKey`),
 * which throws after the handler enters and produces a `handler_threw`
 * envelope. Surfacing the constraint as a Zod schema means the
 * registry can validate at the boundary before any handler runs.
 *
 * The runtime `assertRunKeySegment` helper below is kept as a defensive
 * second line for any code path that bypasses the registry.
 */
export const runKeySegmentSchema = z
  .string()
  .min(1, 'segment must be non-empty')
  .refine((s) => !s.includes(':'), { message: "segment must not contain ':' (run-key separator)" });

/**
 * Idempotency-key helpers whose output shapes match
 * `system-architecture.md` §4.3 exactly:
 *
 *   runs        → `run:{projectId}:{sessionId}:{uuid}`
 *   run_events  → `{sessionId}-{toolUseId}-{phase}`
 *
 * These keys become the unique constraint on the matching database tables.
 * Retries (network timeouts, agent retries, hook re-delivery) must produce
 * the **same** key for the same logical event — that is the whole point of
 * an idempotency key.
 *
 * - `generateRunKey` includes a UUID v4 because a run is intrinsically
 *   unique per (project, session, new conversation). The agent or the
 *   caller never retries a `get_run_id` — a retry must yield a *new* run.
 *
 * - `generateRunEventKey` is deterministic for stable inputs because the
 *   hooks bridge may re-deliver the same PreToolUse/PostToolUse event and
 *   we must dedupe against the first write.
 *
 * A later unit test asserts these shapes via regex and fails the build
 * on any drift (amendment A of the user-approved bootstrap plan). Future
 * additions (e.g. `generatePolicyDecisionKey`) ship with Module 02.
 */

/** Tool-use phase emitted by hook bridges; see §3.2–§3.3. */
export type RunPhase = 'pre' | 'post';

/** Regex literal of the shape produced by `generateRunKey`. Export for tests. */
export const RUN_KEY_PATTERN = /^run:[^:]+:[^:]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Regex literal of the shape produced by `generateRunEventKey`. Export for tests. */
export const RUN_EVENT_KEY_PATTERN = /^[^:-]+-[^:-]+-(pre|post)$/;

export interface GenerateRunKeyArgs {
  readonly projectId: string;
  readonly sessionId: string;
}

export interface GenerateRunEventKeyArgs {
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly phase: RunPhase;
}

/**
 * Returns `run:{projectId}:{sessionId}:{uuid v4}`.
 *
 * `projectId` and `sessionId` must be non-empty strings that do not contain
 * `':'` — the colon is the structural separator for this key.
 *
 * @throws {ValidationError} if either segment is empty or contains a colon.
 */
export function generateRunKey(args: GenerateRunKeyArgs): string {
  assertRunKeySegment(args.projectId, 'projectId');
  assertRunKeySegment(args.sessionId, 'sessionId');
  return `run:${args.projectId}:${args.sessionId}:${randomUUID()}`;
}

/**
 * Returns `{sessionId}-{toolUseId}-{phase}` with `phase ∈ {'pre','post'}`.
 *
 * Deterministic: the same inputs always produce the same key, which is how
 * hook-bridge redelivery is deduped in the `run_events` unique index.
 *
 * `sessionId` and `toolUseId` must be non-empty strings that do not contain
 * either `'-'` or `':'` — both characters are structural separators in
 * Coodra idempotency keys.
 *
 * @throws {ValidationError} if either segment is empty or contains a forbidden char.
 */
export function generateRunEventKey(args: GenerateRunEventKeyArgs): string {
  assertRunEventKeySegment(args.sessionId, 'sessionId');
  assertRunEventKeySegment(args.toolUseId, 'toolUseId');
  if (args.phase !== 'pre' && args.phase !== 'post') {
    throw new ValidationError(`phase must be 'pre' or 'post', got: ${String(args.phase)}`);
  }
  return `${args.sessionId}-${args.toolUseId}-${args.phase}`;
}

function assertRunKeySegment(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  if (value.includes(':')) {
    throw new ValidationError(`${field} must not contain ':' (run-key separator)`);
  }
}

function assertRunEventKeySegment(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  if (value.includes(':') || value.includes('-')) {
    throw new ValidationError(`${field} must not contain ':' or '-' (run-event-key separators)`);
  }
}

/**
 * Discriminated idempotency-key shape used by every consumer that
 * computes an idempotency key for a tool / hook call.
 *
 * Module 03 S3 moved this type from `apps/mcp-server/src/framework/
 * idempotency.ts` here so the cross-package `PolicyInput` type (in
 * `@coodra/policy/types`) can reference it without depending on
 * the mcp-server-specific framework. The mcp-server framework keeps
 * its `IdempotencyKeyBuilder<Input>` + `IdempotencyContext` +
 * `assertIdempotencyKeyBuilder` helpers (those are tool-registration
 * concerns); only the wire-level value-shape moves.
 *
 *   `kind: 'readonly'` — caller does not perform durable writes.
 *   `kind: 'mutating'` — handler will INSERT/UPDATE; the key is the
 *      ON CONFLICT target.
 *
 * Length constraint (≤ 200 chars) is enforced by the runtime probe in
 * mcp-server's framework, not here, because it's a framework rule
 * rather than a wire-shape rule.
 */
export type IdempotencyKey =
  | { readonly kind: 'readonly'; readonly key: string }
  | { readonly kind: 'mutating'; readonly key: string };
