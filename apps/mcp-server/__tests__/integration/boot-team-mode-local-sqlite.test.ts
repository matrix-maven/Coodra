import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Verification finding §8.3 (closed in Module 03 S4).
 *
 * Module 02 introduced `COODRA_DB_OVERRIDE_MODE` as a stop-gap so a
 * dev could exercise the team-mode auth chain locally with a SQLite
 * store. Module 03 S4 made the override unnecessary by refactoring
 * `createDb` to take a `kind: 'local' | 'cloud'` discriminator —
 * `mode` is now an auth-strategy hint that does NOT change DB routing.
 *
 * This test boots the binary with `COODRA_MODE=team` (no override
 * env var, none exists anymore) and asserts the server starts on
 * SQLite — proves the new createDb default routing matches the
 * architecture's "local services always write to local SQLite" rule
 * (§1) instead of the previous team→Postgres misrouting.
 */

const ROOT = resolve(__dirname, '..', '..', '..', '..');
const SERVER_BIN = resolve(ROOT, 'apps/mcp-server/dist/index.js');

interface Harness {
  readonly client: Client;
  readonly dataDir: string;
}

let h: Harness;

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'team-sqlite-'));
  const sqlitePath = join(dataDir, 'fresh-data.db');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_BIN, '--transport', 'stdio'],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      COODRA_MODE: 'team',
      // No COODRA_DB_OVERRIDE_MODE — that knob was removed in S4.
      // The new createDb({ kind: 'local' }) defaulting in
      // apps/mcp-server/src/lib/db.ts is what makes this work.
      CLERK_SECRET_KEY: 'sk_test_replace_me',
      CLERK_PUBLISHABLE_KEY: 'pk_test_xxx',
      COODRA_LOG_DESTINATION: 'stderr',
      COODRA_SQLITE_PATH: sqlitePath,
    } as Record<string, string>,
    stderr: 'pipe',
  });

  const client = new Client({ name: 'team-sqlite-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);

  h = { client, dataDir };
}, 60_000);

afterAll(async () => {
  if (h?.client) {
    await h.client.close().catch(() => {});
  }
  if (h?.dataDir) {
    rmSync(h.dataDir, { recursive: true, force: true });
  }
}, 30_000);

describe('boot — COODRA_MODE=team with no override knob (finding §8.3 closed)', () => {
  it('binary boots with team-mode auth + sqlite store; tools/list returns the full inventory', async () => {
    const { tools } = await h.client.listTools();
    // See `boot.test.ts` for the tool count drift log. 16 = post-M06
    // inventory (2026-05-09).
    expect(tools.length).toBe(16);
  });

  it('tool runs end-to-end against sqlite — DB read path executed (proves no Postgres connection attempted)', async () => {
    // Under COODRA_MODE=team with the solo-bypass sentinel, get_run_id
    // routes through the team-mode auth path but the project must still
    // be registered explicitly — unknown slug → soft-failure
    // project_not_found. The exact contract is:
    //   (a) the binary booted (didn't fail at createDb opening Postgres).
    //   (b) the tool ran end-to-end against sqlite (transport ok:true).
    //   (c) the soft-failure envelope shape is canonical, proving the
    //       DB read path actually executed against a real sqlite handle.
    const result = await h.client.callTool({ name: 'get_run_id', arguments: { projectSlug: 'team-mode-test' } });
    const text = (result.content as ReadonlyArray<{ text: string }>)[0]?.text ?? '{}';
    const parsed = JSON.parse(text) as { ok: boolean; data?: { ok: boolean; error?: string; howToFix?: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.ok).toBe(false);
    expect(parsed.data?.error).toBe('project_not_found');
    expect(parsed.data?.howToFix).toBeTruthy();
  });
});
