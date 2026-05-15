import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createGetRunIdHandler, type GetRunIdHandlerDeps } from './handler.js';
import { type GetRunIdInput, getRunIdInputSchema, getRunIdOutputSchema } from './schema.js';

/**
 * Registration factory for `coodra__get_run_id`.
 *
 * Factory-shaped rather than a static constant because the handler
 * closes over the process's boot-time `DbHandle` and `COODRA_MODE`
 * (user directive Q1 + Q2 2026-04-24). `src/tools/index.ts::registerAllTools`
 * is the single caller that supplies these deps; test code constructs
 * its own fakes.
 *
 * Description below is verbatim from `system-architecture.md §24.4`.
 * The §24.3 description-anatomy assertion in
 * `@coodra/shared/test-utils::assertManifestDescriptionValid` is
 * the CI guard that this string stays within the rules (imperative
 * opener, 40–120 words, mentions Returns).
 */

const getRunIdIdempotencyKey: IdempotencyKeyBuilder<GetRunIdInput> = (input, ctx) => {
  // get_run_id may write a `runs` row — mutating kind. Key uses the
  // CALLER-supplied `projectSlug` rather than the internally-resolved
  // `projectId` so a retry with the same tool input dedupes in the
  // registry's logs regardless of whether the solo-auto-create
  // branch ran between calls (user directive Q5 2026-04-24).
  //
  // F9 closure (2026-04-27): when the caller passes `agentSessionId`,
  // use it as the session-binding segment so the registry's
  // dedupe matches the runs.id resolution path. Without it, retries
  // could collide on `ctx.sessionId` (transport-default) even when
  // the caller intended a different agent session.
  //
  // The `.slice(0, 200)` matches the ping tool's registration
  // contract cap so the registry's key-length invariant holds for
  // long project slugs.
  const slug = typeof input?.projectSlug === 'string' && input.projectSlug.length > 0 ? input.projectSlug : 'probe';
  const sessionSegment =
    typeof input?.agentSessionId === 'string' && input.agentSessionId.length > 0 ? input.agentSessionId : ctx.sessionId;
  return {
    kind: 'mutating',
    key: `get_run_id:${slug}:${sessionSegment}`.slice(0, 200),
  };
};

export function createGetRunIdToolRegistration(
  deps: GetRunIdHandlerDeps,
): ToolRegistration<typeof getRunIdInputSchema, typeof getRunIdOutputSchema> {
  return {
    name: 'get_run_id',
    title: 'Coodra: get_run_id',
    description:
      'Call this at the START of any session that will write code, if the current runId is not already in context ' +
      "from a session-start hook. Returns the current in-progress session's runId (UUID) which binds all subsequent " +
      'tool calls, decisions, and context packs to a single durable record. Most other tools accept this runId as an ' +
      'argument. Call once per session and reuse the value. Pass agentSessionId (your hook session_id) + agentType ' +
      'so the bridge SessionStart row and this call resolve to ONE runs row. Unknown projectSlug: solo mode auto- ' +
      'creates; team mode returns { ok: false, error: "project_not_found", howToFix }.',
    inputSchema: getRunIdInputSchema,
    outputSchema: getRunIdOutputSchema,
    idempotencyKey: getRunIdIdempotencyKey,
    handler: createGetRunIdHandler(deps),
  };
}
