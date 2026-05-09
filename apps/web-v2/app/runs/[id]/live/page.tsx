import { notFound } from 'next/navigation';

import { runStateLastModified, serializeRunState } from '@/lib/queries/run-state';
import { getRun } from '@/lib/queries/runs';

import { RunLiveClient } from './RunLiveClient';

/**
 * `/runs/[id]/live` — server-rendered initial snapshot, then client-
 * side polling against `/api/runs/[id]/state` every 1500ms (per the
 * existing apps/web pattern). The server seeds RunLiveClient with the
 * first paint so users don't see a spinner.
 */

export const dynamic = 'force-dynamic';

export default async function RunLivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const snapshot = await getRun(id);
  if (snapshot === null) notFound();
  const lastModified = runStateLastModified(snapshot).toUTCString();
  return <RunLiveClient runId={id} initialSnapshot={serializeRunState(snapshot)} initialLastModified={lastModified} />;
}
