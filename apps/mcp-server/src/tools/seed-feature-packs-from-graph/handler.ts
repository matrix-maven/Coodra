import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { eq } from 'drizzle-orm';

import type { ToolContext } from '../../framework/tool-context.js';
import { defaultFeaturePacksRoot } from '../../lib/feature-pack.js';
import type { Community, SeedFeaturePacksFromGraphInput, SeedFeaturePacksFromGraphOutput } from './schema.js';

/**
 * Handler factory for `coodra__seed_feature_packs_from_graph`
 * (Module 09, track 9B / phases G2 + G2.1).
 *
 * Factory shape (not a bare static handler) because it closes over a
 * `DbHandle` for the `projects` lookup + the `feature_packs` upsert, and
 * a `featurePacksRoot` for the on-disk pack files.
 *
 * Flow:
 *   1. Resolve `projectSlug` → `projects` row. Missing → structured
 *      `{ ok: false, error: 'project_not_found', howToFix }` per §9.1.2.
 *   2. For each community: derive a `<projectSlug>-<label>` pack slug,
 *      render a draft `spec.md` body that embeds the community structure
 *      (god nodes + member files) as readable prose, and build the
 *      Phase-F `content_json` envelope.
 *   3. INSERT a `feature_packs` row with `status='draft'`
 *      ... ON CONFLICT (slug) DO UPDATE — the conflict `set` updates only
 *      the content columns, never `status` (a tech lead may already have
 *      published this pack) and never `orgId`.
 *   4. Materialise the pack to disk —
 *      `<featurePacksRoot>/<slug>/{spec,implementation,techstack}.md` +
 *      `meta.json` (whose `structure` block carries the machine-readable
 *      Graphify data). The DB row is written BEFORE the disk files: a
 *      draft DB row with no disk dir stays hidden (`loadOne` returns
 *      `null`), so a mid-loop disk failure leaves the pack hidden and a
 *      re-seed completes it — never a half-visible pack.
 *
 * Draft packs are hidden from agents — `lib/feature-pack.ts::loadOne`
 * returns `null` for a `status='draft'` row. Once a tech lead activates
 * the pack (draft → published), the filesystem-first store reads the
 * on-disk files and `get_feature_pack` surfaces the pack — including the
 * `structure` block (G2.1), threaded `meta.json → metaJsonSchema →
 * FeaturePackContent → the get_feature_pack wire schema`.
 *
 * Coodra never reads `graph.json` — the agent fetches the community
 * breakdown from Graphify's own MCP server and hands it here (Option C,
 * ADR-010).
 */

const handlerLogger = createLogger('mcp-server.tool.seed_feature_packs_from_graph');

export interface SeedFeaturePacksFromGraphHandlerDeps {
  readonly db: DbHandle;
  /**
   * Root of the `<slug>/{spec,implementation,techstack}.md` + meta.json
   * tree. Defaults to `${cwd}/docs/feature-packs` — the same root the
   * filesystem-first FeaturePackStore resolves, so `get_feature_pack`
   * reads a seeded pack once a tech lead activates it. Tests inject a
   * tmp dir.
   */
  readonly featurePacksRoot?: string;
}

const MAX_SLUG_LEN = 128 as const;

