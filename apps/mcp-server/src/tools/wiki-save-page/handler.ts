import { type DbHandle, scheduleDurableWrite } from '@coodra/db';
import { createLogger } from '@coodra/shared';

import type { ToolContext } from '../../framework/tool-context.js';
import { requireActorIdentityForTeamMode } from '../../lib/actor-identity.js';
import { authorWikiPage, selectRunProjectId, selectWikiById, selectWikiPageStates } from '../../lib/wiki-store.js';
import type { WikiSavePageInput, WikiSavePageOutput } from './schema.js';

/**
 * Handler factory for `coodra__wiki_save_page` (Module 10, pass 2).
 *
 * Flow:
 *   1. SELECT runs.projectId for runId. Missing → run_not_found.
 *   2. Team-mode identity gate → auth_required (solo → actor=null).
 *   3. SELECT the wiki by id; missing OR belonging to a different project
 *      than the run → wiki_not_found.
 *   4. UPDATE the (wikiId, pageId) page to state='authored' with body +
 *      citations. No row matched → page_not_in_structure (the pageId is
 *      not in the saved structure skeleton).
 *   5. Recompute authored / total / remaining from the page states.
 */

const handlerLogger = createLogger('mcp-server.tool.wiki_save_page');

export interface WikiSavePageHandlerDeps {
  readonly db: DbHandle;
}

export function createWikiSavePageHandler(deps: WikiSavePageHandlerDeps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createWikiSavePageHandler requires a deps object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createWikiSavePageHandler: deps.db must be a DbHandle');
  }

  return async function wikiSavePageHandler(input: WikiSavePageInput, ctx: ToolContext): Promise<WikiSavePageOutput> {
    const projectId = await selectRunProjectId(deps.db, input.runId);
    if (projectId === null) {
      return {
        ok: false,
        error: 'run_not_found',
        howToFix:
          'Call get_run_id first to create a run for this session, then retry wiki_save_page with the returned runId.',
      };
    }

    const auth = await requireActorIdentityForTeamMode();
    if (auth.kind === 'auth_required') {
      return { ok: false, error: 'auth_required', howToFix: auth.howToFix };
    }
    const actor = auth.actor;

    const wiki = await selectWikiById(deps.db, input.wikiId);
    if (wiki === null || wiki.projectId !== projectId) {
      handlerLogger.info(
        { event: 'wiki_save_page_wiki_not_found', wikiId: input.wikiId, runId: input.runId, sessionId: ctx.sessionId },
        'wiki_save_page: wikiId unknown or belongs to a different project — returning soft-failure',
      );
      return {
        ok: false,
        error: 'wiki_not_found',
        howToFix:
          'The wikiId is unknown for this run’s project. Call wiki_save_structure first and use the wikiId it returns.',
      };
    }

    const pageRowId = await authorWikiPage(deps.db, {
      wikiId: input.wikiId,
      pageId: input.pageId,
      content: input.content,
      runId: input.runId,
      actorUserId: actor !== null ? actor.userId : null,
      orgId: actor !== null ? actor.orgId : null,
      now: ctx.now(),
    });
    if (pageRowId === null) {
      handlerLogger.info(
        { event: 'wiki_save_page_page_not_in_structure', wikiId: input.wikiId, pageId: input.pageId },
        'wiki_save_page: pageId not in the saved structure skeleton — returning soft-failure',
      );
      return {
        ok: false,
        error: 'page_not_in_structure',
        howToFix:
          'This pageId is not in the saved structure. Use one of the pendingPageIds from wiki_save_structure / wiki_status, or re-plan the structure to include it.',
      };
    }

    // Team mode: push the authored page row to cloud. The dispatch's
    // syncWikiPages ensures the parent wiki (+ project) is in cloud first.
    if (process.env.COODRA_MODE === 'team') {
      try {
        await scheduleDurableWrite(deps.db, {
          queue: 'sync_to_cloud',
          payload: { v: 1 as const, table: 'wiki_pages', lookup: { kind: 'id', value: pageRowId } },
        });
      } catch (err) {
        handlerLogger.warn(
          {
            event: 'wiki_save_page_sync_enqueue_failed',
            wikiId: input.wikiId,
            pageId: input.pageId,
            err: err instanceof Error ? err.message : String(err),
          },
          'sync_to_cloud enqueue threw after page author — row will not reach cloud until next push',
        );
      }
    }

    const states = await selectWikiPageStates(deps.db, input.wikiId);
    const authoredCount = states.filter((s) => s.state === 'authored').length;
    const pageCount = states.length;

    handlerLogger.info(
      { event: 'wiki_save_page_authored', wikiId: input.wikiId, pageId: input.pageId, authoredCount, pageCount },
      'wiki_save_page: page authored',
    );

    return {
      ok: true,
      wikiId: input.wikiId,
      pageId: input.pageId,
      state: 'authored',
      authoredCount,
      pageCount,
      remaining: Math.max(0, pageCount - authoredCount),
    };
  };
}
