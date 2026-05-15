'use server';

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { postgresSchema, scheduleDurableWrite, sqliteSchema } from '@coodra/db';
import { runInit } from '@coodra/cli/lib/init';
import { runPackDelete, runPackRegenerate } from '@coodra/cli/lib/pack';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { assertActorRole, refuseInTeamHosted } from '@/lib/action-guards';
import { createWebDb } from '@/lib/db';
import { resolveDeploymentMode } from '@/lib/deployment-mode';
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
  // Pack regeneration writes spec.md / implementation.md / techstack.md
  // to <repo>/docs/feature-packs/<slug>/ on the local disk. In
  // team-hosted mode there's no repo on the server. Refuse + nudge
  // them toward the CLI.
  refuseInTeamHosted('regeneratePackAction');
  await assertActorRole('admin');
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
  refuseInTeamHosted('deletePackAction');
  await assertActorRole('admin');
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
  refuseInTeamHosted('installTemplateAction');
  await assertActorRole('admin');
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
  refuseInTeamHosted('saveFeaturePackAction');
  await assertActorRole('member');
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
  const pack = await getPack(packSlug, cwd);
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
  // Phase F.6+ (2026-05-11) — uploadPackAction now works in BOTH
  // local-team AND team-hosted modes. The split was leaky implementation
  // detail (user complaint, 2026-05-11): an admin opening the web wants
  // to upload a pack regardless of where the web is hosted.
  //
  // Mode behaviour:
  //   - local-solo:  writes FS only (no cloud, no Postgres dependency)
  //   - local-team:  writes FS (instant local feedback) + cloud (via sync queue)
  //                  → teammate laptops pull cloud → their FS materializes
  //   - team-hosted: writes cloud DIRECTLY (server has no project FS to write to)
  //                  → every laptop's sync-daemon pulls cloud → their FS
  //                    materializes (including the admin's own laptop)
  //
  // Source of truth: in team mode, cloud Postgres `feature_packs.content_json`.
  // FS files are derived/cached views materialized by the sync-daemon.
  const actor = await assertActorRole('member');
  const deploymentMode = resolveDeploymentMode();
  const isTeamHosted = deploymentMode === 'team-hosted';
  void actor;
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
  // "force" when they're uploading over a `coodra init` template stub
  // (the 4-file scaffold with Status:TODO content nobody asked for).
  // We treat uploading-over-a-stub as the obvious intent and allow it
  // silently. Real hand-written packs still require the explicit force
  // checkbox so the operator can't accidentally clobber their own work.
  let allowOverwrite = forceWrite;
  let stubReplaced = false;
  if (existsSync(dir) && !forceWrite) {
    const existing = (await listPacks(projectCwd)).find((p) => p.slug === slug);
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

  // -- Phase F.6+ — persist the pack (mode-aware) ----------------------------
  // local-solo + local-team: write FS for instant local feedback.
  // team-hosted: skip FS — server has no project FS; sync-daemon on every
  // teammate's laptop will materialize the file on next pull.
  if (!isTeamHosted) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(specPath, body, 'utf8');
      const meta = {
        slug,
        parentSlug: parentSlug ?? null,
        sourceFiles: [] as string[],
        isActive: true,
        kind: 'freeform' as const,
        status: 'published' as const,
      };
      writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    } catch (err) {
      redirect(uploadHref(projectSlug, 'write_failed', (err as Error).message));
    }
  }

  // -- Persist to the DB layer (cloud Postgres or local SQLite) --------------
  // mirrorPackToDbAndEnqueue handles both:
  //   - sqlite handle (local-team/local-solo): upsert row + enqueue
  //     sync_to_cloud job; the sync-daemon pushes to cloud Postgres
  //   - postgres handle (team-hosted): upsert cloud row directly; every
  //     teammate's sync-daemon (including the admin's) pulls + writes FS
  try {
    await mirrorPackToDbAndEnqueue({
      slug,
      parentSlug: parentSlug ?? null,
      content: {
        spec: body,
        implementation: '',
        techstack: '',
        meta: {
          slug,
          parentSlug: parentSlug ?? null,
          sourceFiles: [] as string[],
          isActive: true,
          kind: 'freeform' as const,
        },
        sourceFiles: [],
      },
    });
  } catch (err) {
    if (isTeamHosted) {
      // team-hosted has no FS fallback — if the cloud write fails, the pack
      // is genuinely lost. Surface the error instead of silently passing.
      redirect(uploadHref(projectSlug, 'cloud_write_failed', (err as Error).message));
    }
    // local modes: FS succeeded above, so the local user has the pack;
    // sync-daemon will retry the cloud push on backoff. Log + carry on.
    console.warn('uploadPackAction: cloud-sync mirror failed', err);
  }

  // -- Patch the project's primary pack to point at the upload ---------------
  // FS-only step: in team-hosted there's no primary meta.json on disk to
  // patch. The cloud parent-slug update is handled by mirrorPackToDbAndEnqueue
  // via the row's parentSlug column.
  if (willLink && projectSlug !== undefined && !isTeamHosted) {
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
/**
 * Phase F.3.b — toggle a feature_pack's status between 'draft' and
 * 'published'. Admin-only — pack drafts gate agent visibility, so a
 * member shouldn't be able to hide their teammates' published packs.
 *
 * The action:
 *   1. Asserts admin role (assertCanEditKnowledge with allowOwner=false).
 *   2. Reads the existing pack row to determine current status.
 *   3. Flips status. Updates updated_at.
 *   4. Enqueues sync_to_cloud in team mode.
 *   5. Redirects back to the pack detail page with a banner.
 *
 * Side effect: when transitioning published → draft, the existing
 * filesystem files are NOT deleted (Phase F.4 known limitation; the
 * MCP-side filter is what gates the agent). Promoting draft →
 * published re-writes nothing locally either; the puller on remote
 * machines is what materialises the FS files there.
 */
export async function togglePackStatusAction(formData: FormData): Promise<void> {
  // Phase F.6+ — works in BOTH local-team and team-hosted (cloud-direct write).
  const { assertCanEditKnowledge } = await import('@coodra/shared/auth');
  const actor = await (await import('@/lib/auth')).getActor();
  assertCanEditKnowledge(actor, { createdByUserId: null }, { allowOwner: false });

  const slugRaw = String(formData.get('slug') ?? '').trim();
  if (slugRaw.length === 0 || !FREEFORM_SLUG_RE.test(slugRaw)) {
    redirect('/packs?error=invalid_slug');
  }
  const handle = createWebDb();

  // Mode-aware row read + update. Both branches do the same logical
  // thing (read current status, flip, write); the dialect difference
  // is just which Drizzle schema we use.
  let nextStatus: 'draft' | 'published';
  if (handle.kind === 'sqlite') {
    const row = (
      await handle.db
        .select()
        .from(sqliteSchema.featurePacks)
        .where(eq(sqliteSchema.featurePacks.slug, slugRaw))
        .limit(1)
    )[0];
    if (row === undefined) {
      redirect(`/packs/${encodeURIComponent(slugRaw)}?error=pack_not_found`);
    }
    nextStatus = row.status === 'published' ? 'draft' : 'published';
    await handle.db
      .update(sqliteSchema.featurePacks)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(eq(sqliteSchema.featurePacks.slug, slugRaw));
  } else {
    const row = (
      await handle.db
        .select()
        .from(postgresSchema.featurePacks)
        .where(eq(postgresSchema.featurePacks.slug, slugRaw))
        .limit(1)
    )[0];
    if (row === undefined) {
      redirect(`/packs/${encodeURIComponent(slugRaw)}?error=pack_not_found`);
    }
    nextStatus = row.status === 'published' ? 'draft' : 'published';
    await handle.db
      .update(postgresSchema.featurePacks)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(eq(postgresSchema.featurePacks.slug, slugRaw));
  }

  // Phase F.6 — patch on-disk meta.json::status so the bridge
  // SessionStart loader (which is FS-only by design — see
  // `apps/hooks-bridge/src/lib/feature-pack-loader.ts`) respects the
  // gate. Without this, the admin's own agent sessions would still
  // see a "demoted" pack via additionalContext until the MCP-side
  // filter kicks in.
  //
  // Multi-project resolution: the dev's pack lives at the project's
  // cwd, not process.cwd() of the web server. Resolve via the
  // projects table — every registered non-sentinel project's
  // `<cwd>/docs/feature-packs/<slug>/meta.json` is a candidate, plus
  // the walk-up fallback for monorepo-style layouts. Patch every
  // matching meta.json found (a pack can legitimately exist under
  // multiple project roots; keeping them in lockstep prevents
  // drift). Best-effort write — failures don't roll back the DB
  // flip because the DB row + MCP filter remain authoritative.
  // Patch on-disk meta.json::status (local modes only — team-hosted has no FS).
  // Sync-daemons on every machine will pull the new status from cloud and
  // patch their own meta.json on the next tick.
  if (handle.kind === 'sqlite') {
    try {
      const candidates: string[] = [];
      const rows = handle.raw
        .prepare("SELECT cwd FROM projects WHERE cwd IS NOT NULL AND slug NOT LIKE '\\_\\_%' ESCAPE '\\'")
        .all() as Array<{ cwd: string }>;
      for (const r of rows) {
        candidates.push(join(packsRoot(r.cwd), slugRaw, 'meta.json'));
      }
      candidates.push(join(packsRoot(process.cwd()), slugRaw, 'meta.json'));

      const seen = new Set<string>();
      for (const metaPath of candidates) {
        if (seen.has(metaPath)) continue;
        seen.add(metaPath);
        if (!existsSync(metaPath)) continue;
        try {
          const rawMeta = readFileSync(metaPath, 'utf8');
          const meta = JSON.parse(rawMeta) as Record<string, unknown>;
          meta.status = nextStatus;
          writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
        } catch (err) {
          console.warn('togglePackStatusAction: meta.json parse/write failed at', metaPath, err);
        }
      }
    } catch (err) {
      console.warn('togglePackStatusAction: meta.json sync skipped', err);
    }
  }

  if (handle.kind === 'sqlite' && process.env.COODRA_MODE === 'team') {
    try {
      await scheduleDurableWrite(handle, {
        queue: 'sync_to_cloud',
        payload: {
          v: 1 as const,
          table: 'feature_packs',
          lookup: { kind: 'idempotency_key', value: slugRaw },
        },
      });
    } catch (err) {
      console.warn('togglePackStatusAction: sync enqueue failed', err);
    }
  }
  redirect(`/packs/${encodeURIComponent(slugRaw)}?statusFlipped=${nextStatus}`);
}

function uploadHref(projectSlug: string | undefined, errorCode: string, message: string): string {
  const search = new URLSearchParams();
  search.set('error', errorCode);
  search.set('errorMessage', message);
  if (projectSlug !== undefined) {
    return `/projects/${encodeURIComponent(projectSlug)}/packs/new?${search.toString()}`;
  }
  return `/packs/new?${search.toString()}`;
}

/**
 * Phase F.2.b + F.6+ — mirror a just-written pack into the DB layer.
 *
 *   - team-hosted (postgres handle): writes directly to cloud Postgres.
 *     Every teammate's sync-daemon (including the admin's own laptop)
 *     pulls + materializes the .md files within ~10s.
 *
 *   - local-team / local-solo (sqlite handle): writes to local SQLite +
 *     enqueues sync_to_cloud. The local sync-daemon pushes to cloud;
 *     other teammates pull from there.
 *
 * Single source of truth for pack content: cloud Postgres
 * `feature_packs.content_json`. Filesystem .md files are derived /
 * cached views that sync-daemons materialize on every machine.
 */
async function mirrorPackToDbAndEnqueue(args: {
  readonly slug: string;
  readonly parentSlug: string | null;
  readonly content: {
    readonly spec: string;
    readonly implementation: string;
    readonly techstack: string;
    readonly meta: object;
    readonly sourceFiles: ReadonlyArray<string>;
  };
}): Promise<void> {
  const handle = createWebDb();
  const checksum = `sha256:${createHash('sha256')
    .update(args.content.spec)
    .update(args.content.implementation)
    .update(args.content.techstack)
    .digest('hex')}`;
  const contentJson = JSON.stringify({
    spec: args.content.spec,
    implementation: args.content.implementation,
    techstack: args.content.techstack,
    meta: args.content.meta,
    sourceFiles: [...args.content.sourceFiles],
  });
  const now = new Date();

  // Phase F.6+ (2026-05-11) — dialect-aware upsert. Both branches do
  // the same logical thing; the difference is which Drizzle schema we
  // bind to. In team-hosted (postgres handle), the write goes directly
  // to cloud — no sync queue needed. In local modes (sqlite handle),
  // we write to local SQLite + enqueue sync_to_cloud which the local
  // sync-daemon dispatches.
  if (handle.kind === 'postgres') {
    const existing = (
      await handle.db
        .select()
        .from(postgresSchema.featurePacks)
        .where(eq(postgresSchema.featurePacks.slug, args.slug))
        .limit(1)
    )[0];
    const id = existing?.id ?? `fp_${randomUUID()}`;
    const isActive = existing?.isActive ?? true;
    await handle.db
      .insert(postgresSchema.featurePacks)
      .values({
        id,
        slug: args.slug,
        parentSlug: args.parentSlug,
        isActive,
        checksum,
        contentJson,
        status: existing?.status ?? 'published',
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: postgresSchema.featurePacks.slug,
        set: {
          parentSlug: args.parentSlug,
          checksum,
          contentJson,
          updatedAt: now,
        },
      });
    // No sync queue — we just wrote to cloud directly. Every
    // teammate's local sync-daemon (including the admin's own laptop)
    // will pull this row on its next tick.
    return;
  }

  // local-solo / local-team — write to local SQLite.
  const existing = (
    await handle.db
      .select()
      .from(sqliteSchema.featurePacks)
      .where(eq(sqliteSchema.featurePacks.slug, args.slug))
      .limit(1)
  )[0];
  const id = existing?.id ?? `fp_${randomUUID()}`;
  const isActive = existing?.isActive ?? true;

  await handle.db
    .insert(sqliteSchema.featurePacks)
    .values({
      id,
      slug: args.slug,
      parentSlug: args.parentSlug,
      isActive,
      checksum,
      contentJson,
      status: existing?.status ?? 'published',
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: sqliteSchema.featurePacks.slug,
      set: {
        parentSlug: args.parentSlug,
        checksum,
        contentJson,
        updatedAt: now,
      },
    });

  if (process.env.COODRA_MODE === 'team') {
    try {
      await scheduleDurableWrite(handle, {
        queue: 'sync_to_cloud',
        // feature_packs is keyed by slug globally; the dispatch case
        // accepts kind: 'idempotency_key' with value=slug (see
        // apps/sync-daemon/src/lib/dispatch.ts::syncFeaturePacks).
        payload: {
          v: 1 as const,
          table: 'feature_packs',
          lookup: { kind: 'idempotency_key', value: args.slug },
        },
      });
    } catch (err) {
      console.warn('mirrorPackToDbAndEnqueue: sync_to_cloud enqueue failed (will retry on next pack mutation)', err);
    }
  }
}
