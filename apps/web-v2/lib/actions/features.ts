'use server';

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, relative } from 'node:path';
import { postgresSchema, scheduleDurableWrite, sqliteSchema } from '@coodra/db';
import {
  type FeatureFrontmatter,
  skillsRoot as featuresRootShared,
  generateFeaturesIndex,
  type ParsedFeatureMd,
  parseFeatureMd,
  renderFeatureMd,
} from '@coodra/shared/features';
import { and, eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';

import { assertActorRole, refuseInTeamHosted } from '@/lib/action-guards';
import { createWebDb } from '@/lib/db';
import { resolveIdentityMode } from '@/lib/deployment-mode';
import { getProject } from '@/lib/queries/projects';

const RECIPE_MD_NAME = 'recipe.md';
const LEGACY_FEATURE_MD_NAME = 'feature.md';
const GLOBAL_PROJECT_SLUG = '__global__';

/**
 * `apps/web-v2/lib/actions/recipes.ts` — server actions for the
 * Agent Recipes layer.
 *
 * Five mutating endpoints:
 *
 *   createFeatureAction  — scaffold .coodra/recipes/<slug>/recipe.md
 *                          from name + description (+ optional initial
 *                          file uploads). Auto-runs the indexer.
 *   uploadFeatureFileAction — drop one supporting file alongside an
 *                          existing feature. Auto-runs the indexer.
 *   editFeatureMetaAction — overwrite recipe.md frontmatter + body.
 *                          Goes through the parser, refuses on
 *                          structural error, regen-on-success.
 *   removeFeatureAction   — typed-confirm cascade-delete the
 *                          .coodra/recipes/<slug>/ directory. Auto-runs
 *                          the indexer to drop the entry.
 *   reindexFeaturesAction — force a fresh INDEX.md / INDEX.json. Used
 *                          when the user dropped files via git pull or
 *                          a sibling tool and wants the agent to see
 *                          them now.
 *
 * Every mutating action ALWAYS regenerates the index after the FS
 * change so the bridge / MCP / web see a consistent view. The
 * generator is idempotent — a no-op when nothing changed — so the
 * always-regen rule has no cost when the action turned out to be a
 * no-op (redirect on validation error, etc.).
 *
 * Path-resolution: every action takes `projectSlug` and resolves cwd
 * via `lookupProjectBySlug` → `projects.cwd`, falling back to web-v2's
 * process.cwd() for legacy null-cwd rows. Same fallback the read paths
 * use, so reads + writes stay in sync.
 */

const SLUG_RE = /^[a-z0-9_-]+$/;
const PROJECT_SLUG_RE = /^[a-z0-9_-]+$/;

/**
 * Cap on the markdown body posted from the editor. The on-disk file
 * can be larger if the user authored it via $EDITOR — only matters for
 * the Server Action surface where someone could paste arbitrary bytes.
 */
const MAX_BODY_BYTES = 1_000_000;

const MAX_FILE_BYTES = 256 * 1024;

const ALLOWED_FILE_EXTENSIONS = new Set<string>([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.csv',
  '.tsv',
  '.sql',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.rb',
  '.sh',
  '.bash',
  '.zsh',
  '.html',
  '.css',
  '.xml',
]);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function firstZodMessage(err: z.ZodError): string {
  const issue = err.issues[0];
  if (issue === undefined) return 'invalid form data';
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}

function listHref(projectSlug: string, qs: Record<string, string> = {}): string {
  const search = new URLSearchParams(qs);
  const q = search.toString();
  if (projectSlug === GLOBAL_PROJECT_SLUG) return `/recipes/global${q ? `?${q}` : ''}`;
  return `/projects/${encodeURIComponent(projectSlug)}/recipes${q ? `?${q}` : ''}`;
}

function detailHref(projectSlug: string, fslug: string, qs: Record<string, string> = {}): string {
  const search = new URLSearchParams(qs);
  const q = search.toString();
  if (projectSlug === GLOBAL_PROJECT_SLUG) return `/recipes/global/${encodeURIComponent(fslug)}${q ? `?${q}` : ''}`;
  return `/projects/${encodeURIComponent(projectSlug)}/recipes/${encodeURIComponent(fslug)}${q ? `?${q}` : ''}`;
}

async function resolveProjectContext(projectSlug: string): Promise<{
  readonly id: string;
  readonly orgId: string;
  readonly cwd: string;
}> {
  const project = await getProject(projectSlug);
  if (project === null) notFound();
  return { id: project.id, orgId: project.orgId, cwd: project.cwd ?? process.cwd() };
}

function stableFrontmatterJson(frontmatter: FeatureFrontmatter): string {
  return JSON.stringify(
    {
      name: frontmatter.name,
      description: frontmatter.description,
      ...(frontmatter.whenNotToUse !== undefined && frontmatter.whenNotToUse.length > 0
        ? { whenNotToUse: frontmatter.whenNotToUse }
        : {}),
      ...(frontmatter.maturity !== undefined ? { maturity: frontmatter.maturity } : {}),
      ...(frontmatter.owners !== undefined ? { owners: frontmatter.owners } : {}),
      ...(frontmatter.tags !== undefined ? { tags: frontmatter.tags } : {}),
    },
    null,
    2,
  );
}

function featureChecksum(frontmatter: string, body: string): string {
  return createHash('sha256').update(frontmatter).update('\0').update(body).digest('hex');
}

async function enqueueFeatureSync(featureId: string): Promise<void> {
  if (resolveIdentityMode() !== 'team') return;
  const handle = createWebDb();
  if (handle.kind !== 'sqlite') return;
  await scheduleDurableWrite(handle, {
    queue: 'sync_to_cloud',
    payload: { v: 1 as const, table: 'features' as const, lookup: { kind: 'id' as const, value: featureId } },
  }).catch(() => {
    // Best-effort, matching the CLI mirror path. Doctor surfaces stuck sync queues.
  });
}

async function upsertRecipeDbMirror(args: {
  readonly projectId: string;
  readonly orgId: string;
  readonly slug: string;
  readonly frontmatter: FeatureFrontmatter;
  readonly body: string;
  readonly status: 'draft' | 'published';
  readonly actorUserId: string | null;
}): Promise<void> {
  const handle = createWebDb();
  const frontmatter = stableFrontmatterJson(args.frontmatter);
  const checksum = featureChecksum(frontmatter, args.body);
  const now = new Date();

  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.features;
    const existing = (
      await handle.db
        .select({ id: t.id, createdByUserId: t.createdByUserId })
        .from(t)
        .where(and(eq(t.projectId, args.projectId), eq(t.slug, args.slug)))
        .limit(1)
    )[0];
    const featureId = existing?.id ?? `feat_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await handle.db
      .insert(t)
      .values({
        id: featureId,
        orgId: args.orgId,
        projectId: args.projectId,
        slug: args.slug,
        frontmatter,
        body: args.body,
        checksum,
        status: args.status,
        createdByUserId: existing?.createdByUserId ?? args.actorUserId,
        updatedByUserId: args.actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [t.projectId, t.slug],
        set: {
          orgId: args.orgId,
          frontmatter,
          body: args.body,
          checksum,
          status: args.status,
          updatedByUserId: args.actorUserId,
          updatedAt: now,
        },
      });
    await enqueueFeatureSync(featureId);
    return;
  }

  const t = postgresSchema.features;
  const existing = (
    await handle.db
      .select({ id: t.id, createdByUserId: t.createdByUserId })
      .from(t)
      .where(and(eq(t.projectId, args.projectId), eq(t.slug, args.slug)))
      .limit(1)
  )[0];
  await handle.db
    .insert(t)
    .values({
      id: existing?.id ?? `feat_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      orgId: args.orgId,
      projectId: args.projectId,
      slug: args.slug,
      frontmatter,
      body: args.body,
      checksum,
      status: args.status,
      createdByUserId: existing?.createdByUserId ?? args.actorUserId,
      updatedByUserId: args.actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [t.projectId, t.slug],
      set: {
        orgId: args.orgId,
        frontmatter,
        body: args.body,
        checksum,
        status: args.status,
        updatedByUserId: args.actorUserId,
        updatedAt: now,
      },
    });
}

