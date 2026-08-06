import { type AuditEventWithProject, type DbHandle, type ListAuditEventsFilter, listAllAuditEvents } from '@coodra/db';

import { createWebDb } from '@/lib/db';

/**
 * `apps/web-v2/lib/queries/audit-events.ts` — workspace-level read
 * surface for the `audit_events` append-only ledger. The table has
 * existed since the hash-chained audit design landed but was never
 * wired into any web-v2 route (2026-08-06 finding) — this is that
 * wiring, mirroring `queries/decisions.ts`'s thin-wrapper shape.
 */

export async function listAuditEvents(
  filter: ListAuditEventsFilter & { db?: DbHandle } = {},
): Promise<AuditEventWithProject[]> {
  const handle = filter.db ?? createWebDb();
  return listAllAuditEvents(handle, filter);
}
