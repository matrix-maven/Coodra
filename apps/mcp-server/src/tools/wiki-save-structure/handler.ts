import { type DbHandle, scheduleDurableWrite } from '@coodra/db';
import { createLogger } from '@coodra/shared';

import type { ToolContext } from '../../framework/tool-context.js';
import { requireActorIdentityForTeamMode } from '../../lib/actor-identity.js';
import { selectRunProjectId, upsertWikiStructure } from '../../lib/wiki-store.js';
import type { WikiSaveStructureInput, WikiSaveStructureOutput } from './schema.js';

/**
 * Handler factory for `coodra__wiki_save_structure` (Module 10, pass 1).
 *
 * Flow:
 *   1. SELECT runs.projectId for runId. Missing → run_not_found.
 *   2. Team-mode identity gate (requireActorIdentityForTeamMode) →
 *      auth_required when no verified Clerk JWT. Solo → actor=null.
 *   3. Upsert the wikis row by (projectId, slug) and (re)write the page
 *      skeleton (every page state='pending'). A pre-existing wiki for the
 *      same key is replaced — DELETE-then-INSERT idempotency so a re-plan
 *      supersedes the prior attempt.
 *
 * The structure is already validated (referential integrity included) by
 * the input Zod schema, so the handler trusts it.
 */

const handlerLogger = createLogger('mcp-server.tool.wiki_save_structure');

export interface WikiSaveStructureHandlerDeps {
  readonly db: DbHandle;
}

export function createWikiSaveStructureHandler(deps: WikiSaveStructureHandlerDeps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createWikiSaveStructureHandler requires a deps object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createWikiSaveStructureHandler: deps.db must be a DbHandle');
  }

  return async function wikiSaveStructureHandler(
    input: WikiSaveStructureInput,
    ctx: ToolContext,
  ): Promise<WikiSaveStructureOutput> {
    const projectId = await selectRunProjectId(deps.db, input.runId);
    if (projectId === null) {
      handlerLogger.info(
        { event: 'wiki_save_structure_run_not_found', runId: input.runId, sessionId: ctx.sessionId },
        'wiki_save_structure: runId does not match a runs row — returning soft-failure',
      );
      return {
        ok: false,
        error: 'run_not_found',
        howToFix:
          'Call get_run_id first to create a run for this session, then retry wiki_save_structure with the returned runId.',
      };
    }

    const auth = await requireActorIdentityForTeamMode();
    if (auth.kind === 'auth_required') {
      handlerLogger.info(
        { event: 'wiki_save_structure_auth_required', runId: input.runId, sessionId: ctx.sessionId },
        'wiki_save_structure: team mode but no verified Clerk JWT — returning auth_required soft-failure',
      );
      return { ok: false, error: 'auth_required', howToFix: auth.howToFix };
    }
    const actor = auth.actor;

    const { wikiId, status } = await upsertWikiStructure(deps.db, {
      projectId,
      runId: input.runId,
      slug: input.slug,
      structure: input.structure,
      actorUserId: actor !== null ? actor.userId : null,
      orgId: actor !== null ? actor.orgId : null,
      now: ctx.now(),
    });

    // Team mode: enqueue a sync_to_cloud job so the sync-daemon pushes the
    // wiki structure row to cloud Postgres (the skeleton pages are empty
    // until authored, so only the wikis row is pushed here; each authored
    // page is pushed by wiki_save_page). Solo mode skips — no cloud.
    if (process.env.COODRA_MODE === 'team') {
      try {
        await scheduleDurableWrite(deps.db, {
          queue: 'sync_to_cloud',
          payload: { v: 1 as const, table: 'wikis', lookup: { kind: 'id', value: wikiId } },
        });
      } catch (err) {
        handlerLogger.warn(
          {
            event: 'wiki_save_structure_sync_enqueue_failed',
            wikiId,
            err: err instanceof Error ? err.message : String(err),
          },
          'sync_to_cloud enqueue threw after wiki upsert — row will not reach cloud until next push',
        );
      }
    }

    handlerLogger.info(
      {
        event: 'wiki_save_structure_saved',
        wikiId,
        slug: input.slug,
        status,
        pageCount: input.structure.pages.length,
        sessionId: ctx.sessionId,
      },
      'wiki_save_structure: structure persisted + page skeleton written',
    );

    return {
      ok: true,
      wikiId,
      slug: input.slug,
      mode: input.structure.mode,
      pageCount: input.structure.pages.length,
      status,
      pendingPageIds: input.structure.pages.map((p) => p.id),
    };
  };
}
