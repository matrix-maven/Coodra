import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { openLocalDb } from '../../lib/open-local-db.js';
import type { Check } from '../types.js';

const projectConfigSchema = z
  .object({
    projectSlug: z.string().min(1).max(128),
  })
  .strict();

export const projectRegisteredCheck: Check = {
  id: 12,
  name: 'Project registered for cwd (.coodra.json resolves to a projects row)',
  severity: 'yellow',
  async run(ctx) {
    const configPath = join(ctx.cwd, '.coodra.json');
    let parsed: z.infer<typeof projectConfigSchema>;
    try {
      const raw = readFileSync(configPath, 'utf8');
      parsed = projectConfigSchema.parse(JSON.parse(raw));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          status: 'yellow',
          detail: `${configPath} not found — bridge will fall back to __global__ for this cwd`,
          remediation: 'Run `coodra init` from this directory to register the project.',
        };
      }
      return {
        status: 'yellow',
        detail: `cannot read ${configPath}: ${(err as Error).message}`,
        remediation: 'Re-run `coodra init` to rewrite a valid .coodra.json.',
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
        detail: `.coodra.json says slug='${parsed.projectSlug}' but no projects row matches`,
        remediation: 'Run `coodra init` to register the project, or update .coodra.json to a known slug.',
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
