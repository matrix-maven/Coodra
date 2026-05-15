import { createLogger } from '@coodra/shared';
import { eq } from 'drizzle-orm';

import type { DbHandle } from './client.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

/**
 * `packages/db/src/ensure-global-project` — idempotent boot-time seed
 * for the `__global__` sentinel project.
 *
 * F7 closure (verification 2026-04-27): `policy_decisions.project_id`
 * is NOT NULL. The hooks-bridge previously skipped audit writes when
 * the resolver returned no projectId (no `.coodra.json` in cwd) to
 * avoid the FK violation. Deny still worked via the `__global__`
 * cache slot in `@coodra/policy::createPolicyClient`, but no
 * audit row landed — agents working in unregistered cwds left no
 * governance trail, breaking SOC2/NHI auditability.
 *
 * Fix: insert a sentinel `projects` row at boot. Both
 * `apps/mcp-server` and `apps/hooks-bridge` call this helper after
 * `migrateSqlite` so every booted DB has the row. The bridge's
 * RunRecorder and the MCP `check_policy` handler fall back to
 * `GLOBAL_PROJECT_ID` when the resolver returns undefined; the
 * policy evaluator's existing in-memory `__global__` cache slot
 * loads rules attached to this project.
 *
 * Why not a Drizzle migration: Drizzle's schema-diff generator
 * produces DDL only. A data-seed migration would require hand-
 * rolling the `meta/_journal.json` + snapshot files, which fights
 * against the schema-as-truth invariant. Boot-time idempotent
 * INSERTs are the same pattern `ensurePgVector` uses (the pgvector
 * extension is also a "ensure exists" precondition that lives
 * outside the Drizzle schema).
 *
 * Idempotent — `ON CONFLICT (id) DO NOTHING`. Safe to call on
 * every boot.
 */

export const GLOBAL_PROJECT_ID = '__global__';
export const GLOBAL_PROJECT_SLUG = '__global__';
const GLOBAL_PROJECT_ORG_ID = '__global__';
const GLOBAL_PROJECT_NAME = 'Global Policy Rules';

const seedLogger = createLogger('db.ensure-global-project');

export async function ensureGlobalProject(db: DbHandle): Promise<void> {
  if (db.kind === 'sqlite') {
    // Detect first-create vs already-present so we can log INFO once,
    // DEBUG thereafter.
    const existing = await db.db
      .select({ id: sqliteSchema.projects.id })
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.id, GLOBAL_PROJECT_ID))
      .limit(1);
    if (existing.length > 0) {
      seedLogger.debug(
        { event: 'global_project_already_seeded', projectId: GLOBAL_PROJECT_ID },
        '__global__ sentinel project already present',
      );
      return;
    }
    await db.db
      .insert(sqliteSchema.projects)
      .values({
        id: GLOBAL_PROJECT_ID,
        slug: GLOBAL_PROJECT_SLUG,
        orgId: GLOBAL_PROJECT_ORG_ID,
        name: GLOBAL_PROJECT_NAME,
      })
      .onConflictDoNothing({ target: sqliteSchema.projects.id });
    seedLogger.info(
      { event: 'global_project_seeded', projectId: GLOBAL_PROJECT_ID },
      'inserted __global__ sentinel project for unregistered-cwd audit fallback (F7)',
    );
    return;
  }

  // postgres
  const existing = await db.db
    .select({ id: postgresSchema.projects.id })
    .from(postgresSchema.projects)
    .where(eq(postgresSchema.projects.id, GLOBAL_PROJECT_ID))
    .limit(1);
  if (existing.length > 0) {
    seedLogger.debug(
      { event: 'global_project_already_seeded', projectId: GLOBAL_PROJECT_ID },
      '__global__ sentinel project already present',
    );
    return;
  }
  await db.db
    .insert(postgresSchema.projects)
    .values({
      id: GLOBAL_PROJECT_ID,
      slug: GLOBAL_PROJECT_SLUG,
      orgId: GLOBAL_PROJECT_ORG_ID,
      name: GLOBAL_PROJECT_NAME,
    })
    .onConflictDoNothing({ target: postgresSchema.projects.id });
  seedLogger.info(
    { event: 'global_project_seeded', projectId: GLOBAL_PROJECT_ID },
    'inserted __global__ sentinel project for unregistered-cwd audit fallback (F7)',
  );
}
