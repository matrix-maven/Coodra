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
      'page skeleton. Author the page Markdown grounded in its relevant files — explanations, code citations, and ' +
      '```mermaid diagrams where wantsDiagram is set — and persist it with optional structured citations. Flips the ' +
      'page from pending to authored; re-authoring overwrites. Loop over the pendingPageIds until none remain. ' +
      'Returns { ok: true, wikiId, pageId, state, authoredCount, pageCount, remaining } or { ok: false, error: ' +
      '"run_not_found" | "auth_required" | "wiki_not_found" | "page_not_in_structure", howToFix }.',
    inputSchema: wikiSavePageInputSchema,
    outputSchema: wikiSavePageOutputSchema,
    idempotencyKey: wikiSavePageIdempotencyKey,
    handler: createWikiSavePageHandler(deps),
  };
}
