import { randomUUID } from 'node:crypto';
import { createLogger } from '@coodra/contextos-shared';
import { eq } from 'drizzle-orm';

import type { DbHandle } from './client.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

/**
 * `packages/db/src/ensure-project` — idempotent project seed for an
 * arbitrary slug. Mirrors `ensureGlobalProject` (the `__global__`
 * sentinel) but for a user-supplied slug, e.g. the one written to
 * `<cwd>/.contextos.json` by `contextos init`.
 *
 * Closes integration finding 2026-04-27 (post-08a walk): `contextos
 * init --project-slug X` wrote `.contextos.json` with `slug=X` and
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
}

export interface EnsureProjectResult {
  readonly id: string;
  readonly created: boolean;
  /** True when this call backfilled `projects.cwd` on an existing row. */
  readonly cwdBackfilled?: boolean;
}

const seedLogger = createLogger('db.ensure-project');

export async function ensureProject(db: DbHandle, args: EnsureProjectArgs): Promise<EnsureProjectResult> {
  const slug = args.slug;
  const name = args.name ?? slug;
  const orgId = args.orgId ?? SOLO_ORG_ID;
  const cwd = args.cwd;

  if (db.kind === 'sqlite') {
    const existing = await db.db
      .select({ id: sqliteSchema.projects.id, cwd: sqliteSchema.projects.cwd })
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, slug))
      .limit(1);
    const existingRow = existing[0];
    if (existingRow !== undefined) {
      let cwdBackfilled = false;
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
      return { id: existingRow.id, created: false, cwdBackfilled };
    }
    const id = randomUUID();
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
    return { id: settledId, created };
  }

  // postgres
  const existing = await db.db
    .select({ id: postgresSchema.projects.id, cwd: postgresSchema.projects.cwd })
    .from(postgresSchema.projects)
    .where(eq(postgresSchema.projects.slug, slug))
    .limit(1);
  const existingRow = existing[0];
  if (existingRow !== undefined) {
    let cwdBackfilled = false;
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
    return { id: existingRow.id, created: false, cwdBackfilled };
  }
  const id = randomUUID();
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
