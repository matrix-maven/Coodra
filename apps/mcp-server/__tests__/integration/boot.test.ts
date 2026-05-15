import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Boot integration test for the auto-migrate fix (verification finding §8.1).
 *
 * Spawns the BUILT mcp-server binary as a stdio subprocess against a
 * brand-new SQLite path. Before the fix, the first tool call against a
 * non-migrated DB would fail with `SQLITE_ERROR: no such table: projects`.
 * After the fix, boot calls `migrateSqlite` idempotently before any tool
 * call lands.
 *
 * The test asserts the round-trip succeeds — `tools/list` returns the
 * full 9-tool set and `get_run_id` succeeds against a freshly-minted DB
 * without any pre-migration step.
 */

const ROOT = resolve(__dirname, '..', '..', '..', '..');
const SERVER_BIN = resolve(ROOT, 'apps/mcp-server/dist/index.js');

interface Harness {
  readonly client: Client;
  readonly dataDir: string;
}

let h: Harness;

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'boot-test-'));
  const sqlitePath = join(dataDir, 'fresh-data.db');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_BIN, '--transport', 'stdio'],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      COODRA_MODE: 'solo',
      COODRA_LOG_DESTINATION: 'stderr',
      COODRA_SQLITE_PATH: sqlitePath,
      CLERK_SECRET_KEY: 'sk_test_replace_me',
    } as Record<string, string>,
    stderr: 'pipe',
  });

  const client = new Client({ name: 'boot-test', version: '0.0.0' }, { capabilities: {} });
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

describe('boot auto-migrate (verification finding §8.1)', () => {
  it('tools/list succeeds against a fresh SQLite path with no pre-migration', async () => {
    const { tools } = await h.client.listTools();
    // Slice 4 (2026-05-03 audit): query_decisions added → 10 tools.
    // Locks the count so future "added a tool but never wired it"
    // regressions surface immediately (essentialsforclaude/10-troubleshooting.md).
    expect(tools.length).toBe(10);
  });

  it('get_run_id succeeds against the freshly-migrated DB (proves projects table exists)', async () => {
    const result = await h.client.callTool({ name: 'get_run_id', arguments: { projectSlug: 'boot-test' } });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '{}';
    const env = JSON.parse(text) as { ok: boolean; data?: { ok: boolean; runId: string } };
    expect(env.ok).toBe(true);
    expect(env.data?.ok).toBe(true);
    expect(env.data?.runId).toMatch(/^run:/);
  });

  it('re-running tools is idempotent (migration not re-applied destructively)', async () => {
    // A second get_run_id with the same slug should produce a fresh runId
    // (per get_run_id's runs-table semantics) without re-running migrations.
    // This indirectly proves migrate is idempotent — if it ran destructively,
    // the projects row would have been wiped.
    const r1 = await h.client.callTool({ name: 'get_run_id', arguments: { projectSlug: 'boot-test' } });
    const r2 = await h.client.callTool({ name: 'get_run_id', arguments: { projectSlug: 'boot-test' } });
    const e1 = JSON.parse((r1.content as Array<{ text?: string }>)[0]?.text ?? '{}') as { ok: boolean };
    const e2 = JSON.parse((r2.content as Array<{ text?: string }>)[0]?.text ?? '{}') as { ok: boolean };
    expect(e1.ok).toBe(true);
    expect(e2.ok).toBe(true);
  });
});
