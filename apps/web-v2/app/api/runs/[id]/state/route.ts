import type { NextRequest } from 'next/server';

import { runStateLastModified, serializeRunState } from '@/lib/queries/run-state';
import { getRun } from '@/lib/queries/runs';

/**
 * `GET /api/runs/[id]/state` — JSON snapshot of a run for the live
 * tail page. Supports `If-Modified-Since` for cheap tick-and-no-change
 * responses.
 *
 * Response shape — see `SerializedRunState` in lib/queries/run-state.ts.
 *
 * Caching headers:
 *   - `Last-Modified` set from the run's high-water-mark across runs +
 *     events + decisions + policy_decisions + context_packs.
 *   - `Cache-Control: private, no-cache` so browsers must re-validate.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id: rawId } = await ctx.params;
  const id = decodeURIComponent(rawId);

  const snapshot = await getRun(id);
  if (snapshot === null) {
    return new Response(JSON.stringify({ error: 'not_found', id }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const lastModified = runStateLastModified(snapshot);
  const ifModifiedSince = req.headers.get('if-modified-since');
  if (ifModifiedSince !== null) {
    const since = new Date(ifModifiedSince);
    if (!Number.isNaN(since.getTime()) && lastModified.getTime() <= since.getTime()) {
      return new Response(null, {
        status: 304,
        headers: {
          'Last-Modified': lastModified.toUTCString(),
          'Cache-Control': 'private, no-cache',
        },
      });
    }
  }

  const body = JSON.stringify(serializeRunState(snapshot));
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Last-Modified': lastModified.toUTCString(),
      'Cache-Control': 'private, no-cache',
    },
  });
}
