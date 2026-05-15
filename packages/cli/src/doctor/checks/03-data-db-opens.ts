import { access } from 'node:fs/promises';
import { openLocalDb } from '../../lib/open-local-db.js';
import type { Check } from '../types.js';

export const dataDbOpensCheck: Check = {
  id: 3,
  name: 'data.db opens via @coodra/db::createDb',
  severity: 'red',
  async run(ctx) {
    try {
      await access(ctx.dataDb);
    } catch {
      return {
        status: 'red',
        detail: `${ctx.dataDb} does not exist`,
        remediation: 'Run `coodra init` to create the local SQLite primary store.',
      };
    }

    let handle: Awaited<ReturnType<typeof openLocalDb>>;
    try {
      handle = await openLocalDb(ctx.dataDb);
    } catch (err) {
      return {
        status: 'red',
        detail: `createDb failed: ${(err as Error).message}`,
        remediation: 'data.db is corrupt or unreadable; back it up and re-run `coodra init`.',
      };
    }
    try {
      // A successful open is the contract; we close immediately to free the file lock.
      handle.close();
    } catch {
      // ignore close errors — the open was the meaningful signal.
    }
    return { status: 'green', detail: `${ctx.dataDb} opens cleanly` };
  },
};
