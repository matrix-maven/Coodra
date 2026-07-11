import { type DbHandle, scheduleDurableWrite } from '@coodra/db';
import { createLogger } from '@coodra/shared';

import type { ToolContext } from '../../framework/tool-context.js';
import { requireActorIdentityForTeamMode } from '../../lib/actor-identity.js';
import {
  selectRunProjectId,
  selectWikiIdByProjectSlug,
  selectWikiPageStates,
  upsertWikiStructure,
} from '../../lib/wiki-store.js';
import type { WikiSaveStructureInput, WikiSaveStructureOutput } from './schema.js';

/**
 * Handler factory for `coodra__wiki_save_structure` (Module 10, pass 1).
 *
 * Flow:
 *   1. SELECT runs.projectId for runId. Missing → run_not_found.
 *   2. Team-mode identity gate (requireActorIdentityForTeamMode) →
 *      auth_required when no verified Clerk JWT. Solo → actor=null.
 *   3. Replace guard (field fix 2026-07-12): when a wiki already exists
 *      for (projectId, slug) AND has ≥1 authored page, refuse with
 *      `wiki_exists` unless `replace: true` — the re-plan is a
 *      DELETE-then-INSERT, and two agents defaulting to the project slug
 *      used to silently wipe each other's authored wikis. A pending-only
 *      skeleton is replaced freely (same-session plan iteration).
 *   4. Upsert the wikis row by (projectId, slug) and (re)write the page
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

    if (input.replace !== true) {
      const existingWikiId = await selectWikiIdByProjectSlug(deps.db, projectId, input.slug);
      if (existingWikiId !== null) {
        const states = await selectWikiPageStates(deps.db, existingWikiId);
        const authoredCount = states.filter((s) => s.state === 'authored').length;
        if (authoredCount > 0) {
          handlerLogger.info(
            {
              event: 'wiki_save_structure_wiki_exists',
              runId: input.runId,
              slug: input.slug,
              existingWikiId,
              authoredCount,
              pageCount: states.length,
            },
            'wiki_save_structure: slug already holds an authored wiki and replace!=true — returning wiki_exists soft-failure',
          );
          return {
            ok: false,
            error: 'wiki_exists',
            wikiId: existingWikiId,
            authoredCount,
            pageCount: states.length,
            howToFix:
              `A wiki '${input.slug}' already exists with ${authoredCount}/${states.length} pages authored (wikiId: ${existingWikiId}). ` +
              'Re-planning REPLACES it and deletes every authored page. If the user explicitly asked for a re-plan/refresh, ' +
              're-call wiki_save_structure with replace: true. Otherwise resume the existing wiki via ' +
              `wiki_status({ wikiId: "${existingWikiId}" }) or choose a different slug.`,
          };
        }
      }
    }

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
