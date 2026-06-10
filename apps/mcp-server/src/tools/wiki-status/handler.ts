import type { DbHandle } from '@coodra/db';
import { createLogger } from '@coodra/shared';

import type { ToolContext } from '../../framework/tool-context.js';
import { selectWikiById, selectWikiPageStates } from '../../lib/wiki-store.js';
import type { WikiStatusInput, WikiStatusOutput } from './schema.js';

/**
 * Handler factory for `coodra__wiki_status` (Module 10). Read-only: no
 * identity gate, no writes. Returns the wiki's per-page authoring state
 * so the agent (or CLI) can resume the content pass.
 */

const handlerLogger = createLogger('mcp-server.tool.wiki_status');

export interface WikiStatusHandlerDeps {
  readonly db: DbHandle;
}

export function createWikiStatusHandler(deps: WikiStatusHandlerDeps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createWikiStatusHandler requires a deps object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createWikiStatusHandler: deps.db must be a DbHandle');
  }

  return async function wikiStatusHandler(input: WikiStatusInput, ctx: ToolContext): Promise<WikiStatusOutput> {
    const wiki = await selectWikiById(deps.db, input.wikiId);
    if (wiki === null) {
      handlerLogger.info(
        { event: 'wiki_status_not_found', wikiId: input.wikiId, sessionId: ctx.sessionId },
        'wiki_status: wikiId unknown — returning soft-failure',
      );
      return {
        ok: false,
        error: 'wiki_not_found',
        howToFix: 'No wiki with that id. Call wiki_save_structure first and use the wikiId it returns.',
      };
    }

    const states = await selectWikiPageStates(deps.db, input.wikiId);
    const pages = states.map((s) => ({
      pageId: s.pageId,
      state: s.state === 'authored' ? ('authored' as const) : ('pending' as const),
    }));
    const authoredCount = pages.filter((p) => p.state === 'authored').length;
    const pendingPageIds = pages.filter((p) => p.state === 'pending').map((p) => p.pageId);

    return {
      ok: true,
      wikiId: wiki.id,
      slug: wiki.slug,
      title: wiki.title,
      mode: wiki.mode,
      pageCount: pages.length,
      authoredCount,
      pendingCount: pendingPageIds.length,
      pendingPageIds,
      pages,
    };
  };
}
