import {
  type InsertKillSwitchInput,
  insertKillSwitch as insertKillSwitchDb,
  KILL_SWITCH_MODES,
  KILL_SWITCH_SCOPES,
  type KillSwitchRecord,
  type KillSwitchScope,
  listAllActiveKillSwitches as listAllActiveKillSwitchesDb,
  scheduleDurableWrite,
  softResumeKillSwitch as softResumeKillSwitchDb,
} from '@coodra/contextos-db';

import { createWebDb } from '@/lib/db';

/**
 * `apps/web/lib/queries/kill-switches.ts` — server-only wrappers around
 * the kill-switch helpers from M08b S1 + S3 + S8a.
 *
 * In team mode, every web write also enqueues a `sync_to_cloud` row so
 * the sync-daemon on every developer's machine pulls the new state.
 * Solo mode skips the enqueue (no cloud to sync to). The mode check
 * happens here so server actions can stay terse.
 */

export const SCOPES = KILL_SWITCH_SCOPES;
export const MODES = KILL_SWITCH_MODES;
export type Scope = KillSwitchScope;

function isTeamMode(): boolean {
  return process.env.CONTEXTOS_MODE === 'team';
}

export async function listActive(): Promise<KillSwitchRecord[]> {
  const handle = createWebDb();
  return listAllActiveKillSwitchesDb(handle);
}

export async function insertKillSwitchWithSync(input: InsertKillSwitchInput): Promise<KillSwitchRecord> {
  const handle = createWebDb();
  const inserted = await insertKillSwitchDb(handle, input);
  if (isTeamMode()) {
    await scheduleDurableWrite(handle, {
      queue: 'sync_to_cloud',
      payload: {
        v: 1 as const,
        table: 'kill_switches' as const,
        lookup: { kind: 'id' as const, value: inserted.id },
      },
    });
  }
  return inserted;
}

export async function softResumeWithSync(args: {
  id: string;
  resumedBySessionId?: string | null;
}): Promise<KillSwitchRecord | null> {
  const handle = createWebDb();
  const row = await softResumeKillSwitchDb(handle, args);
  if (row !== null && isTeamMode()) {
    await scheduleDurableWrite(handle, {
      queue: 'sync_to_cloud',
      payload: {
        v: 1 as const,
        table: 'kill_switches' as const,
        lookup: { kind: 'id' as const, value: row.id },
      },
    });
  }
  return row;
}

export interface ScopeMatch {
  readonly scope: Scope;
  readonly target: string | null;
}

export function findDuplicateActive(
  active: ReadonlyArray<KillSwitchRecord>,
  candidate: ScopeMatch,
): KillSwitchRecord | null {
  const match = active.find(
    (s) =>
      s.scope === candidate.scope && (candidate.target === null ? s.target === null : s.target === candidate.target),
  );
  return match ?? null;
}
