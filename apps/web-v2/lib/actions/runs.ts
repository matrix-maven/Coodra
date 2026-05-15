'use server';

import { cancelRun } from '@coodra/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { assertActorRole } from '@/lib/action-guards';
import { createWebDb } from '@/lib/db';

/**
 * web-v2 server actions for run admin.
 *
 * `cancelRunAction` flips a stuck `in_progress` run to `cancelled` and
 * sets `endedAt = now()`. Used by the operator-side "force-complete"
 * affordance on the runs list and run detail pages — solo-mode dev
 * boxes accumulate ghost in_progress rows when Claude / Cursor exits
 * without firing SessionEnd.
 *
 * Idempotent: cancelling an already-terminal run is a no-op (the db
 * helper returns `{ status: 'noop' }` and we redirect with a banner).
 */

export async function cancelRunAction(formData: FormData): Promise<void> {
  await assertActorRole('admin');
  const id = String(formData.get('id') ?? '');
  const returnTo = String(formData.get('returnTo') ?? '/runs');
  if (id.length === 0) {
    redirect(`${returnTo}?error=missing_id`);
  }
  const handle = createWebDb();
  const result = await cancelRun(handle, id);
  revalidatePath('/runs');
  revalidatePath(`/runs/${id}`);
  revalidatePath('/');
  if (result.status === 'cancelled') {
    redirect(`${returnTo}?cancelled=${encodeURIComponent(id)}`);
  }
  if (result.status === 'already_terminal') {
    redirect(`${returnTo}?noop=${encodeURIComponent(id)}`);
  }
  redirect(`${returnTo}?error=${encodeURIComponent('not_found')}`);
}

/**
 * Bulk-cancel every `in_progress` run. Used by the dashboard's
 * "Cancel stuck runs" affordance to clean up the inevitable ghost
 * rows from agents that exited without firing SessionEnd.
 *
 * Optionally scoped to a single project via the `projectId` form
 * field. Returns the count of rows flipped via `?cleared=N`.
 */
export async function cancelAllInProgressRunsAction(formData: FormData): Promise<void> {
  await assertActorRole('admin');
  const projectId = formData.get('projectId');
  const returnTo = String(formData.get('returnTo') ?? '/');
  const handle = createWebDb();
  // Pull the in-flight rows directly so we can scope by project.
  const { listRunsForProject } = await import('@coodra/db');
  const filter =
    typeof projectId === 'string' && projectId.length > 0
      ? { status: 'in_progress' as const, projectId, limit: 1000 }
      : { status: 'in_progress' as const, limit: 1000 };
  const rows = await listRunsForProject(handle, filter);
  let cleared = 0;
  for (const r of rows) {
    const result = await cancelRun(handle, r.id);
    if (result.status === 'cancelled') cleared += 1;
  }
  revalidatePath('/runs');
  revalidatePath('/');
  redirect(`${returnTo}?cleared=${cleared}`);
}
