import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createWikiStatusHandler, type WikiStatusHandlerDeps } from './handler.js';
import { type WikiStatusInput, wikiStatusInputSchema, wikiStatusOutputSchema } from './schema.js';

/**
 * Registration factory for `coodra__wiki_status` (Module 10 — Deep Wiki).
 * Read-only (idempotency kind 'readonly' — skips the DB dedupe path).
 * Factory-shaped for DB-handle injection, consistent with the sibling
 * wiki tools.
 */

const wikiStatusIdempotencyKey: IdempotencyKeyBuilder<WikiStatusInput> = (input) => {
  const wikiId = typeof input?.wikiId === 'string' && input.wikiId.length > 0 ? input.wikiId : 'unknown';
  return {
    kind: 'readonly',
    key: `readonly:wiki_status:${wikiId}`.slice(0, 200),
  };
};

export function createWikiStatusToolRegistration(
  deps: WikiStatusHandlerDeps,
): ToolRegistration<typeof wikiStatusInputSchema, typeof wikiStatusOutputSchema> {
  return {
    name: 'wiki_status',
    title: 'Coodra: wiki_status',
    description:
      'Call this to check Deep Wiki generation progress, or to resume the content pass after an interruption or in a ' +
      'later session. Given a wikiId, reports which pages are still pending versus authored so you know what to feed ' +
      'wiki_save_page next. Read-only — it makes no changes. Use it before looping over pages so you skip any already ' +
      'authored. Returns { ok: true, wikiId, slug, title, mode, pageCount, authoredCount, pendingCount, ' +
      'pendingPageIds, pages } or { ok: false, error: "wiki_not_found", howToFix }.',
    inputSchema: wikiStatusInputSchema,
    outputSchema: wikiStatusOutputSchema,
    idempotencyKey: wikiStatusIdempotencyKey,
    handler: createWikiStatusHandler(deps),
  };
}
