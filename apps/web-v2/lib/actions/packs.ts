'use server';

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runInit } from '@coodra/contextos-cli/lib/init';
import { runPackDelete, runPackRegenerate } from '@coodra/contextos-cli/lib/pack';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import {
  compareMarkerSets,
  deltaIsEmpty,
  describeDelta,
  parseAutoSections,
  summarizeParseErrors,
} from '@/lib/feature-pack-markers';
import { getPack, listPacks, META_SCHEMA, packsRoot } from '@/lib/queries/packs';

/**
 * `apps/web/lib/actions/packs.ts` — Server Actions for the pack
 * mutation surface (M04 Phase 2 S5).
 *
 * Three actions, all reachable from the action bar on
 * `/projects/[slug]/packs/[packSlug]`:
 *
 *   regeneratePackAction(formData)  — single yes/no confirmation;
 *                                     wraps `runPackRegenerate` from
 *                                     the CLI library promotion.
 *
 *   deletePackAction(formData)      — typed-confirm "delete <slug>";
 *                                     wraps `runPackDelete`. Per
 *                                     OQ-7 lock (S5 default): hard-
 *                                     deletes the on-disk dir AND
 *                                     soft-flips feature_packs.
 *                                     is_active = false (matches the
 *                                     real CLI behaviour).
 *
 *   installTemplateAction(formData) — typed-confirm "install <name>";
 *                                     wraps `runInit({mode:'default',
 *                                     template:<name>, force:true})`
 *                                     to overlay a template on the
 *                                     existing pack.
 *
 * Form-side validation re-uses the CLI's slug regex. Failures
 * redirect with `?error=&errorMessage=` so the page can re-render the
 * action bar with an inline banner. Successes redirect to the pack
 * list (delete) or back to the pack detail (regen / install) with a
 * success banner.
 *
 * Why all three live in one file: they share the Zod schemas,
 * redirect helpers, and project-scope plumbing. Keeping them in a
 * single module keeps imports simple in the page.
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9_-]+$/;

const COMMON_FIELDS = z.object({
  projectSlug: z.string().min(1).regex(SLUG_RE),
  packSlug: z.string().min(1).regex(SLUG_RE),
  cwd: z
    .string()
    .min(1, 'cwd is required')
    .refine((v) => v.startsWith('/'), 'cwd must be an absolute path'),
});

const REGEN_SCHEMA = COMMON_FIELDS.extend({
  confirm: z.string().refine((v) => v === 'yes', 'Tick the confirm box to regenerate.'),
});

const DELETE_SCHEMA = COMMON_FIELDS.extend({
  confirmation: z.string().min(1, 'Type the confirmation phrase to delete.'),
});

const INSTALL_SCHEMA = COMMON_FIELDS.extend({
  templateName: z
    .string()
    .min(1, 'Pick a template to install.')
    .regex(/^[a-z0-9-]+$/, 'Template name must be lowercase letters, digits, hyphens.'),
  confirmation: z.string().min(1, 'Type the confirmation phrase to install.'),
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function regeneratePackAction(formData: FormData): Promise<void> {
  const raw = {
    projectSlug: String(formData.get('projectSlug') ?? ''),
    packSlug: String(formData.get('packSlug') ?? ''),
    cwd: String(formData.get('cwd') ?? ''),
    confirm: String(formData.get('confirm') ?? ''),
  };
  const parsed = REGEN_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    redirect(packDetailHref(raw.projectSlug, raw.packSlug, 'regen_validation_failed', firstZodMessage(parsed.error)));
  }
  const result = await runPackRegenerate({
    slug: parsed.data.packSlug,
    cwd: parsed.data.cwd,
    mode: 'default',
  });
  if (!result.ok) {
    redirect(packDetailHref(parsed.data.projectSlug, parsed.data.packSlug, result.error, result.howToFix));
  }
  redirect(`${packDetailBase(parsed.data.projectSlug, parsed.data.packSlug)}?regenerated=1`);
}

export async function deletePackAction(formData: FormData): Promise<void> {
  const raw = {
    projectSlug: String(formData.get('projectSlug') ?? ''),
    packSlug: String(formData.get('packSlug') ?? ''),
    cwd: String(formData.get('cwd') ?? ''),
    confirmation: String(formData.get('confirmation') ?? ''),
  };
  const parsed = DELETE_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    redirect(packDetailHref(raw.projectSlug, raw.packSlug, 'delete_validation_failed', firstZodMessage(parsed.error)));
  }
  const expectedConfirm = `delete ${parsed.data.packSlug}`;
  if (parsed.data.confirmation !== expectedConfirm) {
    redirect(
      packDetailHref(
        parsed.data.projectSlug,
        parsed.data.packSlug,
        'delete_confirmation_mismatch',
        `Confirmation phrase must be "${expectedConfirm}" exactly.`,
      ),
    );
  }
  const result = await runPackDelete({
    slug: parsed.data.packSlug,
    cwd: parsed.data.cwd,
  });
  if (!result.ok) {
    redirect(packDetailHref(parsed.data.projectSlug, parsed.data.packSlug, result.error, result.howToFix));
  }
  // Pack is gone — redirect to the project's pack list with a banner.
  redirect(`/packs?deleted=${encodeURIComponent(parsed.data.packSlug)}`);
}

/**
 * Optional `returnTo` form field. When set to a `/projects/<slug>` path,
 * success / failure redirects land on the project home instead of the
 * pack detail page — used by the project-home "Install template…"
 * disclosure so the operator stays in project context.
 *
 * Strict regex (`/^\/projects\/[a-z0-9_-]+$/`) prevents open-redirect
 * attacks: anything else falls back to the default packDetailHref path.
 */
