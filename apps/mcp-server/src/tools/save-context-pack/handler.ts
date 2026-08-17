import { randomUUID } from 'node:crypto';

import {
  type DbHandle,
  decisionIdWarnings,
  markRunCompleted,
  postgresSchema,
  resolveDecisionIds,
  sqliteSchema,
} from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { and, eq } from 'drizzle-orm';
import type { ToolContext } from '../../framework/tool-context.js';
import { requireActorIdentityForTeamMode } from '../../lib/actor-identity.js';
import type { ContextPackWriteResult } from '../../lib/context-pack.js';
import { touchWorkPackActivity } from '../../lib/context-pack.js';
import type { SaveContextPackInput, SaveContextPackOutput } from './schema.js';

/**
 * Handler factory for `coodra__save_context_pack` (§24.4).
 *
 * Factory shape (not bare static) because the handler closes over a
 * `DbHandle` for the `runs` SELECT + UPDATE. `ctx.contextPack` is
 * wired via `ContextDeps` and handles the `context_packs` write
 * itself (DB-first, Unicode-code-point excerpt, FS materialisation,
 * idempotent-per-runId, append-only re-call — see S7c decisions-log).
 *
 * Flow:
 *   1. SELECT `runs.projectId` for the supplied `runId`. Missing →
 *      structured `{ ok: false, error: 'run_not_found', howToFix }`
 *      soft-failure per §9.1.2 canonical shape.
 *   2. Delegate to `ctx.contextPack.write(pack, null)` — embedding is
 *      null in Module 02 (Module 05 NL Assembly backfills later; S7c
 *      decisions-log 2026-04-24 12:30 keeps the embedding-write path
 *      on the store, not on a separate client).
 *   3. UPDATE `runs SET status = 'completed', endedAt = now()
 *      WHERE id = runId AND status != 'completed'` — idempotent
 *      no-op when the run is already completed (matches §24.4
 *      "returns the existing pack (idempotent)").
 *   4. Return `{ ok: true, contextPackId, savedAt, contentExcerpt }`.
 *
 * No policy-decision audit write — S14 (`check_policy`) remains the
 * first caller of `recordPolicyDecision`.
 */

const handlerLogger = createLogger('mcp-server.tool.save_context_pack');

export interface SaveContextPackHandlerDeps {
  readonly db: DbHandle;
}

async function selectRunProjectId(db: DbHandle, runId: string): Promise<string | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ projectId: sqliteSchema.runs.projectId })
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.id, runId))
      .limit(1);
    return rows[0]?.projectId ?? null;
  }
  const rows = await db.db
    .select({ projectId: postgresSchema.runs.projectId })
    .from(postgresSchema.runs)
    .where(eq(postgresSchema.runs.id, runId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

async function selectWorkPackIdBySlug(db: DbHandle, projectId: string, slug: string): Promise<string | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ id: sqliteSchema.workPacks.id })
      .from(sqliteSchema.workPacks)
      .where(and(eq(sqliteSchema.workPacks.projectId, projectId), eq(sqliteSchema.workPacks.slug, slug)))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  const rows = await db.db
    .select({ id: postgresSchema.workPacks.id })
    .from(postgresSchema.workPacks)
    .where(and(eq(postgresSchema.workPacks.projectId, projectId), eq(postgresSchema.workPacks.slug, slug)))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function linkRunToWorkPack(db: DbHandle, runId: string, workPackId: string): Promise<void> {
  if (db.kind === 'sqlite') {
    await db.db.update(sqliteSchema.runs).set({ workPackId }).where(eq(sqliteSchema.runs.id, runId));
    return;
  }
  await db.db.update(postgresSchema.runs).set({ workPackId }).where(eq(postgresSchema.runs.id, runId));
}

/**
 * Links a Context Pack to one or more Work Packs via the many-to-many
 * `work_pack_context_pack_links` table (coodra-work redesign, round 2).
 * Idempotent per (workPackId, contextPackId) pair.
 */
