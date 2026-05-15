'use server';

import { runInit } from '@coodra/cli/lib/init';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { refuseInTeamHosted } from '@/lib/action-guards';

/**
 * `apps/web/lib/actions/init.ts` — Server Action for the `/init`
 * wizard (M04 Phase 2 S3).
 *
 * Wraps the library-promoted `runInit()` from
 * `@coodra/cli/lib/init`. Form-side validation re-uses the
 * same slug regex as the CLI's `sanitizeSlug` so failures are caught
 * before the heavy init pipeline runs.
 *
 * Success path: `redirect('/projects/[newSlug]')` — the picker
 * re-fetches on next request and shows the new project tile.
 *
 * Failure path: `redirect('/init?error=<code>&...')` — the page
 * re-renders with the error banner + repopulates the form fields
 * from the querystring. We don't use `useFormState` because the
 * Phase 1 Server-Action pattern is redirect-with-querystring (per
 * kill-switches, policies, projects actions). Stay consistent.
 *
 * Note on `cwd`: the wizard runs inside the web's Node.js process,
 * which lives at `apps/web/` in dev or wherever next-server boots in
 * production. The form requires the user to type the absolute path
 * of the project they want to initialise — we DON'T silently use
 * `process.cwd()` because that would silently target a directory
 * the user doesn't expect.
 */

const FORM_SCHEMA = z.object({
  cwd: z
    .string()
    .min(1, 'cwd is required')
    .refine((v) => v.startsWith('/'), 'cwd must be an absolute path (start with /)'),
  projectSlug: z
    .string()
    .min(1, 'project slug is required')
    .max(64, 'project slug too long (max 64 characters)')
    .regex(/^[a-z0-9_-]+$/, 'project slug must be lowercase letters, digits, underscores, or hyphens only'),
  ide: z.enum(['claude', 'cursor', 'windsurf', 'all']).default('claude'),
  template: z.string().optional(),
  noGraphify: z.preprocess((v) => v === 'on' || v === 'true' || v === true, z.boolean()).default(true),
});

export async function initProjectAction(formData: FormData): Promise<void> {
  // `init` is inherently a local-laptop operation — it writes
  // .coodra.json + .mcp.json + scaffolds docs/feature-packs/ on
  // disk + wires Claude Code hook entries in ~/.claude/settings.json.
  // None of that has meaning on a Vercel server, so we refuse in
  // team-hosted mode. Developers who need init use the CLI.
  refuseInTeamHosted('initProjectAction');

  const raw = {
    cwd: String(formData.get('cwd') ?? '').trim(),
    projectSlug: String(formData.get('projectSlug') ?? '').trim(),
    ide: String(formData.get('ide') ?? 'claude'),
    template: (() => {
      const t = String(formData.get('template') ?? '').trim();
      return t === '' || t === 'minimal' ? undefined : t;
    })(),
    noGraphify: formData.get('noGraphify') ?? 'on',
  };

  const parsed = FORM_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    const firstError = parsed.error.issues[0];
    redirect(redirectWithError('validation_failed', firstError?.message ?? 'invalid form data', raw));
  }

  const { cwd, projectSlug, ide, template, noGraphify } = parsed.data;

  const result = await runInit({
    cwd,
    projectSlug,
    ide,
    noGraphify,
    ...(template !== undefined ? { template } : {}),
    // Mode 'minimal' matches CLI's default (skeleton output, no
    // template overlay). Web wizard explicit-set: when a template is
    // chosen, switch to 'default' so the template renders.
    mode: template !== undefined ? 'default' : 'minimal',
  });

  if (!result.ok) {
    redirect(redirectWithError(result.error, result.howToFix, raw));
  }
  redirect(`/projects/${encodeURIComponent(result.projectSlug)}`);
}

function redirectWithError(
  code: string,
  message: string,
  fields: { cwd: string; projectSlug: string; ide: string; template?: string | undefined },
): string {
  const search = new URLSearchParams();
  search.set('error', code);
  search.set('errorMessage', message);
  if (fields.cwd !== '') search.set('cwd', fields.cwd);
  if (fields.projectSlug !== '') search.set('projectSlug', fields.projectSlug);
  if (fields.ide !== '') search.set('ide', fields.ide);
  if (fields.template !== undefined && fields.template !== '') search.set('template', fields.template);
  return `/init?${search.toString()}`;
}