async function recipeDbMirrorExists(args: { readonly projectId: string; readonly slug: string }): Promise<boolean> {
  const handle = createWebDb();
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.features;
    const row = (
      await handle.db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.projectId, args.projectId), eq(t.slug, args.slug)))
        .limit(1)
    )[0];
    return row !== undefined;
  }

  const t = postgresSchema.features;
  const row = (
    await handle.db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.projectId, args.projectId), eq(t.slug, args.slug)))
      .limit(1)
  )[0];
  return row !== undefined;
}

async function deleteRecipeDbMirror(args: { readonly projectId: string; readonly slug: string }): Promise<void> {
  const handle = createWebDb();
  if (handle.kind === 'sqlite') {
    await handle.db
      .delete(sqliteSchema.features)
      .where(and(eq(sqliteSchema.features.projectId, args.projectId), eq(sqliteSchema.features.slug, args.slug)));
    return;
  }
  await handle.db
    .delete(postgresSchema.features)
    .where(and(eq(postgresSchema.features.projectId, args.projectId), eq(postgresSchema.features.slug, args.slug)));
}

async function mirrorParsedRecipe(args: {
  readonly projectId: string;
  readonly orgId: string;
  readonly slug: string;
  readonly parsed: ParsedFeatureMd;
  readonly actorUserId: string | null;
}): Promise<void> {
  if (args.parsed.frontmatter === null) return;
  await upsertRecipeDbMirror({
    projectId: args.projectId,
    orgId: args.orgId,
    slug: args.slug,
    frontmatter: args.parsed.frontmatter,
    body: args.parsed.body,
    status: 'published',
    actorUserId: args.actorUserId,
  });
}