async function linkContextPackToWorkPacks(
  db: DbHandle,
  args: { readonly orgId: string | null; readonly projectId: string; readonly contextPackId: string },
  workPackIds: ReadonlySet<string>,
): Promise<void> {
  for (const workPackId of workPackIds) {
    if (db.kind === 'sqlite') {
      await db.db
        .insert(sqliteSchema.workPackContextPackLinks)
        .values({
          id: `wpcpl_${randomUUID()}`,
          orgId: args.orgId,
          projectId: args.projectId,
          workPackId,
          contextPackId: args.contextPackId,
        })
        .onConflictDoNothing({
          target: [
            sqliteSchema.workPackContextPackLinks.workPackId,
            sqliteSchema.workPackContextPackLinks.contextPackId,
          ],
        });
      continue;
    }
    await db.db
      .insert(postgresSchema.workPackContextPackLinks)
      .values({
        id: `wpcpl_${randomUUID()}`,
        orgId: args.orgId,
        projectId: args.projectId,
        workPackId,
        contextPackId: args.contextPackId,
      })
      .onConflictDoNothing({
        target: [
          postgresSchema.workPackContextPackLinks.workPackId,
          postgresSchema.workPackContextPackLinks.contextPackId,
        ],
      });
  }
}

export function createSaveContextPackHandler(deps: SaveContextPackHandlerDeps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createSaveContextPackHandler requires a deps object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createSaveContextPackHandler: deps.db must be a DbHandle');
  }

  return async function saveContextPackHandler(
    input: SaveContextPackInput,
    ctx: ToolContext,
  ): Promise<SaveContextPackOutput> {
    const projectId = await selectRunProjectId(deps.db, input.runId);
    if (projectId === null) {
      handlerLogger.info(
        { event: 'save_context_pack_run_not_found', runId: input.runId, sessionId: ctx.sessionId },
        'save_context_pack: runId does not match a runs row — returning soft-failure',
      );
      return {
        ok: false,
        error: 'run_not_found',
        howToFix:
          'Call get_run_id first to create a run for this session, then retry save_context_pack with the returned runId.',
      };
    }

    // Phase G slice G.6 — require Clerk-verified identity for team-
    // mode writes. Solo mode short-circuits to actor=null (NULL stamp).
    // Team mode + no verified token returns auth_required soft-failure
    // so the agent can surface the remediation message to the user.
    const auth = await requireActorIdentityForTeamMode();
    if (auth.kind === 'auth_required') {
      handlerLogger.info(
        { event: 'save_context_pack_auth_required', runId: input.runId, sessionId: ctx.sessionId },
        'save_context_pack: team mode but no verified Clerk JWT — returning auth_required soft-failure',
      );
      return {
        ok: false,
        error: 'auth_required',
        howToFix: auth.howToFix,
      };
    }
    const actor = auth.actor;
    const workPackId =
      input.workPackSlug !== undefined ? await selectWorkPackIdBySlug(deps.db, projectId, input.workPackSlug) : null;
    if (input.workPackSlug !== undefined && workPackId === null) {
      handlerLogger.info(
        {
          event: 'save_context_pack_work_pack_not_found',
          runId: input.runId,
          workPackSlug: input.workPackSlug,
          sessionId: ctx.sessionId,
        },
        'save_context_pack: workPackSlug not found yet; saving unlinked context pack',
      );
    }
    // COOD-91 — resolve `meta.decisionIds` before the write, so the
    // stored meta carries full ids rather than whatever abbreviation the
    // agent had to hand. Prefix expansion is the common repair: three
    // packs in COOD-77 stored 8-hex-char prefixes and every link was
    // silently dead.
    //
    // Unresolvable ids are kept as given rather than dropped — the agent
    // meant something by them, and deleting the evidence would make the
    // warning unactionable.
    const decisionIdResolution =
      input.meta?.decisionIds !== undefined && input.meta.decisionIds.length > 0
        ? await resolveDecisionIds(deps.db, projectId, input.meta.decisionIds)
        : null;
    const warnings = decisionIdResolution === null ? [] : decisionIdWarnings(decisionIdResolution);
    if (warnings.length > 0) {
      handlerLogger.info(
        {
          event: 'save_context_pack_decision_ids_unresolved',
          runId: input.runId,
          sessionId: ctx.sessionId,
          unresolved: decisionIdResolution?.unresolved,
          ambiguous: decisionIdResolution?.ambiguous,
        },
        'save_context_pack: meta.decisionIds contained ids that resolve to no decision; saving anyway',
      );
    }
    const resolvedMeta =
      input.meta === undefined
        ? undefined
        : decisionIdResolution === null
          ? input.meta
          : {
              ...input.meta,
              decisionIds: (input.meta.decisionIds ?? []).map((id) => decisionIdResolution.resolved.get(id) ?? id),
            };

    const written = (await ctx.contextPack.write(
      {
        runId: input.runId,
        projectId,
        title: input.title,
        content: input.content,
      },
      {
        source: 'agent',
        ...(resolvedMeta !== undefined ? { meta: resolvedMeta } : {}),
        ...(actor !== null ? { createdByUserId: actor.userId, orgId: actor.orgId } : {}),
        ...(workPackId !== null ? { workPackId } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.importance !== undefined ? { importance: input.importance } : {}),
      },
    )) as ContextPackWriteResult;

    if (workPackId !== null) {
      await linkRunToWorkPack(deps.db, input.runId, workPackId);
    }

    // coodra-work redesign, round 2 — many-to-many link(s) for the saved
    // Context Pack, additive to the primary workPackSlug binding above.
    const workPackIdsToLink = new Set<string>();
    if (workPackId !== null) workPackIdsToLink.add(workPackId);
    if (input.alsoLinkWorkPackSlugs !== undefined) {
      for (const slug of input.alsoLinkWorkPackSlugs) {
        const resolved = await selectWorkPackIdBySlug(deps.db, projectId, slug);
        if (resolved !== null) {
          workPackIdsToLink.add(resolved);
        } else {
          handlerLogger.info(
            {
              event: 'save_context_pack_also_link_slug_not_found',
              runId: input.runId,
              slug,
              sessionId: ctx.sessionId,
            },
            'save_context_pack: alsoLinkWorkPackSlugs entry did not resolve to a Work Pack; skipping that link',
          );
        }
      }
    }
    if (workPackIdsToLink.size > 0) {
      await linkContextPackToWorkPacks(
        deps.db,
        { orgId: actor !== null ? actor.orgId : null, projectId, contextPackId: written.id },
        workPackIdsToLink,
      );
      // `ctx.contextPack.write()` above already bumped last_activity_at
      // for the primary `workPackId` (if any) — bump it here for every
      // *secondary* `alsoLinkWorkPackSlugs` Work Pack too, so a link
      // that only ever comes from the m2m table still counts as
      // activity on that Work Pack, not just a silent DB row.
      const activityNow = ctx.now();
      for (const linkedWorkPackId of workPackIdsToLink) {
        if (linkedWorkPackId === workPackId) continue;
        await touchWorkPackActivity(deps.db, linkedWorkPackId, written.id, activityNow);
      }
    }

    // Mark the run completed — idempotent no-op if already completed.
    // Runs after the store write so that the context_packs row exists
    // before the run's lifecycle marker flips (avoids the narrow
    // window where a crashed process could leave a 'completed' run
    // with no pack).
    await markRunCompleted(deps.db, input.runId);

    return {
      ok: true,
      contextPackId: written.id,
      savedAt: written.createdAt.toISOString(),
      contentExcerpt: written.contentExcerpt,
      source: written.source,
      status: written.status,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  };
}