const PROJECT_RETURN_TO_RE = /^\/projects\/[a-z0-9_-]+$/;

export async function installTemplateAction(formData: FormData): Promise<void> {
  const raw = {
    projectSlug: String(formData.get('projectSlug') ?? ''),
    packSlug: String(formData.get('packSlug') ?? ''),
    cwd: String(formData.get('cwd') ?? ''),
    templateName: String(formData.get('templateName') ?? ''),
    confirmation: String(formData.get('confirmation') ?? ''),
  };
  const returnToRaw = String(formData.get('returnTo') ?? '');
  const returnTo = PROJECT_RETURN_TO_RE.test(returnToRaw) ? returnToRaw : null;

  const parsed = INSTALL_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    redirect(
      installErrorHref(
        returnTo,
        raw.projectSlug,
        raw.packSlug,
        'install_validation_failed',
        firstZodMessage(parsed.error),
      ),
    );
  }
  const expectedConfirm = `install ${parsed.data.templateName}`;
  if (parsed.data.confirmation !== expectedConfirm) {
    redirect(
      installErrorHref(
        returnTo,
        parsed.data.projectSlug,
        parsed.data.packSlug,
        'install_confirmation_mismatch',
        `Confirmation phrase must be "${expectedConfirm}" exactly.`,
      ),
    );
  }
  // Template overlay = init with --force + the template selector. The
  // pack's existing user-edited content (outside auto-marker sections)
  // is preserved by the seedFeaturePack merge logic.
  const result = await runInit({
    cwd: parsed.data.cwd,
    projectSlug: parsed.data.packSlug,
    ide: 'claude',
    noGraphify: true,
    template: parsed.data.templateName,
    mode: 'default',
    force: true,
  });
  if (!result.ok) {
    redirect(installErrorHref(returnTo, parsed.data.projectSlug, parsed.data.packSlug, result.error, result.howToFix));
  }
  if (returnTo !== null) {
    const search = new URLSearchParams();
    search.set('templateInstalled', parsed.data.templateName);
    redirect(`${returnTo}?${search.toString()}`);
  }
  redirect(
    `${packDetailBase(parsed.data.projectSlug, parsed.data.packSlug)}?installed=${encodeURIComponent(parsed.data.templateName)}`,
  );
}

