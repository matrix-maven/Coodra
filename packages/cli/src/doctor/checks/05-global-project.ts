import { access } from 'node:fs/promises';
import { GLOBAL_PROJECT_ID } from '@coodra/db';
import { openLocalDb } from '../../lib/open-local-db.js';
import type { Check } from '../types.js';

export const globalProjectCheck: Check = {
  id: 5,
  name: '`__global__` sentinel project exists (F7 invariant)',
  severity: 'red',
  async run(ctx) {
    try {
      await access(ctx.dataDb);
    } catch {
      return { status: 'skipped', detail: 'data.db missing — check 3 covers this' };
    }
    let handle: Awaited<ReturnType<typeof openLocalDb>>;
    try {
      handle = await openLocalDb(ctx.dataDb);
    } catch (err) {
      return { status: 'skipped', detail: `cannot open ${ctx.dataDb}: ${(err as Error).message}` };
    }
    try {
      const row = handle.raw.prepare(`SELECT id FROM projects WHERE id = ?`).get(GLOBAL_PROJECT_ID) as
        | { id: string }
        | undefined;
      if (row?.id === GLOBAL_PROJECT_ID) {
        return { status: 'green', detail: `${GLOBAL_PROJECT_ID} present` };
      }
      return {
        status: 'red',
        detail: `${GLOBAL_PROJECT_ID} sentinel project missing — F7 audit-on-unresolved path is broken`,
        remediation: 'Run `coodra init` to seed the sentinel project.',
      };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('no such table')) {
        return {
          status: 'red',
          detail: '`projects` table is missing — migrations not applied',
          remediation: 'Run `coodra init`.',
        };
      }
      return { status: 'red', detail: msg, remediation: 'Inspect data.db schema.' };
    } finally {
      try {
        handle.close();
      } catch {
        // ignore
      }
    }
  },
};
