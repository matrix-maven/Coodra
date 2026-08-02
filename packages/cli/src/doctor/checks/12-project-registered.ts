import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { openLocalDb } from '../../lib/open-local-db.js';
import { projectConfigPath, readProjectConfig } from '../../lib/project-store/index.js';
import type { Check } from '../types.js';

export const projectRegisteredCheck: Check = {
  id: 12,
  name: 'Project registered for cwd (.coodra/config.json resolves to a projects row)',
  severity: 'yellow',
  async run(ctx) {
    const configPath = projectConfigPath(ctx.cwd);
    const parsed = await readProjectConfig(ctx.cwd);
    if (parsed === null) {
      const userHome = resolve(ctx.env.HOME || ctx.env.USERPROFILE || homedir());
      const cwd = resolve(ctx.cwd);
      return {
        status: 'yellow',
        detail: `${configPath} missing or invalid — bridge will fall back to __global__ for this cwd`,
        remediation:
          cwd === userHome
            ? 'Open a project directory, then run `coodra init` to register that project.'
            : 'Run `coodra init` from this directory to register the project.',
      };
    }
    try {
      await access(ctx.dataDb);
    } catch {
      return { status: 'skipped', detail: 'data.db missing — check 3 covers this' };
    }
    let handle: Awaited<ReturnType<typeof openLocalDb>>;
    try {
      handle = await openLocalDb(ctx.dataDb);
    } catch {
      return { status: 'skipped', detail: 'cannot open data.db' };
    }
    try {
      const row = handle.raw.prepare(`SELECT id FROM projects WHERE slug = ?`).get(parsed.projectSlug) as
        | { id: string }
        | undefined;
      if (row?.id !== undefined) {
        return { status: 'green', detail: `slug '${parsed.projectSlug}' resolves to ${row.id}` };
      }
      return {
        status: 'yellow',
        detail: `.coodra/config.json says slug='${parsed.projectSlug}' but no projects row matches`,
        remediation: 'Run `coodra init` to register the project, or update .coodra/config.json to a known slug.',
      };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('no such table')) {
        return { status: 'skipped', detail: 'projects table missing — migrations not applied' };
      }
      return { status: 'yellow', detail: msg };
    } finally {
      try {
        handle.close();
      } catch {
        // ignore
      }
    }
  },
};