function installErrorHref(
  returnTo: string | null,
  projectSlug: string,
  packSlug: string,
  errorCode: string,
  message: string,
): string {
  // When the operator submitted from a project home, route errors back
  // there — they expect the next page paint to be the project, not the
  // pack detail. Pack detail remains the default for the existing
  // `/packs/[slug]` action bar.
  if (returnTo !== null) {
    const search = new URLSearchParams();
    search.set('error', errorCode);
    search.set('errorMessage', message);
    return `${returnTo}?${search.toString()}`;
  }
  return packDetailHref(projectSlug, packSlug, errorCode, message);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function packDetailBase(_projectSlug: string, packSlug: string): string {
  // v2 has a flat IA — packs live under /packs/[slug] not under projects.
  return `/packs/${encodeURIComponent(packSlug)}`;
}

function packDetailHref(projectSlug: string, packSlug: string, errorCode: string, message: string): string {
  const search = new URLSearchParams();
  search.set('error', errorCode);
  search.set('errorMessage', message);
  return `${packDetailBase(projectSlug, packSlug)}?${search.toString()}`;
}

function firstZodMessage(err: z.ZodError): string {
  const issue = err.issues[0];
  if (issue === undefined) return 'invalid form data';
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}

// ---------------------------------------------------------------------------
// S6 — saveFeaturePackAction
// ---------------------------------------------------------------------------

const EDITABLE_FILES = ['spec.md', 'implementation.md', 'techstack.md'] as const;

const SAVE_SCHEMA = COMMON_FIELDS.extend({
  fileName: z.enum(EDITABLE_FILES),
  // mtimeMs is the file mtime captured when the editor loaded — used as
  // a cheap optimistic-concurrency check. If anyone else (CLI / sync /
  // other editor tab) wrote to the file in the meantime, we refuse the
  // save so the user can re-fetch and re-apply their edit.
  mtimeMs: z.coerce.number().int().nonnegative(),
  content: z.string().max(1_000_000, 'content exceeds 1MB'),
});

export async function saveFeaturePackAction(formData: FormData): Promise<void> {
  const raw = {
    projectSlug: String(formData.get('projectSlug') ?? ''),
    packSlug: String(formData.get('packSlug') ?? ''),
    cwd: String(formData.get('cwd') ?? ''),
    fileName: String(formData.get('fileName') ?? ''),
    mtimeMs: String(formData.get('mtimeMs') ?? '0'),
    content: String(formData.get('content') ?? ''),
  };
  const parsed = SAVE_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    redirect(
      editHref(raw.projectSlug, raw.packSlug, raw.fileName, 'save_validation_failed', firstZodMessage(parsed.error)),
    );
  }
  const { projectSlug, packSlug, cwd, fileName, mtimeMs, content } = parsed.data;

  // Pack lookup. Per S5/S6 we trust the project ownership check on the
  // editor page; here we re-read the pack so we have the on-disk source
  // for marker validation.
  const pack = getPack(packSlug, cwd);
  if (pack === null) {
    redirect(
      editHref(projectSlug, packSlug, fileName, 'pack_not_found', `No pack at docs/feature-packs/${packSlug}/.`),
    );
  }

  const filePath = join(pack.dir, fileName);

  // Optimistic concurrency: re-stat. If mtime has shifted, refuse.
  let onDiskMtime: number;
  try {
    onDiskMtime = statSync(filePath).mtimeMs;
  } catch {
    redirect(editHref(projectSlug, packSlug, fileName, 'file_missing', `File ${fileName} no longer exists on disk.`));
  }
  if (Math.floor(onDiskMtime) !== Math.floor(mtimeMs)) {
    redirect(
      editHref(
        projectSlug,
        packSlug,
        fileName,
        'concurrent_edit',
        `${fileName} changed on disk since you opened the editor. Reload to pick up the latest version, then re-apply your edit.`,
      ),
    );
  }

  // Marker integrity: re-parse the on-disk file (BEFORE writing) and the
  // user's edited content. The web editor only allows inner-content
  // edits — adding / removing / renaming / reordering markers is the
  // job of `pack regenerate` or template install (S5).
  const onDisk = readFileOrEmpty(filePath);
  const before = parseAutoSections(onDisk);
  const after = parseAutoSections(content);

  if (after.errors.length > 0) {
    redirect(editHref(projectSlug, packSlug, fileName, 'parse_failed', summarizeParseErrors(after.errors)));
  }
  const delta = compareMarkerSets(before, after);
  if (!deltaIsEmpty(delta)) {
    redirect(
      editHref(
        projectSlug,
        packSlug,
        fileName,
        'markers_tampered',
        `Auto-marker set must remain unchanged. ${describeDelta(delta)}. Use "Regenerate" or "Install template" to add/remove sections.`,
      ),
    );
  }

  // Write. Use writeFileSync — Server Actions are short-lived, the file
  // is small, and the surface lives next to other sync filesystem ops
  // already (queries/packs.ts is sync).
  try {
    writeFileSync(filePath, content, 'utf8');
  } catch (err) {
    redirect(editHref(projectSlug, packSlug, fileName, 'write_failed', (err as Error).message));
  }

  redirect(`${packDetailBase(projectSlug, packSlug)}?edited=${encodeURIComponent(fileName)}`);
}

