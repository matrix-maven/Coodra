import { randomUUID } from 'node:crypto';
import { createLogger } from '@coodra/shared';
import { eq } from 'drizzle-orm';

import type { DbHandle } from './client.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';
import { scheduleDurableWrite } from './schedule-durable-write.js';

/**
 * `packages/db/src/ensure-project` — idempotent project seed for an
 * arbitrary slug. Mirrors `ensureGlobalProject` (the `__global__`
 * sentinel) but for a user-supplied slug, e.g. the one written to
 * `<cwd>/.coodra.json` by `coodra init`.
 *
 * Closes integration finding 2026-04-27 (post-08a walk): `coodra
 * init --project-slug X` wrote `.coodra.json` with `slug=X` and
 * seeded `__global__`, but never inserted a `projects` row for `X`.
 * Result: bridge resolves cwd → slug → no row → falls back to
 * `__global__` for every audit. Per-project audit chain silently
 * broken (every decision attributed to `__global__`). Doctor check 12
 * caught the symptom; this helper fixes the cause.
 *
 * Returns `{ id, created }` — `created: true` on first insert,
 * `created: false` on idempotent no-op. Caller can log INFO once,
 * DEBUG thereafter.
 *
 * Solo-mode default `orgId = '__solo__'` mirrors the `__global__`
 * pattern (no real Clerk org exists in solo mode). Team mode passes
 * the real Clerk org id.
 */

export const SOLO_ORG_ID = '__solo__';
export const GLOBAL_ORG_ID = '__global__';

/**
 * W5 / beta.5 (2026-05-13) — local-only sentinel orgs. These match the
 * sync-dispatcher's `shouldSkipLocalOnly` guard in `feature-db.ts` and
 * elsewhere; a project tagged with one of these never pushes rows to
 * cloud Postgres. The promote flow swaps them for a real Clerk org id.
 */
function isLocalOnlyOrg(orgId: string | null | undefined): boolean {
  return orgId === SOLO_ORG_ID || orgId === GLOBAL_ORG_ID || orgId === null || orgId === undefined || orgId.length === 0;
}

export type EnsureProjectErrorCode = 'org_mismatch' | 'team_to_solo_refused';

export class EnsureProjectError extends Error {
  readonly code: EnsureProjectErrorCode;
  readonly howToFix: string;
  constructor(code: EnsureProjectErrorCode, message: string, howToFix: string) {
    super(message);
    this.name = 'EnsureProjectError';
    this.code = code;
    this.howToFix = howToFix;
  }
}

export interface EnsureProjectArgs {
  readonly slug: string;
  /** Display name. Defaults to `slug`. */
  readonly name?: string;
  /** Org id. Defaults to `__solo__` (solo mode). */
  readonly orgId?: string;
  /**
   * Absolute filesystem path of the project root. When supplied, ensureProject
   * stores it on insert AND backfills it on existing rows whose `cwd` is null.
   * Never overwrites a non-null `cwd` — only the bridge's authoritative
   * SessionStart resolution should call this with the canonical cwd, so first
   * write wins. Pass undefined when the caller does not know the project root
   * (e.g. policy hot path), in which case existing rows are left alone.
   */
  readonly cwd?: string;
  /**
   * When supplied AND no local row for `slug` already exists, ensureProject
   * uses this id for the new row instead of minting a fresh UUID. Used by
   * team-mode `init` to adopt the cloud Postgres' canonical id for a slug
   * the team has already registered, avoiding split-brain (different uuid
   * per developer for the same slug → cloud unique-on-slug FK violations
   * forever). Ignored when an existing local row is found.
   */
  readonly idOverride?: string;
}

export interface EnsureProjectResult {
  readonly id: string;
  readonly created: boolean;
  /** True when this call backfilled `projects.cwd` on an existing row. */
  readonly cwdBackfilled?: boolean;
  /**
   * W5 / beta.5 (2026-05-13) — true when this call promoted an existing
   * row from a local-only sentinel org (`__solo__` / `__global__`) to a
   * real Clerk org id. UI/CLI callers surface this so the user knows
   * their solo project is now visible to the team.
   */
  readonly orgPromoted?: boolean;
  /** When orgPromoted is true: the prior local-only org id we replaced. */
  readonly promotedFromOrgId?: string;
}

const seedLogger = createLogger('db.ensure-project');

