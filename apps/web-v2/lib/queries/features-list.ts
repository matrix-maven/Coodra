import 'server-only';

import { postgresSchema, sqliteSchema } from '@coodra/db';
import { type FeatureFrontmatter, parseFeatureMd } from '@coodra/shared/features';
import { desc, eq, sql } from 'drizzle-orm';

import { createWebDb } from '@/lib/db';

/**
 * `apps/web-v2/lib/queries/recipes-list.ts` — cross-project Agent Recipes.
 *
 * Cross-project listing of `features` rows, sourced from the DB layer
 * (local SQLite or cloud Postgres depending on deployment mode). Unlike
 * `./recipes.ts` which reads off filesystem for a single project, this
 * query powers the new `/recipes` page that lists every team-visible
 * feature across every project — the admin's "did the teammate's
 * `coodra recipe add` land?" view.
 *
 * Why DB-backed, not filesystem-backed:
 *
 *   1. team-hosted mode: the web server has no filesystem features —
 *      cloud Postgres is the only source.
 *   2. local-team mode: the puller writes both DB + filesystem. Reading
 *      DB lets us show drafts that haven't been written to disk yet
 *      before any local filesystem mirror catches up.
 *   3. local-solo mode: the CLI writes both DB + filesystem on every
 *      mutation, so DB is at-least-as-fresh as disk.
 *
 * Status filter: surfaces both draft + published rows. The page applies
 * role-aware controls at render time, while the query keeps the listing
 * complete for admins and maintainers.
 *
 * Ordering: updated_at DESC so the most-recently-edited feature is
 * always at the top, which is the most useful sort for a "what just
 * changed?" mental model.
 */

export interface FeatureListRow {
  readonly id: string;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly slug: string;
  readonly description: string;
  readonly maturity: 'draft' | 'beta' | 'stable' | 'deprecated' | null;
  readonly status: 'draft' | 'published';
  readonly createdByUserId: string | null;
  readonly updatedAt: Date;
  readonly bodyBytes: number;
}

export interface FeatureDetailDbRow extends FeatureListRow {
  readonly frontmatter: FeatureFrontmatter;
  readonly body: string;
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Pull frontmatter fields out of the stored YAML/JSON blob. The CLI
 * writes raw YAML (see `commands/feature.ts::renderFrontmatterYamlOnly`);
 * the web editor writes JSON. Both shapes are
 * parsed defensively — failures yield `(unparseable)` placeholders so
 * the list still renders rather than 500-ing.
 */
function extractFrontmatterFields(blob: string): {
  description: string;
  maturity: FeatureListRow['maturity'];
} {
  const trimmed = blob.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      return {
        description: typeof obj.description === 'string' ? obj.description : '(no description)',
        maturity:
          obj.maturity === 'draft' ||
          obj.maturity === 'beta' ||
          obj.maturity === 'stable' ||
          obj.maturity === 'deprecated'
            ? obj.maturity
            : null,
      };
    } catch {
      // fall through
    }
  }
  // YAML — single-pass scan for `description:` and `maturity:` keys.
  // Tolerant of `|` block scalars (we just grab the first non-empty
  // line of indented content after `description: |`).
  let description = '(no description)';
  let maturity: FeatureListRow['maturity'] = null;
  const lines = trimmed.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const matchDesc = line.match(/^description:\s*(.*)$/);
    if (matchDesc) {
      const inline = matchDesc[1] ?? '';
      if (inline === '|' || inline === '|+' || inline === '|-') {
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j] ?? '';
          if (next.startsWith('  ')) {
            description = next.trimStart();
            break;
          }
          if (next.trim().length > 0) break;
        }
      } else if (inline.length > 0) {
        description = inline.replace(/^['"]|['"]$/g, '');
      }
      continue;
    }
    const matchMaturity = line.match(/^maturity:\s*(\S+)/);
    if (matchMaturity) {
      const val = matchMaturity[1];
      if (val === 'draft' || val === 'beta' || val === 'stable' || val === 'deprecated') {
        maturity = val;
      }
    }
  }
  return { description, maturity };
}

function parseStoredFeature(
  frontmatter: string,
  body: string,
): {
  readonly frontmatter: FeatureFrontmatter | null;
  readonly warnings: ReadonlyArray<string>;
} {
  const parsed = parseFeatureMd(`---\n${frontmatter.trim()}\n---\n${body}`);
  return { frontmatter: parsed.frontmatter, warnings: parsed.warnings };
}

