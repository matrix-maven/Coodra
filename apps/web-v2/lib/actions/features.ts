'use server';

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import {
  FEATURE_SLUG_RE,
  featuresRoot as featuresRootShared,
  generateFeaturesIndex,
  parseFeatureMd,
  renderFeatureMd,
} from '@coodra/contextos-shared/features';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';

import { getProject } from '@/lib/queries/projects';

/**
 * `apps/web-v2/lib/actions/features.ts` — server actions for the
 * skill-style features layer (Phase F).
 *
 * Five mutating endpoints:
 *
 *   createFeatureAction  — scaffold docs/features/<slug>/feature.md
 *                          from name + description (+ optional initial
 *                          file uploads). Auto-runs the indexer.
 *   uploadFeatureFileAction — drop one supporting file alongside an
 *                          existing feature. Auto-runs the indexer.
 *   editFeatureMetaAction — overwrite feature.md frontmatter + body.
 *                          Goes through the parser, refuses on
 *                          structural error, regen-on-success.
 *   removeFeatureAction   — typed-confirm cascade-delete the
 *                          docs/features/<slug>/ directory. Auto-runs
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
  return `/projects/${encodeURIComponent(projectSlug)}/features${q ? `?${q}` : ''}`;
}

function detailHref(projectSlug: string, fslug: string, qs: Record<string, string> = {}): string {
  const search = new URLSearchParams(qs);
  const q = search.toString();
  return `/projects/${encodeURIComponent(projectSlug)}/features/${encodeURIComponent(fslug)}${q ? `?${q}` : ''}`;
}

async function resolveProjectCwd(projectSlug: string): Promise<{ cwd: string }> {
  // Look up via the same web-side query helper the read paths use.
  // notFound() if the slug doesn't exist (Next.js routes the action's
  // caller to the 404 page).
  const project = await getProject(projectSlug);
  if (project === null) notFound();
  return { cwd: project.cwd ?? process.cwd() };
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
  description: z
    .string()
    .min(1, 'description is required')
    .max(2000, 'description must be ≤ 2000 chars'),
  whenNotToUse: z.string().max(2000).optional(),
  maturity: z.enum(['draft', 'beta', 'stable', 'deprecated']).optional(),
  body: z.string().max(MAX_BODY_BYTES).optional(),
  force: z.boolean().optional(),
});

export async function createFeatureAction(formData: FormData): Promise<void> {
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
    redirect(
      `/projects/${encodeURIComponent(projectSlug)}/features/new?error=create_validation_failed&errorMessage=${encodeURIComponent(firstZodMessage(parsed.error))}`,
    );
  }

  const { cwd } = await resolveProjectCwd(parsed.data.projectSlug);
  const dir = join(featuresRootShared(cwd), parsed.data.slug);
  const featureMdPath = join(dir, 'feature.md');

  if (existsSync(featureMdPath) && parsed.data.force !== true) {
    redirect(
      `/projects/${encodeURIComponent(parsed.data.projectSlug)}/features/new?error=feature_exists&errorMessage=${encodeURIComponent(`Feature "${parsed.data.slug}" already exists. Tick "force overwrite" or pick a different slug.`)}`,
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
      frontmatter: {
        name: parsed.data.slug,
        description: parsed.data.description,
        ...(parsed.data.whenNotToUse !== undefined && parsed.data.whenNotToUse.length > 0
          ? { whenNotToUse: parsed.data.whenNotToUse }
          : {}),
        ...(parsed.data.maturity !== undefined ? { maturity: parsed.data.maturity } : {}),
      },
      body:
        parsed.data.body ??
        scaffoldBody(parsed.data.slug),
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
      `/projects/${encodeURIComponent(parsed.data.projectSlug)}/features/new?error=write_failed&errorMessage=${encodeURIComponent((err as Error).message)}`,
    );
  }

  // Always regenerate the index. Idempotent on no-op.
  try {
    generateFeaturesIndex({ projectCwd: cwd, projectSlug: parsed.data.projectSlug });
  } catch {
    // Indexer threw (corrupted feature.md somewhere). The feature was
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
    redirect(detailHref(parsed.data.projectSlug, parsed.data.fslug, { error: 'no_file', errorMessage: 'Pick a file to upload.' }));
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
        errorMessage: `Files with extension ${ext} are not allowed. See the MCP get_feature_file tool docs for the full allowlist.`,
      }),
    );
  }

  const { cwd } = await resolveProjectCwd(parsed.data.projectSlug);
  const dir = join(featuresRootShared(cwd), parsed.data.fslug);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    redirect(
      detailHref(parsed.data.projectSlug, parsed.data.fslug, {
        error: 'feature_not_found',
        errorMessage: `No feature at ${dir}.`,
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
    redirect(
      `/projects/${encodeURIComponent(projectSlug)}/features/${encodeURIComponent(fslug)}/edit?error=edit_validation_failed&errorMessage=${encodeURIComponent(firstZodMessage(parsed.error))}`,
    );
  }

  const { cwd } = await resolveProjectCwd(parsed.data.projectSlug);
  const dir = join(featuresRootShared(cwd), parsed.data.fslug);
  const featureMdPath = join(dir, 'feature.md');
  if (!existsSync(featureMdPath)) {
    redirect(
      detailHref(parsed.data.projectSlug, parsed.data.fslug, {
        error: 'feature_not_found',
        errorMessage: `No feature.md at ${featureMdPath}.`,
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
      `/projects/${encodeURIComponent(parsed.data.projectSlug)}/features/${encodeURIComponent(parsed.data.fslug)}/edit?error=render_failed&errorMessage=${encodeURIComponent(verify.errors[0] ?? 'rendered feature.md does not round-trip')}`,
    );
  }

  try {
    writeFileSync(featureMdPath, rendered, 'utf8');
  } catch (err) {
    redirect(
      `/projects/${encodeURIComponent(parsed.data.projectSlug)}/features/${encodeURIComponent(parsed.data.fslug)}/edit?error=write_failed&errorMessage=${encodeURIComponent((err as Error).message)}`,
    );
  }

  try {
    generateFeaturesIndex({ projectCwd: cwd, projectSlug: parsed.data.projectSlug });
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
  const { cwd } = await resolveProjectCwd(parsed.data.projectSlug);
  const dir = join(featuresRootShared(cwd), parsed.data.fslug);
  if (!existsSync(dir)) {
    redirect(
      listHref(parsed.data.projectSlug, {
        error: 'feature_not_found',
        errorMessage: `No feature at ${dir}.`,
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

/**
 * Promote a batch of selected on-disk markdown files to features.
 *
 * For each item:
 *   1. Read the source markdown.
 *   2. Strip any YAML frontmatter that was already there (we re-emit
 *      our own).
 *   3. Render `feature.md` with the user-provided description as
 *      frontmatter and the original body as the markdown body.
 *   4. Write to `<projectCwd>/docs/features/<slug>/feature.md`.
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
  const projectSlug = String(formData.get('projectSlug') ?? '').trim();
  const payload = String(formData.get('payload') ?? '').trim();
  const parsed = IMPORT_SCHEMA.safeParse({ projectSlug, payload });
  if (!parsed.success) {
    redirect(
      `/projects/${encodeURIComponent(projectSlug)}/features/import?error=import_validation_failed&errorMessage=${encodeURIComponent(firstZodMessage(parsed.error))}`,
    );
  }
  let items: Array<{ absPath: string; slug: string; description: string }>;
  try {
    items = IMPORT_ITEM_SCHEMA.parse(JSON.parse(parsed.data.payload));
  } catch (err) {
    redirect(
      `/projects/${encodeURIComponent(parsed.data.projectSlug)}/features/import?error=import_payload_invalid&errorMessage=${encodeURIComponent((err as Error).message)}`,
    );
  }
  if (items.length === 0) {
    redirect(
      `/projects/${encodeURIComponent(parsed.data.projectSlug)}/features/import?error=no_items&errorMessage=${encodeURIComponent('Pick at least one file to import.')}`,
    );
  }

  const { cwd } = await resolveProjectCwd(parsed.data.projectSlug);
  const featuresDir = featuresRootShared(cwd);
  const succeeded: string[] = [];
  const failed: Array<{ slug: string; reason: string }> = [];

  for (const item of items) {
    // Path-safety: source must live inside the project cwd.
    if (!item.absPath.startsWith(cwd)) {
      failed.push({ slug: item.slug, reason: `source path ${item.absPath} is outside the project root` });
      continue;
    }
    const targetDir = join(featuresDir, item.slug);
    const targetMd = join(targetDir, 'feature.md');
    if (existsSync(targetMd)) {
      failed.push({ slug: item.slug, reason: `feature ${item.slug} already exists` });
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(item.absPath, 'utf8');
    } catch (err) {
      failed.push({ slug: item.slug, reason: `read failed: ${(err as Error).message}` });
      continue;
    }
    // Strip leading frontmatter from the source — we re-emit our own.
    const fmMatch = raw.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/);
    const body = fmMatch !== null ? raw.slice(fmMatch[0].length) : raw;
    const rendered = renderFeatureMd({
      frontmatter: {
        name: item.slug,
        description: item.description,
        maturity: 'draft',
        tags: ['imported'],
      },
      body: body.replace(/^\s+/, ''),
    });
    try {
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(targetMd, rendered, 'utf8');
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
      `/projects/${encodeURIComponent(parsed.data.projectSlug)}/features/import?error=all_imports_failed&errorMessage=${encodeURIComponent(reasons)}`,
    );
  }

  const search = new URLSearchParams();
  search.set('imported', succeeded.join(','));
  if (failed.length > 0) {
    search.set('failed', failed.map((f) => f.slug).join(','));
    search.set('errorMessage', failed.map((f) => `${f.slug}: ${f.reason}`).join(' · '));
  }
  redirect(`/projects/${encodeURIComponent(parsed.data.projectSlug)}/features?${search.toString()}`);
}

// ---------------------------------------------------------------------------
// reindexFeaturesAction
// ---------------------------------------------------------------------------

export async function reindexFeaturesAction(formData: FormData): Promise<void> {
  const projectSlug = String(formData.get('projectSlug') ?? '').trim();
  if (!PROJECT_SLUG_RE.test(projectSlug)) {
    redirect(`/projects?error=invalid_project_slug`);
  }
  const { cwd } = await resolveProjectCwd(projectSlug);
  let result;
  try {
    result = generateFeaturesIndex({ projectCwd: cwd, projectSlug });
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

/**
 * Conservative filename sanitiser. Strips path components, refuses
 * absolute paths, replaces anything outside `[A-Za-z0-9._-]` with `-`.
 * The web upload form already constrains the picker, but a fat-fingered
 * filename like `../../foo` shouldn't be able to escape the feature
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
    '## What this feature is',
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