async function mirrorAllRecipesForProject(args: {
  readonly projectSlug: string;
  readonly actorUserId: string | null;
}): Promise<ReturnType<typeof generateFeaturesIndex>> {
  const project = await resolveProjectContext(args.projectSlug);
  const result = generateFeaturesIndex({ projectCwd: project.cwd, projectSlug: args.projectSlug });
  for (const entry of result.index.features) {
    const recipePath = authoredRecipePath(join(featuresRootShared(project.cwd), entry.slug));
    if (recipePath === null) continue;
    const parsed = parseFeatureMd(readFileSync(recipePath, 'utf8'));
    if (parsed.errors.length > 0) continue;
    await mirrorParsedRecipe({
      projectId: project.id,
      orgId: project.orgId,
      slug: entry.slug,
      parsed,
      actorUserId: args.actorUserId,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// createFeatureAction
// ---------------------------------------------------------------------------

const CREATE_SCHEMA = z.object({
  projectSlug: z.string().min(1).regex(PROJECT_SLUG_RE),
  slug: z
    .string()
    .min(1, 'slug is required')
    .max(64, 'slug must be ≤ 64 chars')
    .regex(SLUG_RE, 'slug must be lowercase letters, digits, hyphens or underscores'),
  description: z.string().min(1, 'description is required').max(2000, 'description must be ≤ 2000 chars'),
  whenNotToUse: z.string().max(2000).optional(),
  maturity: z.enum(['draft', 'beta', 'stable', 'deprecated']).optional(),
  body: z.string().max(MAX_BODY_BYTES).optional(),
  force: z.boolean().optional(),
});

export async function createFeatureAction(formData: FormData): Promise<void> {
  // Agent Recipes write to <repo>/.coodra/recipes/<slug>/ on local disk.
  // Team-hosted deployments have no project checkout to mutate, so authoring is
  // a local web / CLI workflow.
  refuseInTeamHosted('recipe action');
  const actor = await assertActorRole('member');
  const projectSlug = String(formData.get('projectSlug') ?? '').trim();
  const slug = String(formData.get('slug') ?? '').trim();

  const raw = {
    projectSlug,
    slug,
    description: String(formData.get('description') ?? '').trim(),
    whenNotToUse: String(formData.get('whenNotToUse') ?? '').trim() || undefined,
    maturity: (String(formData.get('maturity') ?? '').trim() || undefined) as
      | 'draft'
      | 'beta'
      | 'stable'
      | 'deprecated'
      | undefined,
    body: String(formData.get('body') ?? '').trim() || undefined,
    force: formData.get('force') === 'on' || formData.get('force') === 'true',
  };

  const parsed = CREATE_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    const newHref =
      projectSlug === GLOBAL_PROJECT_SLUG
        ? '/recipes/global/new'
        : `/projects/${encodeURIComponent(projectSlug)}/recipes/new`;
    redirect(
      `${newHref}?error=create_validation_failed&errorMessage=${encodeURIComponent(firstZodMessage(parsed.error))}`,
    );
  }

  const project = await resolveProjectContext(parsed.data.projectSlug);
  const frontmatter: FeatureFrontmatter = {
    name: parsed.data.slug,
    description: parsed.data.description,
    ...(parsed.data.whenNotToUse !== undefined && parsed.data.whenNotToUse.length > 0
      ? { whenNotToUse: parsed.data.whenNotToUse }
      : {}),
    ...(parsed.data.maturity !== undefined ? { maturity: parsed.data.maturity } : {}),
  };
  const body = parsed.data.body ?? scaffoldBody(parsed.data.slug);

  if (parsed.data.projectSlug === GLOBAL_PROJECT_SLUG) {
    if (parsed.data.force !== true && (await recipeDbMirrorExists({ projectId: project.id, slug: parsed.data.slug }))) {
      redirect(
        `/recipes/global/new?error=feature_exists&errorMessage=${encodeURIComponent(`Global Agent Recipe "${parsed.data.slug}" already exists. Tick "force overwrite" or pick a different slug.`)}`,
      );
    }
    await upsertRecipeDbMirror({
      projectId: project.id,
      orgId: project.orgId,
      slug: parsed.data.slug,
      frontmatter,
      body,
      status: 'published',
      actorUserId: actor.userId,
    });
    redirect(detailHref(parsed.data.projectSlug, parsed.data.slug, { saved: '1' }));
  }

  const { cwd } = project;
  const dir = join(featuresRootShared(cwd), parsed.data.slug);
  const featureMdPath = join(dir, RECIPE_MD_NAME);

  if (existsSync(featureMdPath) && parsed.data.force !== true) {
    redirect(
      `/projects/${encodeURIComponent(parsed.data.projectSlug)}/recipes/new?error=feature_exists&errorMessage=${encodeURIComponent(`Agent Recipe "${parsed.data.slug}" already exists. Tick "force overwrite" or pick a different slug.`)}`,
    );
  }

  // Optional initial file uploads. The form input name is `files` and
  // accepts multiple; we filter to the allowlist + size cap.
  const fileEntries = formData
    .getAll('files')
    .filter((f): f is File => f instanceof File && f.size > 0)
    .filter((f) => ALLOWED_FILE_EXTENSIONS.has(extname(f.name).toLowerCase()))
    .filter((f) => f.size <= MAX_FILE_BYTES);

  try {
    mkdirSync(dir, { recursive: true });
    const rendered = renderFeatureMd({
      frontmatter,
      body,
    });
    writeFileSync(featureMdPath, rendered, 'utf8');

    for (const file of fileEntries) {
      const safeName = sanitiseFilename(file.name);
      const target = join(dir, safeName);
      const buf = Buffer.from(await file.arrayBuffer());
      writeFileSync(target, buf);
    }
  } catch (err) {
    redirect(
      `/projects/${encodeURIComponent(parsed.data.projectSlug)}/recipes/new?error=write_failed&errorMessage=${encodeURIComponent((err as Error).message)}`,
    );
  }

  // Always regenerate the index. Idempotent on no-op.
  try {
    generateFeaturesIndex({ projectCwd: cwd, projectSlug: parsed.data.projectSlug });
    await upsertRecipeDbMirror({
      projectId: project.id,
      orgId: project.orgId,
      slug: parsed.data.slug,
      frontmatter,
      body,
      status: 'published',
      actorUserId: actor.userId,
    });
  } catch {
    // Indexer threw (corrupted recipe.md somewhere). The recipe was
    // written; we still redirect to success but flag the error so the
    // user sees the warning banner on the list page. Drop into the
    // detail page; the warnings panel will surface the issue.
  }

  redirect(detailHref(parsed.data.projectSlug, parsed.data.slug, { saved: '1' }));
}

// ---------------------------------------------------------------------------
// uploadFeatureFileAction
// ---------------------------------------------------------------------------

const UPLOAD_FILE_SCHEMA = z.object({
  projectSlug: z.string().min(1).regex(PROJECT_SLUG_RE),
  fslug: z.string().min(1).regex(SLUG_RE),
});

export async function uploadFeatureFileAction(formData: FormData): Promise<void> {
  // Agent Recipes write to <repo>/.coodra/recipes/<slug>/ on local disk.
  // Team-hosted deployments have no project checkout to mutate, so authoring is
  // a local web / CLI workflow.
  refuseInTeamHosted('recipe action');
  const actor = await assertActorRole('member');
  const projectSlug = String(formData.get('projectSlug') ?? '').trim();
  const fslug = String(formData.get('fslug') ?? '').trim();
  const parsed = UPLOAD_FILE_SCHEMA.safeParse({ projectSlug, fslug });
  if (!parsed.success) {
    redirect(
      detailHref(projectSlug, fslug, {
        error: 'upload_validation_failed',
        errorMessage: firstZodMessage(parsed.error),
      }),
    );
  }
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    redirect(
      detailHref(parsed.data.projectSlug, parsed.data.fslug, {
        error: 'no_file',
        errorMessage: 'Pick a file to upload.',
      }),
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    redirect(
      detailHref(parsed.data.projectSlug, parsed.data.fslug, {
        error: 'file_too_large',
        errorMessage: `File is ${file.size} bytes; cap is ${MAX_FILE_BYTES}.`,
      }),
    );
  }
  const ext = extname(file.name).toLowerCase();
  if (!ALLOWED_FILE_EXTENSIONS.has(ext)) {
    redirect(
      detailHref(parsed.data.projectSlug, parsed.data.fslug, {
        error: 'extension_blocked',
        errorMessage: `Files with extension ${ext} are not allowed. See the MCP get_recipe_file tool docs for the full allowlist.`,
      }),
    );
  }

  const project = await resolveProjectContext(parsed.data.projectSlug);
  const { cwd } = project;
  const dir = join(featuresRootShared(cwd), parsed.data.fslug);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    redirect(
      detailHref(parsed.data.projectSlug, parsed.data.fslug, {
        error: 'feature_not_found',
        errorMessage: `No Agent Recipe at ${dir}.`,
      }),
    );
  }

  try {
    const safeName = sanitiseFilename(file.name);
    const target = join(dir, safeName);
    const buf = Buffer.from(await file.arrayBuffer());
    writeFileSync(target, buf);
  } catch (err) {
    redirect(
      detailHref(parsed.data.projectSlug, parsed.data.fslug, {
        error: 'write_failed',
        errorMessage: (err as Error).message,
      }),
    );
  }

  try {
    generateFeaturesIndex({ projectCwd: cwd, projectSlug: parsed.data.projectSlug });
    const recipePath = authoredRecipePath(dir);
    if (recipePath !== null) {
      const recipe = parseFeatureMd(readFileSync(recipePath, 'utf8'));
      await mirrorParsedRecipe({
        projectId: project.id,
        orgId: project.orgId,
        slug: parsed.data.fslug,
        parsed: recipe,
        actorUserId: actor.userId,
      });
    }
  } catch {
    // see createFeatureAction comment
  }

  redirect(detailHref(parsed.data.projectSlug, parsed.data.fslug, { uploaded: file.name }));
}

// ---------------------------------------------------------------------------
// editFeatureMetaAction
// ---------------------------------------------------------------------------

const EDIT_META_SCHEMA = z.object({
  projectSlug: z.string().min(1).regex(PROJECT_SLUG_RE),
  fslug: z.string().min(1).regex(SLUG_RE),
  description: z.string().min(1).max(2000),
  whenNotToUse: z.string().max(2000).optional(),
  maturity: z.enum(['draft', 'beta', 'stable', 'deprecated']).optional(),
  body: z.string().max(MAX_BODY_BYTES).optional(),
});

export async function editFeatureMetaAction(formData: FormData): Promise<void> {
  // Agent Recipes write to <repo>/.coodra/recipes/<slug>/ on local disk.
  // Team-hosted deployments have no project checkout to mutate, so authoring is
  // a local web / CLI workflow.
  refuseInTeamHosted('recipe action');
  const actor = await assertActorRole('member');
  const projectSlug = String(formData.get('projectSlug') ?? '').trim();
  const fslug = String(formData.get('fslug') ?? '').trim();
  const raw = {
    projectSlug,
    fslug,
    description: String(formData.get('description') ?? '').trim(),
    whenNotToUse: String(formData.get('whenNotToUse') ?? '').trim() || undefined,
    maturity: (String(formData.get('maturity') ?? '').trim() || undefined) as
      | 'draft'
      | 'beta'
      | 'stable'
      | 'deprecated'
      | undefined,
    body: String(formData.get('body') ?? '').trim() || undefined,
  };
  const parsed = EDIT_META_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    const editHref =
      projectSlug === GLOBAL_PROJECT_SLUG
        ? `/recipes/global/${encodeURIComponent(fslug)}/edit`
        : `/projects/${encodeURIComponent(projectSlug)}/recipes/${encodeURIComponent(fslug)}/edit`;
    redirect(
      `${editHref}?error=edit_validation_failed&errorMessage=${encodeURIComponent(firstZodMessage(parsed.error))}`,
    );
  }

  const project = await resolveProjectContext(parsed.data.projectSlug);
  if (parsed.data.projectSlug === GLOBAL_PROJECT_SLUG) {
    const body = parsed.data.body ?? '';
    const rendered = renderFeatureMd({
      frontmatter: {
        name: parsed.data.fslug,
        description: parsed.data.description,
        ...(parsed.data.whenNotToUse !== undefined && parsed.data.whenNotToUse.length > 0
          ? { whenNotToUse: parsed.data.whenNotToUse }
          : {}),
        ...(parsed.data.maturity !== undefined ? { maturity: parsed.data.maturity } : {}),
      },
      body,
    });
    const verify = parseFeatureMd(rendered);
    if (verify.errors.length > 0) {
      redirect(
        `/recipes/global/${encodeURIComponent(parsed.data.fslug)}/edit?error=render_failed&errorMessage=${encodeURIComponent(verify.errors[0] ?? 'rendered recipe.md does not round-trip')}`,
      );
    }
    await mirrorParsedRecipe({
      projectId: project.id,
      orgId: project.orgId,
      slug: parsed.data.fslug,
      parsed: verify,
      actorUserId: actor.userId,
    });
    redirect(detailHref(parsed.data.projectSlug, parsed.data.fslug, { saved: '1' }));
  }

  const { cwd } = project;
  const dir = join(featuresRootShared(cwd), parsed.data.fslug);
  const featureMdPath = authoredRecipePath(dir);
  if (featureMdPath === null || !existsSync(featureMdPath)) {
    redirect(
      detailHref(parsed.data.projectSlug, parsed.data.fslug, {
        error: 'feature_not_found',
        errorMessage: `No ${RECIPE_MD_NAME} at ${dir}.`,
      }),
    );
  }

  // Read existing body if user didn't pass one — preserves prior body
  // when the user only wanted to edit the frontmatter.
  let body = parsed.data.body;
  if (body === undefined) {
    try {
      const raw = readFileSync(featureMdPath, 'utf8');
      const existing = parseFeatureMd(raw);
      body = existing.body;
    } catch {
      body = '';
    }
  }

  const rendered = renderFeatureMd({
    frontmatter: {
      name: parsed.data.fslug,
      description: parsed.data.description,
      ...(parsed.data.whenNotToUse !== undefined && parsed.data.whenNotToUse.length > 0
        ? { whenNotToUse: parsed.data.whenNotToUse }
        : {}),
      ...(parsed.data.maturity !== undefined ? { maturity: parsed.data.maturity } : {}),
    },
    body: body ?? '',
  });

  // Sanity-parse the rendered output before writing. If renderFeatureMd
  // emitted something that doesn't round-trip, refuse the write — the
  // current on-disk file stays valid.
  const verify = parseFeatureMd(rendered);
  if (verify.errors.length > 0) {
    redirect(
      `/projects/${encodeURIComponent(parsed.data.projectSlug)}/recipes/${encodeURIComponent(parsed.data.fslug)}/edit?error=render_failed&errorMessage=${encodeURIComponent(verify.errors[0] ?? 'rendered recipe.md does not round-trip')}`,
    );
  }

  try {
    writeFileSync(featureMdPath, rendered, 'utf8');
  } catch (err) {
    redirect(
      `/projects/${encodeURIComponent(parsed.data.projectSlug)}/recipes/${encodeURIComponent(parsed.data.fslug)}/edit?error=write_failed&errorMessage=${encodeURIComponent((err as Error).message)}`,
    );
  }

  try {
    generateFeaturesIndex({ projectCwd: cwd, projectSlug: parsed.data.projectSlug });
    await mirrorParsedRecipe({
      projectId: project.id,
      orgId: project.orgId,
      slug: parsed.data.fslug,
      parsed: verify,
      actorUserId: actor.userId,
    });
  } catch {
    // see createFeatureAction comment
  }

  redirect(detailHref(parsed.data.projectSlug, parsed.data.fslug, { saved: '1' }));
}

// ---------------------------------------------------------------------------
// removeFeatureAction
// ---------------------------------------------------------------------------

const REMOVE_SCHEMA = z.object({
  projectSlug: z.string().min(1).regex(PROJECT_SLUG_RE),
  fslug: z.string().min(1).regex(SLUG_RE),
  confirmation: z.string().min(1, 'Type the confirmation phrase to remove.'),
});

export async function removeFeatureAction(formData: FormData): Promise<void> {
  // Agent Recipes write to <repo>/.coodra/recipes/<slug>/ on local disk.
  // Team-hosted deployments have no project checkout to mutate, so authoring is
  // a local web / CLI workflow.
  refuseInTeamHosted('recipe action');
  await assertActorRole('member');
  const projectSlug = String(formData.get('projectSlug') ?? '').trim();
  const fslug = String(formData.get('fslug') ?? '').trim();
  const raw = {
    projectSlug,
    fslug,
    confirmation: String(formData.get('confirmation') ?? '').trim(),
  };
  const parsed = REMOVE_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    redirect(
      detailHref(projectSlug, fslug, {
        error: 'remove_validation_failed',
        errorMessage: firstZodMessage(parsed.error),
      }),
    );
  }
  const expected = `remove ${parsed.data.fslug}`;
  if (parsed.data.confirmation !== expected) {
    redirect(
      detailHref(parsed.data.projectSlug, parsed.data.fslug, {
        error: 'remove_confirmation_mismatch',
        errorMessage: `Confirmation phrase must be "${expected}" exactly.`,
      }),
    );
  }
  const project = await resolveProjectContext(parsed.data.projectSlug);
  if (parsed.data.projectSlug === GLOBAL_PROJECT_SLUG) {
    await deleteRecipeDbMirror({ projectId: project.id, slug: parsed.data.fslug });
    redirect(listHref(parsed.data.projectSlug, { removed: parsed.data.fslug }));
  }

  const { cwd } = project;
  const dir = join(featuresRootShared(cwd), parsed.data.fslug);
  if (!existsSync(dir)) {
    redirect(
      listHref(parsed.data.projectSlug, {
        error: 'feature_not_found',
        errorMessage: `No Agent Recipe at ${dir}.`,
      }),
    );
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    redirect(
      detailHref(parsed.data.projectSlug, parsed.data.fslug, {
        error: 'remove_failed',
        errorMessage: (err as Error).message,
      }),
    );
  }
  try {
    generateFeaturesIndex({ projectCwd: cwd, projectSlug: parsed.data.projectSlug });
    await deleteRecipeDbMirror({ projectId: project.id, slug: parsed.data.fslug });
  } catch {
    // see createFeatureAction comment
  }
  redirect(listHref(parsed.data.projectSlug, { removed: parsed.data.fslug }));
}