/** Normalise a free-text label into a slug fragment: lowercase, non-alphanumeric → '-', collapsed, trimmed. */
function slugFragment(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Per-pack slug: `<projectSlug>-<community-label>`, ≤128 chars. Falls back to communityId when a label has no slug chars. */
function packSlugFor(projectSlug: string, community: Community): string {
  const fragment = slugFragment(community.label) || `community-${slugFragment(community.communityId) || 'x'}`;
  return `${projectSlug}-${fragment}`.slice(0, MAX_SLUG_LEN);
}

/** Checksum — same formula as `lib/feature-pack.ts::computeChecksum`: sha256 of spec‖implementation‖techstack. */
function computeChecksum(spec: string, implementation: string, techstack: string): string {
  const h = createHash('sha256');
  h.update(spec);
  h.update(implementation);
  h.update(techstack);
  return `sha256:${h.digest('hex')}`;
}

const STUB_BODY =
  '_Not yet authored — this section was seeded from a Graphify code-graph community. ' +
  'A tech lead should fill it in while reviewing the draft._\n';

/** Render the draft `spec.md` body for one community. The structure is embedded as readable prose. */
function renderSpec(community: Community): string {
  const godNodes = community.godNodes ?? [];
  const memberFiles = community.memberFiles ?? [];
  const lines: string[] = [
    `# ${community.label}`,
    '',
    '> **Draft — seeded from Graphify.** This Feature Pack was auto-generated from a ' +
      'Graphify code-graph community. It is hidden from agents until a tech lead reviews it, ' +
      'adds architectural constraints and conventions, and activates it.',
    '',
  ];
  if (community.summary !== undefined) {
    lines.push(community.summary, '');
  }
  lines.push(`## Code structure (Graphify community \`${community.communityId}\`)`, '');
  lines.push(
    godNodes.length > 0
      ? `**Key symbols (god nodes):** ${godNodes.map((n) => `\`${n}\``).join(', ')}`
      : '**Key symbols (god nodes):** none identified.',
    '',
  );
  if (memberFiles.length > 0) {
    lines.push(`**Member files (${memberFiles.length}):**`, '');
    for (const file of memberFiles) {
      lines.push(`- \`${file}\``);
    }
  } else {
    lines.push('**Member files:** none identified.');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Materialise a draft pack's markdown + meta.json to disk so the
 * filesystem-first FeaturePackStore (and `get_feature_pack`) can read it
 * once a tech lead activates the draft.
 */
async function writeDraftPackToDisk(
  featurePacksRoot: string,
  slug: string,
  files: {
    readonly spec: string;
    readonly implementation: string;
    readonly techstack: string;
    readonly metaJson: string;
  },
): Promise<void> {
  const dir = resolve(featurePacksRoot, slug);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, 'spec.md'), files.spec, 'utf8'),
    writeFile(join(dir, 'implementation.md'), files.implementation, 'utf8'),
    writeFile(join(dir, 'techstack.md'), files.techstack, 'utf8'),
    writeFile(join(dir, 'meta.json'), files.metaJson, 'utf8'),
  ]);
}

interface ProjectRow {
  readonly id: string;
  readonly orgId: string;
}

async function resolveProject(db: DbHandle, projectSlug: string): Promise<ProjectRow | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ id: sqliteSchema.projects.id, orgId: sqliteSchema.projects.orgId })
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, projectSlug))
      .limit(1);
    const row = rows[0];
    return row ? { id: row.id, orgId: row.orgId } : null;
  }
  const rows = await db.db
    .select({ id: postgresSchema.projects.id, orgId: postgresSchema.projects.orgId })
    .from(postgresSchema.projects)
    .where(eq(postgresSchema.projects.slug, projectSlug))
    .limit(1);
  const row = rows[0];
  return row ? { id: row.id, orgId: row.orgId } : null;
}

async function selectPackIdBySlug(db: DbHandle, slug: string): Promise<string | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ id: sqliteSchema.featurePacks.id })
      .from(sqliteSchema.featurePacks)
      .where(eq(sqliteSchema.featurePacks.slug, slug))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  const rows = await db.db
    .select({ id: postgresSchema.featurePacks.id })
    .from(postgresSchema.featurePacks)
    .where(eq(postgresSchema.featurePacks.slug, slug))
    .limit(1);
  return rows[0]?.id ?? null;
}

interface DraftPackRow {
  readonly id: string;
  readonly slug: string;
  readonly checksum: string;
  readonly contentJson: string;
  readonly orgId: string;
  readonly updatedAt: Date;
}

/**
 * INSERT a `feature_packs` draft row, ON CONFLICT (slug) updating only
 * the content columns. `status` and `orgId` are deliberately absent
 * from the conflict `set` — a re-seed must never flip a tech-lead-
 * published pack back to draft, nor move it between orgs.
 */