export async function listFeaturesAcrossProjects(): Promise<ReadonlyArray<FeatureListRow>> {
  const handle = createWebDb();
  if (handle.kind === 'postgres') {
    const rows = await handle.db
      .select({
        id: postgresSchema.features.id,
        slug: postgresSchema.features.slug,
        frontmatter: postgresSchema.features.frontmatter,
        body: postgresSchema.features.body,
        status: postgresSchema.features.status,
        createdByUserId: postgresSchema.features.createdByUserId,
        updatedAt: postgresSchema.features.updatedAt,
        projectSlug: postgresSchema.projects.slug,
        projectName: postgresSchema.projects.name,
      })
      .from(postgresSchema.features)
      .innerJoin(postgresSchema.projects, eq(postgresSchema.features.projectId, postgresSchema.projects.id))
      .orderBy(desc(postgresSchema.features.updatedAt))
      .limit(500);
    return rows.map((r) => {
      const { description, maturity } = extractFrontmatterFields(r.frontmatter);
      return {
        id: r.id,
        projectSlug: r.projectSlug,
        projectName: r.projectName,
        slug: r.slug,
        description,
        maturity,
        status: (r.status === 'published' ? 'published' : 'draft') as 'draft' | 'published',
        createdByUserId: r.createdByUserId,
        updatedAt: r.updatedAt,
        bodyBytes: Buffer.byteLength(r.body, 'utf8'),
      };
    });
  }
  // SQLite path — same shape, different dialect.
  const rows = await handle.db
    .select({
      id: sqliteSchema.features.id,
      slug: sqliteSchema.features.slug,
      frontmatter: sqliteSchema.features.frontmatter,
      body: sqliteSchema.features.body,
      status: sqliteSchema.features.status,
      createdByUserId: sqliteSchema.features.createdByUserId,
      updatedAt: sqliteSchema.features.updatedAt,
      projectSlug: sqliteSchema.projects.slug,
      projectName: sqliteSchema.projects.name,
    })
    .from(sqliteSchema.features)
    .innerJoin(sqliteSchema.projects, eq(sqliteSchema.features.projectId, sqliteSchema.projects.id))
    .orderBy(sql`${sqliteSchema.features.updatedAt} DESC`)
    .limit(500);
  return rows.map((r) => {
    const { description, maturity } = extractFrontmatterFields(r.frontmatter);
    return {
      id: r.id,
      projectSlug: r.projectSlug,
      projectName: r.projectName,
      slug: r.slug,
      description,
      maturity,
      status: (r.status === 'published' ? 'published' : 'draft') as 'draft' | 'published',
      createdByUserId: r.createdByUserId,
      updatedAt: r.updatedAt,
      bodyBytes: Buffer.byteLength(r.body, 'utf8'),
    };
  });
}

export async function listGlobalFeatures(): Promise<ReadonlyArray<FeatureListRow>> {
  const rows = await listFeaturesAcrossProjects();
  return rows.filter((row) => row.projectSlug === '__global__');
}

export async function getGlobalFeature(slug: string): Promise<FeatureDetailDbRow | null> {
  const handle = createWebDb();
  if (handle.kind === 'postgres') {
    const row = (
      await handle.db
        .select({
          id: postgresSchema.features.id,
          slug: postgresSchema.features.slug,
          frontmatter: postgresSchema.features.frontmatter,
          body: postgresSchema.features.body,
          status: postgresSchema.features.status,
          createdByUserId: postgresSchema.features.createdByUserId,
          updatedAt: postgresSchema.features.updatedAt,
          projectSlug: postgresSchema.projects.slug,
          projectName: postgresSchema.projects.name,
        })
        .from(postgresSchema.features)
        .innerJoin(postgresSchema.projects, eq(postgresSchema.features.projectId, postgresSchema.projects.id))
        .where(sql`${postgresSchema.projects.slug} = '__global__' AND ${postgresSchema.features.slug} = ${slug}`)
        .limit(1)
    )[0];
    return row === undefined ? null : toDetailRow(row);
  }

  const row = (
    await handle.db
      .select({
        id: sqliteSchema.features.id,
        slug: sqliteSchema.features.slug,
        frontmatter: sqliteSchema.features.frontmatter,
        body: sqliteSchema.features.body,
        status: sqliteSchema.features.status,
        createdByUserId: sqliteSchema.features.createdByUserId,
        updatedAt: sqliteSchema.features.updatedAt,
        projectSlug: sqliteSchema.projects.slug,
        projectName: sqliteSchema.projects.name,
      })
      .from(sqliteSchema.features)
      .innerJoin(sqliteSchema.projects, eq(sqliteSchema.features.projectId, sqliteSchema.projects.id))
      .where(sql`${sqliteSchema.projects.slug} = '__global__' AND ${sqliteSchema.features.slug} = ${slug}`)
      .limit(1)
  )[0];
  return row === undefined ? null : toDetailRow(row);
}

function toDetailRow(row: {
  readonly id: string;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly slug: string;
  readonly frontmatter: string;
  readonly body: string;
  readonly status: string;
  readonly createdByUserId: string | null;
  readonly updatedAt: Date;
}): FeatureDetailDbRow | null {
  const parsed = parseStoredFeature(row.frontmatter, row.body);
  if (parsed.frontmatter === null) return null;
  return {
    id: row.id,
    projectSlug: row.projectSlug,
    projectName: row.projectName,
    slug: row.slug,
    description: parsed.frontmatter.description,
    maturity: parsed.frontmatter.maturity ?? null,
    status: row.status === 'published' ? 'published' : 'draft',
    createdByUserId: row.createdByUserId,
    updatedAt: row.updatedAt,
    bodyBytes: Buffer.byteLength(row.body, 'utf8'),
    frontmatter: parsed.frontmatter,
    body: row.body,
    warnings: parsed.warnings,
  };
}