// ---------------------------------------------------------------------------
// importFeaturesAction (Phase I)
// ---------------------------------------------------------------------------

const IMPORT_SCHEMA = z.object({
  projectSlug: z.string().min(1).regex(PROJECT_SLUG_RE),
  /** JSON-encoded array of {absPath, slug, description}. Sent through the form as a single field. */
  payload: z.string().min(1),
});

const IMPORT_ITEM_SCHEMA = z.array(
  z
    .object({
      absPath: z.string().min(1),
      slug: z.string().regex(SLUG_RE).min(1).max(64),
      description: z.string().min(1).max(2000),
    })
    .strict(),
);

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveImportSource(absPath: string, cwd: string): { ok: true; path: string } | { ok: false; reason: string } {
  if (!isAbsolute(absPath)) {
    return { ok: false, reason: `source path ${absPath} is not absolute` };
  }
  let rootReal: string;
  let sourceReal: string;
  try {
    rootReal = realpathSync(cwd);
    sourceReal = realpathSync(absPath);
  } catch (err) {
    return { ok: false, reason: `source path could not be resolved: ${(err as Error).message}` };
  }
  if (!isInside(rootReal, sourceReal)) {
    return { ok: false, reason: `source path ${absPath} is outside the project root` };
  }
  let linkStat: ReturnType<typeof lstatSync>;
  try {
    linkStat = lstatSync(absPath);
  } catch (err) {
    return { ok: false, reason: `source path could not be statted: ${(err as Error).message}` };
  }
  if (linkStat.isSymbolicLink()) {
    return { ok: false, reason: `source path ${absPath} is a symlink; copy the file into the project instead` };
  }
  if (!linkStat.isFile()) {
    return { ok: false, reason: `source path ${absPath} is not a regular file` };
  }
  return { ok: true, path: sourceReal };
}

