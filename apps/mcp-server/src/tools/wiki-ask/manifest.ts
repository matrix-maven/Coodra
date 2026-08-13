import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createWikiAskHandler, type WikiAskHandlerDeps } from './handler.js';
import { type WikiAskInput, wikiAskInputSchema, wikiAskOutputSchema } from './schema.js';

/**
 * Registration factory for `coodra__wiki_ask` (COOD-30). Read-only
 * (idempotency kind 'readonly' — skips the DB dedupe path), same as
 * `search_packs_nl` and `wiki_status`.
 */

const wikiAskIdempotencyKey: IdempotencyKeyBuilder<WikiAskInput> = (input) => {
  const slug = typeof input?.projectSlug === 'string' && input.projectSlug.length > 0 ? input.projectSlug : 'probe';
  const questionPrefix = typeof input?.question === 'string' ? input.question.slice(0, 60) : '';
  return {
    kind: 'readonly',
    key: `readonly:wiki_ask:${slug}:${questionPrefix}`.slice(0, 200),
  };
};

export function createWikiAskToolRegistration(
  deps: WikiAskHandlerDeps,
): ToolRegistration<typeof wikiAskInputSchema, typeof wikiAskOutputSchema> {
  return {
    name: 'wiki_ask',
    title: 'Coodra: wiki_ask',
    description:
      'Call this to answer a natural-language question about this codebase from its Deep Wiki, reading the shared ' +
      'team-mode store directly — use it when you have not run `coodra wiki build` yourself but a project wiki ' +
      'already exists (e.g. a teammate built it). Ranks wiki pages against `question` and returns each match with ' +
      'its full page content, not just an excerpt — read `contentMarkdown` to answer, the `excerpt` is only for ' +
      'quick scanning. This is retrieval only: Coodra runs no LLM of its own and does not synthesize an answer. ' +
      'Returns { ok: true, wikiId, slug, results: [{ pageId, title, score, excerpt, contentMarkdown }] }. ' +
      'Soft-failures: { ok: false, error: "project_not_found" | "wiki_not_found", howToFix }.',
    inputSchema: wikiAskInputSchema,
    outputSchema: wikiAskOutputSchema,
    idempotencyKey: wikiAskIdempotencyKey,
    handler: createWikiAskHandler(deps),
  };
}
