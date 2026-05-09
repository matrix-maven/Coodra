'use server';

import { redirect } from 'next/navigation';

import { retryAllDeadJobs, retryDeadJob } from '@/lib/queries/sync';

/**
 * `apps/web/lib/actions/sync.ts` — Server Actions for the M04 Phase 2
 * S15 sync surface. Two retry shapes:
 *
 *   retrySingleJobAction(formData) — flip one dead job back to pending.
 *   retryQueueAction(formData)     — flip every dead job in a queue.
 *
 * Both redirect to /sync with a ?retried=<n> banner so the operator
 * can see how many rows actually moved.
 */

export async function retrySingleJobAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  if (id.length === 0) redirect('/sync?error=missing_id');
  const flipped = await retryDeadJob(id);
  redirect(`/sync?retried=${flipped}`);
}

export async function retryQueueAction(formData: FormData): Promise<void> {
  const queue = String(formData.get('queue') ?? '');
  if (queue.length === 0) redirect('/sync?error=missing_queue');
  const flipped = await retryAllDeadJobs(queue);
  redirect(`/sync?retriedQueue=${encodeURIComponent(queue)}&count=${flipped}`);
}
