import { createLogger } from '@coodra/shared';

import type { DbHandle } from './client.js';
import {
  type ScheduleDurableWriteArgs,
  type ScheduleDurableWriteResult,
  scheduleDurableWrite,
} from './schedule-durable-write.js';

/**
 * `packages/db/src/schedule-audit-write-with-sync` — Module 04a S2.
 *
 * Pairs every audit-write enqueue (M03.1's `scheduleDurableWrite`) with
 * a `sync_to_cloud` enqueue when the process is in team mode. The
 * sync-daemon (M04a S3) drains the `sync_to_cloud` queue and pushes
 * each row to cloud Postgres.
 *
 * Why pair at the enqueue site (vs at dispatch). Both paths land
 * durably in `pending_jobs` BEFORE the caller's HTTP response returns.
 * Coupling them here means a single SIGTERM mid-handler still produces
 * BOTH durable rows: the audit will land locally on next bridge boot,
 * and the sync will land in cloud on next sync-daemon boot. Pairing at
 * dispatch (i.e. enqueue sync after audit dispatch succeeds) would
 * lose the sync if the bridge OutboxWorker dies mid-dispatch with the
 * audit dispatched but the sync not yet enqueued.
 *
 * Why solo mode skips the sync enqueue. There is no cloud Postgres in
 * solo mode; an accumulating `sync_to_cloud` backlog with no consumer
 * is wasted disk. The mode check is applied per call so a single test
 * harness that flips mode per scenario behaves correctly.
 *
 * The sync payload only carries the lookup key (table + natural id);
 * the daemon SELECTs the canonical row from local SQLite at dispatch
 * time and pushes that to cloud. This keeps payload size small and
 * sidesteps any race between enqueue and dispatch (audit rows are
 * append-only, so the SELECT always returns the same content).
 */

export type SyncTableName =
  // M04 Phase 4 / Phase G+H verification: projects must sync too so
  // that runs/decisions/etc can satisfy their FK to projects(id) on
  // the cloud side. ensureProjectFromCwd enqueues this whenever it
  // creates a new local row in team mode.
  | 'projects'
  | 'runs'
  | 'run_events'
  | 'policy_decisions'
  | 'decisions'
  | 'context_packs'
  // M04 S8a (extends M04a OQ-1): kill_switches sync. Bidirectional —
  // pause/resume on developer A pushes to cloud; sync-daemon's poller
  // on developer B pulls cloud → local. The push side reuses this
  // paired-enqueue pattern; the pull side is a separate poller in
  // apps/sync-daemon/src/lib/kill-switch-puller.ts.
  | 'kill_switches'
  // Module 10 (Deep Wiki, 2026-06-06): wikis + wiki_pages sync so a wiki
  // authored on the admin's machine renders cross-machine. Mutable tables
  // (re-plan replaces the structure; authoring flips a page) — pushed by
  // id with ON CONFLICT DO UPDATE; pulled by the team-rows-puller.
  | 'wikis'
  | 'wiki_pages';

export type SyncLookup =
  | { readonly kind: 'id'; readonly value: string }
  | { readonly kind: 'idempotency_key'; readonly value: string }
  | { readonly kind: 'project_session'; readonly projectId: string; readonly sessionId: string };

export interface SyncSpec {
  readonly table: SyncTableName;
  readonly lookup: SyncLookup;
}

export interface ScheduleAuditWriteWithSyncArgs {
  /** The audit-destination job (run_event, policy_decision, etc.). */
  readonly audit: ScheduleDurableWriteArgs;
  /**
   * The paired sync-to-cloud lookup. When `undefined`, no sync job is
   * enqueued (used by callsites where syncing is meaningless, e.g.
   * test harnesses).
   */
  readonly sync?: SyncSpec;
  /**
   * Override `process.env.COODRA_MODE` for this call. Tests pass
   * `'solo'` or `'team'` directly; production reads from env.
   */
  readonly mode?: 'solo' | 'team';
}

export interface ScheduleAuditWriteWithSyncResult {
  readonly audit: ScheduleDurableWriteResult;
  /** Present when a sync job was enqueued (team mode + `sync` provided). */
  readonly sync?: ScheduleDurableWriteResult;
}

const log = createLogger('db.schedule-audit-write-with-sync');

function effectiveMode(override: 'solo' | 'team' | undefined): 'solo' | 'team' {
  if (override !== undefined) return override;
  const envMode = process.env.COODRA_MODE;
  if (envMode === 'team') return 'team';
  return 'solo';
}

export async function scheduleAuditWriteWithSync(
  db: DbHandle,
  args: ScheduleAuditWriteWithSyncArgs,
): Promise<ScheduleAuditWriteWithSyncResult> {
  const auditResult = await scheduleDurableWrite(db, args.audit);

  const mode = effectiveMode(args.mode);
  if (mode !== 'team' || args.sync === undefined) {
    return { audit: auditResult };
  }

  const syncPayload = {
    v: 1 as const,
    table: args.sync.table,
    lookup: args.sync.lookup,
  };
  const syncResult = await scheduleDurableWrite(db, {
    queue: 'sync_to_cloud',
    payload: syncPayload,
  });

  log.debug(
    {
      event: 'audit_with_sync_paired',
      auditQueue: args.audit.queue,
      auditId: auditResult.id,
      syncId: syncResult.id,
      table: args.sync.table,
      lookupKind: args.sync.lookup.kind,
    },
    'audit + sync_to_cloud jobs enqueued as pair',
  );

  return { audit: auditResult, sync: syncResult };
}