function editHref(
  _projectSlug: string,
  packSlug: string,
  fileName: string,
  errorCode: string,
  message: string,
): string {
  const search = new URLSearchParams();
  search.set('file', fileName);
  search.set('error', errorCode);
  search.set('errorMessage', message);
  return `/packs/${encodeURIComponent(packSlug)}/edit?${search.toString()}`;
}

function readFileOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// uploadPackAction — freeform markdown upload (skill-style packs)
// ---------------------------------------------------------------------------
//
// Counterpart to the structured `installTemplateAction` flow. Lets the
// operator drop a single markdown file (or paste body text) into the
// packs root as a freeform reference document — the agent picks it up
// on the next `get_feature_pack { slug }` call (the MCP-side reader at
// apps/mcp-server/src/lib/feature-pack.ts lazy-walks disk and upserts
// `feature_packs` row on first read, so no DB write is needed here).
//
// On disk:
//   - <packsRoot>/<slug>/spec.md       ← uploaded markdown verbatim
//   - <packsRoot>/<slug>/meta.json     ← { slug, parentSlug, sourceFiles: [], isActive: true, kind: 'freeform' }
//
// Why spec.md (not skill.md or notes.md): the existing `getPack` /
// detail-page render path keys off the four canonical filenames. Putting
// the body in spec.md means the upload appears in the existing pack
// detail UI immediately — no special-casing required. The `kind` field
// in meta.json gives later UI a way to label freeform packs vs.
// template-rendered ones.

const FREEFORM_SLUG_RE = /^[a-z0-9_-]+$/;

const UPLOAD_SCHEMA = z
  .object({
    slug: z
      .string()
      .min(1, 'slug is required')
      .max(64, 'slug is too long')
      .regex(FREEFORM_SLUG_RE, 'slug must be lowercase letters, digits, hyphens or underscores'),
    parentSlug: z
      .string()
      .regex(FREEFORM_SLUG_RE, 'parentSlug must be lowercase letters, digits, hyphens or underscores')
      .optional(),
    content: z.string().min(1, 'paste markdown body or attach a .md file').max(2_000_000, 'content exceeds 2MB'),
    force: z.boolean().optional(),
    /**
     * Project context. When set, success / error redirects land on
     * `/projects/<projectSlug>` (or its `packs/new` child) instead of
     * the global `/packs/new`. Used by the per-project upload route at
     * `app/projects/[slug]/packs/new/page.tsx` (M04 Phase 2 +
     * 2026-05-08 per-project pack feature).
     */
    projectSlug: z
      .string()
      .regex(FREEFORM_SLUG_RE, 'projectSlug must be lowercase letters, digits, hyphens or underscores')
      .optional(),
    /**
     * Auto-link as parent of the project's primary pack. Honored only
     * when `projectSlug` is set AND `slug !== projectSlug`. Patches
     * `<projectSlug>/meta.json:parentSlug = <slug>` after the upload
     * completes. Pre-flight refuses if the primary pack is missing.
     */
    linkAsParent: z.boolean().optional(),
  })
  .refine((d) => d.parentSlug !== d.slug, {
    message: 'a pack cannot be its own parent',
    path: ['parentSlug'],
  });

