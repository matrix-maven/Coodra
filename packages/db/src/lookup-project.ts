import { eq } from 'drizzle-orm';

import type { DbHandle } from './client.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

/**
 * `packages/db/src/lookup-project` — slug → projectId lookup.
 *
 * Unlike `ensureProject` (which auto-creates on miss), this helper
 * is strict: returns `null` when no row matches. Used by every
 * M08b admin CLI command that takes a project slug and needs to
 * resolve it to the canonical `projects.id` for FK references
 * (`pause --scope project --target <slug>`, `policy add --project
 * <slug>`, `project show <slug>`, `project reset <slug>`, etc.).
 *
 * Idempotent + side-effect-free. Throws only on DB error.
 */

export interface ProjectLookupResult {
  readonly id: string;
  readonly slug: string;
  readonly orgId: string;
  readonly name: string;
}

export async function lookupProjectBySlug(db: DbHandle, slug: string): Promise<ProjectLookupResult | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({
        id: sqliteSchema.projects.id,
        slug: sqliteSchema.projects.slug,
        orgId: sqliteSchema.projects.orgId,
        name: sqliteSchema.projects.name,
      })
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, slug))
      .limit(1);
    return rows[0] ?? null;
  }
  const rows = await db.db
    .select({
      id: postgresSchema.projects.id,
      slug: postgresSchema.projects.slug,
      orgId: postgresSchema.projects.orgId,
      name: postgresSchema.projects.name,
    })
    .from(postgresSchema.projects)
    .where(eq(postgresSchema.projects.slug, slug))
    .limit(1);
  return rows[0] ?? null;
}
