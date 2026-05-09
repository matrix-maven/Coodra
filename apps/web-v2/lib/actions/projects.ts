'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { deleteProject, renameProject, resetProject } from '@/lib/queries/projects';

/**
 * Server actions for project admin (M04 S6 + M04 Phase 2 S14).
 *
 * The reset action is the original Phase 1 destructive op (deletes
 * runs / events / decisions / policy_decisions / context_packs;
 * keeps policies by default). S14 adds rename + full delete; both
 * use a typed-confirm gate.
 */

const SLUG_RE = /^[a-z0-9_-]+$/;

const RENAME_SCHEMA = z.object({
  identifier: z.string().min(1),
  newSlug: z.string().min(1).regex(SLUG_RE, 'Slug must be lowercase letters, digits, hyphens, underscores.'),
  confirmation: z.string().min(1, 'Type the new slug to confirm.'),
});

const DELETE_SCHEMA = z.object({
  identifier: z.string().min(1),
  confirmation: z.string().min(1, 'Type the project slug to confirm full deletion.'),
});

export async function resetProjectAction(formData: FormData): Promise<void> {
  const identifier = String(formData.get('identifier') ?? '');
  const confirmation = String(formData.get('confirmation') ?? '');
  const keepPolicies = formData.get('alsoDeletePolicies') !== 'on';

  if (identifier.length === 0) {
    redirect('/?error=missing_identifier');
  }
  // The page passes the project's id as `identifier` but the user
  // types the slug. We re-fetch the project to map id → slug for
  // the comparison.
  const { getProject } = await import('@/lib/queries/projects');
  const project = await getProject(identifier);
  if (project === null) {
    redirect(`/?error=${encodeURIComponent(`No project '${identifier}'`)}`);
  }
  if (confirmation !== project.slug) {
    redirect(
      `/projects/${encodeURIComponent(project.slug)}?error=${encodeURIComponent('Confirmation slug did not match. Type the project slug verbatim to confirm.')}`,
    );
  }

  let result: Awaited<ReturnType<typeof resetProject>>;
  try {
    result = await resetProject(project.id, { keepPolicies });
  } catch (err) {
    redirect(`/projects/${encodeURIComponent(project.slug)}?error=${encodeURIComponent((err as Error).message)}`);
  }
  if (result === null) {
    redirect(`/?error=${encodeURIComponent(`No project with identifier '${identifier}'`)}`);
  }

  revalidatePath('/');
  revalidatePath(`/projects/${project.slug}`);

  const summary = `${result.runsDeleted} runs · ${result.runEventsDeleted} events · ${result.decisionsDeleted} decisions · ${result.policyDecisionsDeleted} policy_decisions · ${result.contextPacksDeleted} context_packs`;
  redirect(`/projects/${encodeURIComponent(project.slug)}?reset=1&summary=${encodeURIComponent(summary)}`);
}

// ---------------------------------------------------------------------------
// renameProjectAction (S14)
// ---------------------------------------------------------------------------

export async function renameProjectAction(formData: FormData): Promise<void> {
  const raw = {
    identifier: String(formData.get('identifier') ?? ''),
    newSlug: String(formData.get('newSlug') ?? '').trim(),
    confirmation: String(formData.get('confirmation') ?? '').trim(),
  };
  const parsed = RENAME_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    redirect(settingsHref(raw.identifier, 'rename_validation_failed', firstZodMessage(parsed.error)));
  }
  if (parsed.data.confirmation !== parsed.data.newSlug) {
    redirect(
      settingsHref(raw.identifier, 'rename_confirmation_mismatch', `Type "${parsed.data.newSlug}" exactly to confirm.`),
    );
  }
  const result = await renameProject(parsed.data.identifier, parsed.data.newSlug);
  if (result.status === 'not_found') {
    redirect(`/?error=${encodeURIComponent('Project not found')}`);
  }
  if (result.status === 'sentinel_locked') {
    redirect(settingsHref(raw.identifier, 'sentinel_locked', 'Cannot rename the __global__ sentinel project.'));
  }
  if (result.status === 'slug_taken') {
    redirect(
      settingsHref(
        raw.identifier,
        'slug_taken',
        `Slug "${result.newSlug}" is already taken (or invalid). Pick a different one.`,
      ),
    );
  }
  // Renamed — redirect to the new URL.
  revalidatePath('/');
  redirect(`/projects/${encodeURIComponent(result.newSlug)}?renamed=${encodeURIComponent(result.oldSlug)}`);
}

// ---------------------------------------------------------------------------
// deleteProjectAction (S14)
// ---------------------------------------------------------------------------

export async function deleteProjectAction(formData: FormData): Promise<void> {
  const raw = {
    identifier: String(formData.get('identifier') ?? ''),
    confirmation: String(formData.get('confirmation') ?? '').trim(),
  };
  const parsed = DELETE_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    redirect(settingsHref(raw.identifier, 'delete_validation_failed', firstZodMessage(parsed.error)));
  }
  const { getProject } = await import('@/lib/queries/projects');
  const project = await getProject(parsed.data.identifier);
  if (project === null) {
    redirect(`/?error=${encodeURIComponent('Project not found')}`);
  }
  if (parsed.data.confirmation !== project.slug) {
    redirect(
      settingsHref(
        raw.identifier,
        'delete_confirmation_mismatch',
        `Type "${project.slug}" exactly to confirm full deletion.`,
      ),
    );
  }
  const result = await deleteProject(parsed.data.identifier);
  if (result.status === 'sentinel_locked') {
    redirect(settingsHref(raw.identifier, 'sentinel_locked', 'Cannot delete the __global__ sentinel project.'));
  }
  if (result.status === 'not_found') {
    redirect(`/?error=${encodeURIComponent('Project not found')}`);
  }
  revalidatePath('/');
  redirect(`/?deleted=${encodeURIComponent(project.slug)}`);
}

function settingsHref(identifier: string, errorCode: string, message: string): string {
  // v2 has flat IA — project settings live inline on /projects/[slug] for now.
  const search = new URLSearchParams();
  search.set('error', errorCode);
  search.set('errorMessage', message);
  return `/projects/${encodeURIComponent(identifier)}?${search.toString()}`;
}

function firstZodMessage(err: z.ZodError): string {
  const issue = err.issues[0];
  if (issue === undefined) return 'invalid form data';
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}