export async function uploadPackAction(formData: FormData): Promise<void> {
  // Either a file is attached OR markdown is pasted into the textarea.
  // File wins when both are present.
  let content = String(formData.get('content') ?? '');
  const fileEntry = formData.get('file');

  // Read project-context fields up-front so error redirects can land
  // back on the project-scoped form when applicable.
  const projectSlugRaw = String(formData.get('projectSlug') ?? '').trim();
  const projectSlug = projectSlugRaw.length > 0 ? projectSlugRaw : undefined;
  // The per-project upload form sends `projectCwd` (from `projects.cwd`) so
  // writes land inside the actual project root, not the web-v2 server's cwd.
  // Must be an absolute path. Empty / non-absolute → fall back to web-v2 cwd
  // (matches the read-side fallback in `packsRoot()` for legacy rows).
  const projectCwdRaw = String(formData.get('projectCwd') ?? '').trim();
  const projectCwd = projectCwdRaw.length > 0 && projectCwdRaw.startsWith('/') ? projectCwdRaw : process.cwd();

  if (fileEntry instanceof File && fileEntry.size > 0) {
    // 2MB is plenty for a skill-style reference doc; the schema bound
    // catches abuse below.
    if (fileEntry.size > 2_000_000) {
      redirect(uploadHref(projectSlug, 'upload_too_large', `File ${fileEntry.name} exceeds 2MB.`));
    }
    content = await fileEntry.text();
  }

  const slugRaw = String(formData.get('slug') ?? '').trim();
  const parentSlugRaw = String(formData.get('parentSlug') ?? '').trim();
  const force = formData.get('force') === 'on' || formData.get('force') === 'true';
  const linkAsParent = formData.get('linkAsParent') === 'on' || formData.get('linkAsParent') === 'true';

  const parsed = UPLOAD_SCHEMA.safeParse({
    slug: slugRaw,
    ...(parentSlugRaw.length > 0 ? { parentSlug: parentSlugRaw } : {}),
    content,
    force,
    ...(projectSlug !== undefined ? { projectSlug } : {}),
    linkAsParent,
  });
  if (!parsed.success) {
    redirect(uploadHref(projectSlug, 'upload_validation_failed', firstZodMessage(parsed.error)));
  }
  const { slug, parentSlug, content: body, force: forceWrite, linkAsParent: shouldLink } = parsed.data;

  const root = packsRoot(projectCwd);
  const dir = join(root, slug);
  const specPath = join(dir, 'spec.md');
  const metaPath = join(dir, 'meta.json');

  // -- Pre-flight checks (no disk writes yet) ----------------------------------
  // The auto-link step needs the project's primary pack to already exist on
  // disk so we have a meta.json to patch. Refusing here keeps the filesystem
  // consistent: nothing gets written if the link can't follow.
  const willLink = projectSlug !== undefined && shouldLink && slug !== projectSlug;
  if (willLink && projectSlug !== undefined) {
    const primaryMetaPath = join(root, projectSlug, 'meta.json');
    if (!existsSync(primaryMetaPath)) {
      redirect(
        uploadHref(
          projectSlug,
          'primary_pack_missing',
          `Project '${projectSlug}' has no primary pack to link onto. Submit again with slug=${projectSlug} (replace primary directly), or run /init to bootstrap with a template.`,
        ),
      );
    }
    // Trivial 2-cycle guard: if the just-uploaded pack declares the project
    // slug as its own parent AND we'd patch the primary's parent to the
    // upload, we'd create A→B→A. Refuse.
    if (parentSlug === projectSlug) {
      redirect(
        uploadHref(
          projectSlug,
          'parent_cycle',
          `Cannot link: pack '${slug}' already has parentSlug='${projectSlug}', and auto-link would point '${projectSlug}'→'${slug}'. Drop the parentSlug field, or untick auto-link.`,
        ),
      );
    }
  }

  // Pack-exists guard. The cleanest UX: don't make the operator tick
  // "force" when they're uploading over a `contextos init` template stub
  // (the 4-file scaffold with Status:TODO content nobody asked for).
  // We treat uploading-over-a-stub as the obvious intent and allow it
  // silently. Real hand-written packs still require the explicit force
  // checkbox so the operator can't accidentally clobber their own work.
  let allowOverwrite = forceWrite;
  let stubReplaced = false;
  if (existsSync(dir) && !forceWrite) {
    const existing = listPacks(projectCwd).find((p) => p.slug === slug);
    if (existing !== undefined && existing.isTemplateStub) {
      allowOverwrite = true;
      stubReplaced = true;
    } else {
      redirect(
        uploadHref(
          projectSlug,
          'pack_exists',
          `Pack '${slug}' already exists at ${dir}. Tick "overwrite" to replace its spec.md, or pick a different slug.`,
        ),
      );
    }
  }
  // forceWrite is consumed below via `allowOverwrite`; reference it so
  // future readers don't think the variable is dead.
  void allowOverwrite;

  // -- Write the new/overwritten pack ----------------------------------------
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(specPath, body, 'utf8');
    const meta = {
      slug,
      parentSlug: parentSlug ?? null,
      sourceFiles: [] as string[],
      isActive: true,
      kind: 'freeform' as const,
    };
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  } catch (err) {
    redirect(uploadHref(projectSlug, 'write_failed', (err as Error).message));
  }

  // -- Patch the project's primary pack to point at the upload ---------------
  if (willLink && projectSlug !== undefined) {
    const primaryMetaPath = join(root, projectSlug, 'meta.json');
    try {
      const raw = readFileSync(primaryMetaPath, 'utf8');
      const parsedMeta = META_SCHEMA.safeParse(JSON.parse(raw));
      if (!parsedMeta.success) {
        redirect(
          uploadHref(
            projectSlug,
            'primary_meta_invalid',
            `Primary pack's meta.json failed validation: ${parsedMeta.error.issues.map((i) => i.message).join('; ')}.`,
          ),
        );
      }
      const next = { ...parsedMeta.data, parentSlug: slug };
      writeFileSync(primaryMetaPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    } catch (err) {
      redirect(uploadHref(projectSlug, 'link_write_failed', (err as Error).message));
    }
  }

  // -- Redirect to the right surface for the operator ------------------------
  if (projectSlug !== undefined) {
    const search = new URLSearchParams();
    search.set('packUploaded', slug);
    search.set('linked', willLink ? '1' : '0');
    if (stubReplaced) search.set('replaced', 'stub');
    redirect(`/projects/${encodeURIComponent(projectSlug)}?${search.toString()}`);
  }
  redirect(`/packs/${encodeURIComponent(slug)}?uploaded=1${stubReplaced ? '&replaced=stub' : ''}`);
}

/**
 * Build the error-redirect href for the upload form. When invoked from a
 * project-scoped page, error banners stay on the project's `packs/new`
 * route so the operator can fix and re-submit without losing context.
 */
function uploadHref(projectSlug: string | undefined, errorCode: string, message: string): string {
  const search = new URLSearchParams();
  search.set('error', errorCode);
  search.set('errorMessage', message);
  if (projectSlug !== undefined) {
    return `/projects/${encodeURIComponent(projectSlug)}/packs/new?${search.toString()}`;
  }
  return `/packs/new?${search.toString()}`;
}
