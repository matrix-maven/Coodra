import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createWikiSaveStructureHandler, type WikiSaveStructureHandlerDeps } from './handler.js';
import { type WikiSaveStructureInput, wikiSaveStructureInputSchema, wikiSaveStructureOutputSchema } from './schema.js';

/**
 * Registration factory for `coodra__wiki_save_structure` (Module 10 —
 * Deep Wiki, pass 1). Factory-shaped because the handler closes over the
 * boot-time `DbHandle`; `src/tools/index.ts::registerAllTools` is the
 * single caller.
 *
 * This is the structure pass of the DeepWiki-style two-pass flow: the
 * agent plans the hierarchical wiki (title, sections, pages with
 * importance + relevant files), then persists it here. Coodra writes the
 * page skeleton (all pending) so wiki_save_page / wiki_status can drive
 * the content pass.
 */

const wikiSaveStructureIdempotencyKey: IdempotencyKeyBuilder<WikiSaveStructureInput> = (input) => {
  const runId = typeof input?.runId === 'string' && input.runId.length > 0 ? input.runId : 'unknown';
  const slug = typeof input?.slug === 'string' && input.slug.length > 0 ? input.slug : 'none';
  return {
    kind: 'mutating',
    key: `wiki_save_structure:${runId}:${slug}`.slice(0, 200),
  };
};

export function createWikiSaveStructureToolRegistration(
  deps: WikiSaveStructureHandlerDeps,
): ToolRegistration<typeof wikiSaveStructureInputSchema, typeof wikiSaveStructureOutputSchema> {
  return {
    name: 'wiki_save_structure',
    title: 'Coodra: wiki_save_structure',
    description:
      'Call this in the structure pass of Deep Wiki generation, after planning a hierarchical, mind-map-style ' +
      'explanation of the codebase from the file tree, README, and (if wired) Graphify. Persists the WikiStructure — ' +
      'title, description, mode, and the page hierarchy (each page with importance, relevant files, parent, related ' +
      'pages, wantsDiagram). Coodra writes a pending page skeleton you then fill via wiki_save_page. Re-using the same ' +
      'slug replaces the wiki. Returns { ok: true, wikiId, slug, mode, pageCount, status, pendingPageIds } or ' +
      '{ ok: false, error: "run_not_found" | "auth_required", howToFix }.',
    inputSchema: wikiSaveStructureInputSchema,
    outputSchema: wikiSaveStructureOutputSchema,
    idempotencyKey: wikiSaveStructureIdempotencyKey,
    handler: createWikiSaveStructureHandler(deps),
  };
}