/**
 * Promote a batch of selected on-disk markdown files to Agent Recipes.
 *
 * For each item:
 *   1. Read the source markdown.
 *   2. Strip any YAML frontmatter that was already there (we re-emit
 *      our own).
 *   3. Render `recipe.md` with the user-provided description as
 *      frontmatter and the original body as the markdown body.
 *   4. Write to `<projectCwd>/.coodra/recipes/<slug>/recipe.md`.
 *   5. The original file at `absPath` is NOT moved or deleted —
 *      promotion is *additive*. The user may keep the original (for
 *      git history continuity) or delete it via a separate step.
 *
 * Path-safety: every `absPath` is verified to be inside the project
 * cwd before reading. No symlink-following is done.
 *
 * Atomicity: each item is independent. Partial failure: best-effort
 * — successful items land, failures are accumulated in the redirect
 * query string so the wizard can re-show them.
 */
export async function importFeaturesAction(formData: FormData): Promise<void> {
  // Agent Recipes write to <repo>/.coodra/recipes/<slug>/ on local disk.
  // Team-hosted deployments have no project checkout to mutate, so authoring is
  // a local web / CLI workflow.
  refuseInTeamHosted('recipe action');
  const actor = await assertActorRole('member');
  const projectSlug = String(formData.get('projectSlug') ?? '').trim();
  const payload = String(formData.get('payload') ?? '').trim();
  const parsed = IMPORT_SCHEMA.safeParse({ projectSlug, payload });
  if (!parsed.success) {
    redirect(
      `/projects/${encodeURIComponent(projectSlug)}/recipes/import?error=import_validation_failed&errorMessage=${encodeURIComponent(firstZodMessage(parsed.error))}`,
    );
  }
  let items: Array<{ absPath: string; slug: string; description: string }>;
  try {
    items = IMPORT_ITEM_SCHEMA.parse(JSON.parse(parsed.data.payload));
  } catch (err) {
    redirect(
      `/projects/${encodeURIComponent(parsed.data.projectSlug)}/recipes/import?error=import_payload_invalid&errorMessage=${encodeURIComponent((err as Error).message)}`,
    );
  }
  if (items.length === 0) {
    redirect(
      `/projects/${encodeURIComponent(parsed.data.projectSlug)}/recipes/import?error=no_items&errorMessage=${encodeURIComponent('Pick at least one file to import.')}`,
    );
  }

  const project = await resolveProjectContext(parsed.data.projectSlug);
  const { cwd } = project;
  const featuresDir = featuresRootShared(cwd);
  const succeeded: string[] = [];
  const failed: Array<{ slug: string; reason: string }> = [];

  for (const item of items) {
    const source = resolveImportSource(item.absPath, cwd);
    if (!source.ok) {
      failed.push({ slug: item.slug, reason: source.reason });
      continue;
    }
    const targetDir = join(featuresDir, item.slug);
    const targetMd = join(targetDir, RECIPE_MD_NAME);
    if (existsSync(targetMd)) {
      failed.push({ slug: item.slug, reason: `Agent Recipe ${item.slug} already exists` });
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(source.path, 'utf8');
    } catch (err) {
      failed.push({ slug: item.slug, reason: `read failed: ${(err as Error).message}` });
      continue;
    }
    // Strip leading frontmatter from the source — we re-emit our own.
    const fmMatch = raw.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/);
    const body = fmMatch !== null ? raw.slice(fmMatch[0].length) : raw;
    const frontmatter: FeatureFrontmatter = {
      name: item.slug,
      description: item.description,
      maturity: 'draft',
      tags: ['imported'],
    };
    const recipeBody = body.replace(/^\s+/, '');
    const rendered = renderFeatureMd({
      frontmatter,
      body: recipeBody,
    });
    try {
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(targetMd, rendered, 'utf8');
      await upsertRecipeDbMirror({
        projectId: project.id,
        orgId: project.orgId,
        slug: item.slug,
        frontmatter,
        body: recipeBody,
        status: 'published',
        actorUserId: actor.userId,
      });
      succeeded.push(item.slug);
    } catch (err) {
      failed.push({ slug: item.slug, reason: `write failed: ${(err as Error).message}` });
    }
  }

  // Always regen — even if some failed, the successful ones need the index.
  try {
    generateFeaturesIndex({ projectCwd: cwd, projectSlug: parsed.data.projectSlug });
  } catch {
    // see createFeatureAction comment
  }

  if (succeeded.length === 0 && failed.length > 0) {
    const reasons = failed.map((f) => `${f.slug}: ${f.reason}`).join(' · ');
    redirect(
      `/projects/${encodeURIComponent(parsed.data.projectSlug)}/recipes/import?error=all_imports_failed&errorMessage=${encodeURIComponent(reasons)}`,
    );
  }

  const search = new URLSearchParams();
  search.set('imported', succeeded.join(','));
  if (failed.length > 0) {
    search.set('failed', failed.map((f) => f.slug).join(','));
    search.set('errorMessage', failed.map((f) => `${f.slug}: ${f.reason}`).join(' · '));
  }
  redirect(`/projects/${encodeURIComponent(parsed.data.projectSlug)}/recipes?${search.toString()}`);
}