export async function ensureProject(db: DbHandle, args: EnsureProjectArgs): Promise<EnsureProjectResult> {
  const slug = args.slug;
  const name = args.name ?? slug;
  const orgId = args.orgId ?? SOLO_ORG_ID;
  const cwd = args.cwd;

  if (db.kind === 'sqlite') {
    const existing = await db.db
      .select({
        id: sqliteSchema.projects.id,
        cwd: sqliteSchema.projects.cwd,
        orgId: sqliteSchema.projects.orgId,
      })
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, slug))
      .limit(1);
    const existingRow = existing[0];
    if (existingRow !== undefined) {
      let cwdBackfilled = false;
      let orgPromoted = false;
      let promotedFromOrgId: string | undefined;
      const existingOrgId = existingRow.orgId;
      // W5 / beta.5 promote logic. Four cases on org_id transition:
      //   1. existing local-only (__solo__/__global__) + new real org → PROMOTE.
      //   2. existing real org + new real org, same id                → no-op.
      //   3. existing real org + new real org, DIFFERENT id           → REFUSE (silent re-org would split data across teams).
      //   4. existing real org + new local-only sentinel              → IGNORE the demotion (keep team membership; init can't demote silently).
      if (isLocalOnlyOrg(existingOrgId) && !isLocalOnlyOrg(orgId)) {
        await db.db
          .update(sqliteSchema.projects)
          .set({ orgId, updatedAt: new Date() })
          .where(eq(sqliteSchema.projects.id, existingRow.id));
        orgPromoted = true;
        promotedFromOrgId = existingOrgId ?? SOLO_ORG_ID;
        seedLogger.info(
          {
            event: 'project_org_promoted',
            slug,
            projectId: existingRow.id,
            fromOrgId: promotedFromOrgId,
            toOrgId: orgId,
          },
          'promoted projects.org_id from local-only sentinel to real Clerk org',
        );
        // Enqueue sync push for the (now team-mode) project + any
        // pre-existing features that were stamped with this projectId
        // while it was solo — those rows already exist in local
        // SQLite with the projectId we just team-tagged; the cloud
        // never saw them. Without this, the user gets "feature shows
        // locally + in web but not in supabase" exactly as reported.
        if (process.env.COODRA_MODE === 'team') {
          try {
            await scheduleDurableWrite(db, {
              queue: 'sync_to_cloud',
              payload: { v: 1 as const, table: 'projects', lookup: { kind: 'id', value: existingRow.id } },
            });
            // Backfill features that already exist locally for this project.
            const orphanFeatures = db.raw
              .prepare('SELECT id FROM features WHERE project_id = ?')
              .all(existingRow.id) as Array<{ id: string }>;
            for (const f of orphanFeatures) {
              try {
                await scheduleDurableWrite(db, {
                  queue: 'sync_to_cloud',
                  payload: { v: 1 as const, table: 'features', lookup: { kind: 'id', value: f.id } },
                });
              } catch {
                // best-effort per feature
              }
            }
            seedLogger.info(
              {
                event: 'project_org_promote_sync_enqueued',
                projectId: existingRow.id,
                orphanFeaturesEnqueued: orphanFeatures.length,
              },
              'enqueued sync_to_cloud for promoted project + pre-existing features',
            );
          } catch (err) {
            seedLogger.warn(
              { event: 'project_org_promote_enqueue_failed', err: err instanceof Error ? err.message : String(err) },
              'enqueue failed; sync daemon will pick up on the next write',
            );
          }
        }
      } else if (!isLocalOnlyOrg(existingOrgId) && !isLocalOnlyOrg(orgId) && existingOrgId !== orgId) {
        throw new EnsureProjectError(
          'org_mismatch',
          `Project "${slug}" already belongs to org "${existingOrgId}" but ensureProject was called with org "${orgId}".`,
          `Refusing to silently move project "${slug}" between Clerk orgs (data split risk). ` +
            'If you really intended to migrate, manually update the row via SQL and re-trigger sync, ' +
            'OR delete the local project + re-init (you will lose local audit history).',
        );
      }
      // Case 2 + 4: existing real org with same id, or existing real org with
      // local-only demotion attempt — both fall through to a no-op on org_id.
      if (cwd !== undefined && existingRow.cwd === null) {
        await db.db
          .update(sqliteSchema.projects)
          .set({ cwd, updatedAt: new Date() })
          .where(eq(sqliteSchema.projects.id, existingRow.id));
        cwdBackfilled = true;
        seedLogger.info(
          { event: 'project_cwd_backfilled', slug, projectId: existingRow.id, cwd },
          'backfilled projects.cwd on existing row',
        );
      }
      seedLogger.debug(
        { event: 'project_already_seeded', slug, projectId: existingRow.id },
        'project row already present',
      );
      return {
        id: existingRow.id,
        created: false,
        cwdBackfilled,
        ...(orgPromoted ? { orgPromoted, promotedFromOrgId: promotedFromOrgId as string } : {}),
      };
    }
    const id = args.idOverride ?? randomUUID();
    await db.db
      .insert(sqliteSchema.projects)
      .values({ id, slug, orgId, name, ...(cwd !== undefined ? { cwd } : {}) })
      .onConflictDoNothing({ target: sqliteSchema.projects.slug });
    // A concurrent insert could have won on the unique slug — re-select to
    // get whichever id actually landed (ours or theirs).
    const settled = await db.db
      .select({ id: sqliteSchema.projects.id })
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, slug))
      .limit(1);
    const settledId = settled[0]?.id ?? id;
    const created = settledId === id;
    seedLogger.info(
      { event: 'project_seeded', slug, projectId: settledId, created, ...(cwd !== undefined ? { cwd } : {}) },
      'inserted projects row for cwd-resolved slug',
    );
    // M04 Phase 4 / Phase G+H: in team mode, enqueue a sync_to_cloud
    // job so the row reaches cloud Postgres. Without this, every runs
    // row that FKs to this project hits a violation in cloud and the
    // entire team-mode audit chain silently never lands.
    if (created && process.env.COODRA_MODE === 'team') {
      try {
        await scheduleDurableWrite(db, {
          queue: 'sync_to_cloud',
          payload: { v: 1 as const, table: 'projects', lookup: { kind: 'id', value: settledId } },
        });
      } catch (err) {
        seedLogger.warn(
          {
            event: 'project_sync_enqueue_failed',
            slug,
            projectId: settledId,
            err: err instanceof Error ? err.message : String(err),
          },
          'failed to enqueue projects sync_to_cloud — cloud will lack this row until next ensureProject call',
        );
      }
    }
    return { id: settledId, created };
  }

  // postgres
  const existing = await db.db
    .select({
      id: postgresSchema.projects.id,
      cwd: postgresSchema.projects.cwd,
      orgId: postgresSchema.projects.orgId,
    })
    .from(postgresSchema.projects)
    .where(eq(postgresSchema.projects.slug, slug))
    .limit(1);
  const existingRow = existing[0];
  if (existingRow !== undefined) {
    let cwdBackfilled = false;
    let orgPromoted = false;
    let promotedFromOrgId: string | undefined;
    const existingOrgId = existingRow.orgId;
    // W5 / beta.5 — mirror the sqlite promote logic on the postgres side.
    // Same four cases. Sync-enqueue branch is sqlite-only (the queue is
    // local); the postgres branch updates the canonical cloud row in place.
    if (isLocalOnlyOrg(existingOrgId) && !isLocalOnlyOrg(orgId)) {
      await db.db
        .update(postgresSchema.projects)
        .set({ orgId, updatedAt: new Date() })
        .where(eq(postgresSchema.projects.id, existingRow.id));
      orgPromoted = true;
      promotedFromOrgId = existingOrgId ?? SOLO_ORG_ID;
      seedLogger.info(
        {
          event: 'project_org_promoted',
          slug,
          projectId: existingRow.id,
          fromOrgId: promotedFromOrgId,
          toOrgId: orgId,
        },
        'promoted projects.org_id on cloud postgres',
      );
    } else if (!isLocalOnlyOrg(existingOrgId) && !isLocalOnlyOrg(orgId) && existingOrgId !== orgId) {
      throw new EnsureProjectError(
        'org_mismatch',
        `Project "${slug}" already belongs to org "${existingOrgId}" but ensureProject was called with org "${orgId}".`,
        `Refusing to silently move project "${slug}" between Clerk orgs (data split risk). ` +
          'If you really intended to migrate, run the migration manually via SQL and re-coordinate with the original org.',
      );
    }
    if (cwd !== undefined && existingRow.cwd === null) {
      await db.db
        .update(postgresSchema.projects)
        .set({ cwd, updatedAt: new Date() })
        .where(eq(postgresSchema.projects.id, existingRow.id));
      cwdBackfilled = true;
      seedLogger.info(
        { event: 'project_cwd_backfilled', slug, projectId: existingRow.id, cwd },
        'backfilled projects.cwd on existing row',
      );
    }
    seedLogger.debug(
      { event: 'project_already_seeded', slug, projectId: existingRow.id },
      'project row already present',
    );
    return {
      id: existingRow.id,
      created: false,
      cwdBackfilled,
      ...(orgPromoted ? { orgPromoted, promotedFromOrgId: promotedFromOrgId as string } : {}),
    };
  }
  const id = args.idOverride ?? randomUUID();
  await db.db
    .insert(postgresSchema.projects)
    .values({ id, slug, orgId, name, ...(cwd !== undefined ? { cwd } : {}) })
    .onConflictDoNothing({ target: postgresSchema.projects.slug });
  const settled = await db.db
    .select({ id: postgresSchema.projects.id })
    .from(postgresSchema.projects)
    .where(eq(postgresSchema.projects.slug, slug))
    .limit(1);
  const settledId = settled[0]?.id ?? id;
  const created = settledId === id;
  seedLogger.info(
    { event: 'project_seeded', slug, projectId: settledId, created, ...(cwd !== undefined ? { cwd } : {}) },
    'inserted projects row for cwd-resolved slug',
  );
  return { id: settledId, created };
}
