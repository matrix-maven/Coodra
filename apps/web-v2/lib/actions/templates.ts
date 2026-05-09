'use server';

import { runTemplateInstall } from '@coodra/contextos-cli/lib/template';
import { redirect } from 'next/navigation';
import { z } from 'zod';

/**
 * `apps/web/lib/actions/templates.ts` — Server Action wrapping the
 * `runTemplateInstall` library promotion (M04 Phase 2 S13).
 *
 * The form on `/projects/[slug]/templates` calls this with
 * { source, name?, force? }. We validate, dispatch, redirect with a
 * success or error querystring banner.
 *
 * Source is a local absolute path. Remote git+https sources are
 * deferred to a future module per the CLI's S13 scope note.
 */

const SLUG_RE = /^[a-z0-9_-]+$/;

const SCHEMA = z.object({
  projectSlug: z.string().min(1).regex(SLUG_RE),
  source: z
    .string()
    .min(1, 'Source path is required.')
    .refine((v) => v.startsWith('/'), 'Source must be an absolute path.'),
  name: z
    .string()
    .max(64)
    .regex(/^[a-z0-9-]*$/, 'Name override must be lowercase letters, digits, hyphens.')
    .optional(),
  force: z.string().optional(),
});

export async function installTemplateFromPathAction(formData: FormData): Promise<void> {
  const raw = {
    projectSlug: String(formData.get('projectSlug') ?? ''),
    source: String(formData.get('source') ?? '').trim(),
    name: String(formData.get('name') ?? '').trim() || undefined,
    force: formData.get('force') === 'on' ? 'on' : undefined,
  };
  const parsed = SCHEMA.safeParse(raw);
  if (!parsed.success) {
    redirect(redirectHref(raw.projectSlug, 'validation_failed', firstZodMessage(parsed.error)));
  }
  const result = await runTemplateInstall({
    source: parsed.data.source,
    ...(parsed.data.name !== undefined && parsed.data.name.length > 0 ? { name: parsed.data.name } : {}),
    ...(parsed.data.force === 'on' ? { force: true } : {}),
  });
  if (!result.ok) {
    redirect(redirectHref(parsed.data.projectSlug, result.error, result.howToFix));
  }
  redirect(`/templates?installed=${encodeURIComponent(result.installed)}`);
}

function redirectHref(_projectSlug: string, errorCode: string, message: string): string {
  // v2 has a flat IA — templates live at /templates regardless of project.
  const search = new URLSearchParams();
  search.set('error', errorCode);
  search.set('errorMessage', message);
  return `/templates?${search.toString()}`;
}

function firstZodMessage(err: z.ZodError): string {
  const issue = err.issues[0];
  if (issue === undefined) return 'invalid form data';
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}