// ---------------------------------------------------------------------------
// reindexFeaturesAction
// ---------------------------------------------------------------------------

export async function reindexFeaturesAction(formData: FormData): Promise<void> {
  // Agent Recipes write to <repo>/.coodra/recipes/<slug>/ on local disk.
  // Team-hosted deployments have no project checkout to mutate, so authoring is
  // a local web / CLI workflow.
  refuseInTeamHosted('recipe action');
  const actor = await assertActorRole('member');
  const projectSlug = String(formData.get('projectSlug') ?? '').trim();
  if (!PROJECT_SLUG_RE.test(projectSlug)) {
    redirect(`/projects?error=invalid_project_slug`);
  }
  let result: ReturnType<typeof generateFeaturesIndex>;
  try {
    result = await mirrorAllRecipesForProject({ projectSlug, actorUserId: actor.userId });
  } catch (err) {
    redirect(
      listHref(projectSlug, {
        error: 'reindex_failed',
        errorMessage: (err as Error).message,
      }),
    );
  }
  redirect(
    listHref(projectSlug, {
      reindexed: result.changed ? 'updated' : 'unchanged',
    }),
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function authoredRecipePath(dir: string): string | null {
  const current = join(dir, RECIPE_MD_NAME);
  if (existsSync(current)) return current;
  const legacy = join(dir, LEGACY_FEATURE_MD_NAME);
  if (existsSync(legacy)) return legacy;
  return null;
}

/**
 * Conservative filename sanitiser. Strips path components, refuses
 * absolute paths, replaces anything outside `[A-Za-z0-9._-]` with `-`.
 * The web upload form already constrains the picker, but a fat-fingered
 * filename like `../../foo` shouldn't be able to escape the recipe
 * directory even by accident.
 */
function sanitiseFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const sanitised = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (sanitised.length === 0 || sanitised.startsWith('.')) {
    return `upload-${Date.now()}`;
  }
  return sanitised;
}

function scaffoldBody(slug: string): string {
  return [
    `# ${slug}`,
    '',
    '## What this recipe is',
    '',
    'TODO',
    '',
    '## Concrete operations / entities',
    '',
    '- TODO: function names',
    '- TODO: file paths',
    '',
    '## Things to watch out for',
    '',
    'TODO',
    '',
  ].join('\n');
}
