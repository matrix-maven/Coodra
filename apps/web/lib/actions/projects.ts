'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { resetProject } from '@/lib/queries/projects';

/**
 * Server actions for project admin (M04 S6). The reset action is a
 * destructive op — the form requires the user to type the slug
 * verbatim to enable submit (per spec §6 + wireframes/projects.md
 * "Reset confirmation"). Server-side we re-validate that the typed
 * value matches the project's slug before calling resetProject.
 *
 * `keepPolicies` defaults to true (matches CLI's `project reset
 * --keep-policies` default per M08b S10).
 */

export async function resetProjectAction(formData: FormData): Promise<void> {
  const identifier = String(formData.get('identifier') ?? '');
  const confirmation = String(formData.get('confirmation') ?? '');
  const keepPolicies = formData.get('alsoDeletePolicies') !== 'on';

  if (identifier.length === 0) {
    redirect('/projects?error=missing_identifier');
  }
  if (confirmation !== identifier) {
    redirect(
      `/projects/${encodeURIComponent(identifier)}?error=${encodeURIComponent('Confirmation slug did not match. Type the project slug verbatim to confirm.')}`,
    );
  }

  let result: Awaited<ReturnType<typeof resetProject>>;
  try {
    result = await resetProject(identifier, { keepPolicies });
  } catch (err) {
    redirect(`/projects/${encodeURIComponent(identifier)}?error=${encodeURIComponent((err as Error).message)}`);
  }
  if (result === null) {
    redirect(`/projects?error=${encodeURIComponent(`No project with identifier '${identifier}'`)}`);
  }

  revalidatePath('/projects');
  revalidatePath(`/projects/${identifier}`);

  // Hand the deletion-counts back via querystring for the success
  // banner on /projects.
  const summary = `${result.runsDeleted} runs · ${result.runEventsDeleted} events · ${result.decisionsDeleted} decisions · ${result.policyDecisionsDeleted} policy_decisions · ${result.contextPacksDeleted} context_packs`;
  redirect(`/projects?reset=${encodeURIComponent(identifier)}&summary=${encodeURIComponent(summary)}`);
}