async function upsertDraftPackRow(db: DbHandle, row: DraftPackRow): Promise<void> {
  if (db.kind === 'sqlite') {
    await db.db
      .insert(sqliteSchema.featurePacks)
      .values({
        id: row.id,
        slug: row.slug,
        parentSlug: null,
        isActive: true,
        checksum: row.checksum,
        contentJson: row.contentJson,
        status: 'draft',
        orgId: row.orgId,
        updatedAt: row.updatedAt,
      })
      .onConflictDoUpdate({
        target: sqliteSchema.featurePacks.slug,
        set: { checksum: row.checksum, contentJson: row.contentJson, updatedAt: row.updatedAt },
      });
    return;
  }
  await db.db
    .insert(postgresSchema.featurePacks)
    .values({
      id: row.id,
      slug: row.slug,
      parentSlug: null,
      isActive: true,
      checksum: row.checksum,
      contentJson: row.contentJson,
      status: 'draft',
      orgId: row.orgId,
      updatedAt: row.updatedAt,
    })
    .onConflictDoUpdate({
      target: postgresSchema.featurePacks.slug,
      set: { checksum: row.checksum, contentJson: row.contentJson, updatedAt: row.updatedAt },
    });
}

export function createSeedFeaturePacksFromGraphHandler(
  deps: SeedFeaturePacksFromGraphHandlerDeps,
): (input: SeedFeaturePacksFromGraphInput, ctx: ToolContext) => Promise<SeedFeaturePacksFromGraphOutput> {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createSeedFeaturePacksFromGraphHandler requires a deps object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createSeedFeaturePacksFromGraphHandler: deps.db must be a DbHandle');
  }
  const featurePacksRoot = deps.featurePacksRoot ?? defaultFeaturePacksRoot();

  return async function seedFeaturePacksFromGraphHandler(
    input: SeedFeaturePacksFromGraphInput,
    ctx: ToolContext,
  ): Promise<SeedFeaturePacksFromGraphOutput> {
    const project = await resolveProject(deps.db, input.projectSlug);
    if (project === null) {
      handlerLogger.info(
        {
          event: 'seed_feature_packs_from_graph_project_not_found',
          projectSlug: input.projectSlug,
          sessionId: ctx.sessionId,
        },
        'seed_feature_packs_from_graph: projectSlug does not match a projects row — returning soft-failure',
      );
      return {
        ok: false,
        error: 'project_not_found',
        howToFix:
          'Register the project via the CLI (`coodra init`), or verify projectSlug matches an existing entry in the projects table.',
      };
    }

    const updatedAt = ctx.now();
    const seeded: Array<{ slug: string; communityId: string; created: boolean }> = [];

    for (const community of input.communities) {
      const slug = packSlugFor(input.projectSlug, community);
      const memberFiles = community.memberFiles ?? [];
      const spec = renderSpec(community);
      const implementation = STUB_BODY;
      const techstack = STUB_BODY;
      const meta = {
        slug,
        parentSlug: null,
        sourceFiles: memberFiles,
        // Machine-readable Graphify structure — the durable home for the
        // community data, alongside the human-readable section in `spec`.
        // Threaded to `get_feature_pack` via metaJsonSchema (G2.1).
        structure: {
          source: 'graphify' as const,
          communityId: community.communityId,
          label: community.label,
          godNodes: community.godNodes ?? [],
          memberFiles,
        },
      };
      const contentJson = JSON.stringify({ spec, implementation, techstack, meta, sourceFiles: memberFiles });
      const checksum = computeChecksum(spec, implementation, techstack);

      const existingId = await selectPackIdBySlug(deps.db, slug);
      // DB row first (status='draft' → hidden), then the on-disk files.
      await upsertDraftPackRow(deps.db, {
        id: existingId ?? `fp_${randomUUID()}`,
        slug,
        checksum,
        contentJson,
        orgId: project.orgId,
        updatedAt,
      });
      await writeDraftPackToDisk(featurePacksRoot, slug, {
        spec,
        implementation,
        techstack,
        metaJson: `${JSON.stringify(meta, null, 2)}\n`,
      });
      seeded.push({ slug, communityId: community.communityId, created: existingId === null });
    }

    handlerLogger.info(
      {
        event: 'seed_feature_packs_from_graph_done',
        projectSlug: input.projectSlug,
        count: seeded.length,
        created: seeded.filter((s) => s.created).length,
        sessionId: ctx.sessionId,
      },
      'seed_feature_packs_from_graph: draft feature packs seeded from Graphify communities',
    );

    return { ok: true, seeded, count: seeded.length };
  };
}
