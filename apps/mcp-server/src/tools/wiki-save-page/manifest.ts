import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createWikiSavePageHandler, type WikiSavePageHandlerDeps } from './handler.js';
import { type WikiSavePageInput, wikiSavePageInputSchema, wikiSavePageOutputSchema } from './schema.js';

/**
 * Registration factory for `coodra__wiki_save_page` (Module 10 — Deep
 * Wiki, pass 2). Factory-shaped because the handler closes over the
 * boot-time `DbHandle`.
 *
 * The content pass: for each pending page in a saved wiki structure, the
 * agent reads the page's relevant files (+ optional Graphify queries) and
 * authors Markdown with explanations, code citations, and Mermaid
 * diagrams, persisting it here one page at a time.
 */

const wikiSavePageIdempotencyKey: IdempotencyKeyBuilder<WikiSavePageInput> = (input) => {
  const wikiId = typeof input?.wikiId === 'string' && input.wikiId.length > 0 ? input.wikiId : 'unknown';
  const pageId = typeof input?.pageId === 'string' && input.pageId.length > 0 ? input.pageId : 'none';
  return {
    kind: 'mutating',
    key: `wiki_save_page:${wikiId}:${pageId}`.slice(0, 200),
  };
};

export function createWikiSavePageToolRegistration(
  deps: WikiSavePageHandlerDeps,
): ToolRegistration<typeof wikiSavePageInputSchema, typeof wikiSavePageOutputSchema> {
  return {
    name: 'wiki_save_page',
    title: 'Coodra: wiki_save_page',
    description:
      'Call this in the content pass of Deep Wiki generation, once per page, after wiki_save_structure created the ' +
      "skeleton. Author Markdown grounded in the page's relevant files — explanations, code citations, ```mermaid " +
      'diagrams where wantsDiagram is set. Mermaid is lint-gated: structural errors return "invalid_mermaid" with ' +
      'per-line issues; a wantsDiagram page without a diagram returns "diagram_missing" — fix and re-call. Loop ' +
      'over pendingPageIds until none remain. Returns { ok: true, wikiId, pageId, state, authoredCount, pageCount, ' +
      'remaining } or { ok: false, error, howToFix }.',
    inputSchema: wikiSavePageInputSchema,
    outputSchema: wikiSavePageOutputSchema,
    idempotencyKey: wikiSavePageIdempotencyKey,
    handler: createWikiSavePageHandler(deps),
  };
}
