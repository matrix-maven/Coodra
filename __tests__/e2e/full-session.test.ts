import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { sqliteSchema } from '@coodra/db';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type BootHandle, bootForE2E, buildE2eEnv, openSqliteHandle } from './_helpers/boot.js';

/**
 * Full session simulation (S17, scenario 5).
 *
 * Walks an entire Coodra workflow through one MCP Client session:
 *   1. `get_run_id` → mints a run + auto-creates the projects row in
 *      solo mode.
 *   2. `record_decision` × 2 → two distinct rows in `decisions`.
 *   3. `save_context_pack` → inserts into `context_packs` AND writes
 *      the pack markdown file to disk; flips the run's status to
 *      `completed`.
 *   4. `query_run_history` → returns the run with the pack title
 *      LEFT-JOINed, status='completed', and an end-time set.
 *
 * Every read is verified against the real DB tables — proving the
 * cross-tool data plane works end-to-end. The FS materialisation is
 * verified by checking the file exists.
 */

interface Harness {
  readonly boot: BootHandle;
  readonly closeDb: () => Promise<void>;
  readonly client: Client;
}

let h: Harness;

beforeAll(async () => {
  const { handle, close: closeDb } = openSqliteHandle();
  const env = buildE2eEnv({ COODRA_MODE: 'solo', CLERK_SECRET_KEY: 'sk_test_replace_me' });
  const boot = await bootForE2E({ db: handle, env, withHttp: true });
  if (!boot.http) throw new Error('expected http transport');

  const transport = new StreamableHTTPClientTransport(new URL(`${boot.http.url}/mcp`));
  const client = new Client({ name: 'full-session-e2e', version: '0.0.0-e2e' }, { capabilities: {} });
  await client.connect(transport);

  h = { boot, closeDb, client };
}, 60_000);

afterAll(async () => {
  await h.client.close().catch(() => {});
  await h.boot.close();
  await h.closeDb();
}, 30_000);

function unwrapData<T>(result: { content: Array<{ text?: string }> }): T {
  const text = result.content[0]?.text ?? '{}';
  const env = JSON.parse(text) as { ok?: boolean; data?: unknown };
  if (!env.ok) throw new Error(`tool envelope ok:false — ${text}`);
  return env.data as T;
}

function findPackFile(root: string): string | null {
  try {
    const files = readdirSync(root);
    const md = files.find((f) => f.endsWith('.md'));
    return md ? join(root, md) : null;
  } catch {
    return null;
  }
}

describe('full-session — get_run_id → record_decision×2 → save_context_pack → query_run_history', () => {
  it('walks the data plane end-to-end and the DB + FS reflect every write', async () => {
    const projectSlug = 'fullsession-project';

    // 1. get_run_id
    const runResult = await h.client.callTool({
      name: 'get_run_id',
      arguments: { projectSlug },
    });
    const run = unwrapData<{ ok: boolean; runId: string; startedAt: string }>(
      runResult as { content: Array<{ text?: string }> },
    );
    expect(run.ok).toBe(true);
    expect(run.runId).toMatch(/^run:/);
    const runId = run.runId;

    // 2. record_decision × 2
    const dec1 = await h.client.callTool({
      name: 'record_decision',
      arguments: { runId, description: 'pick cockatiel for retries', rationale: 'typed breakers + jitter' },
    });
    const dec2 = await h.client.callTool({
      name: 'record_decision',
      arguments: {
        runId,
        description: 'use pgvector HNSW on context_packs',
        rationale: 'cosine recall is the use case',
      },
    });
    const dec1Data = unwrapData<{ ok: boolean; decisionId: string; created: boolean }>(
      dec1 as { content: Array<{ text?: string }> },
    );
    const dec2Data = unwrapData<{ ok: boolean; decisionId: string; created: boolean }>(
      dec2 as { content: Array<{ text?: string }> },
    );
    expect(dec1Data.ok).toBe(true);
    expect(dec2Data.ok).toBe(true);
    expect(dec1Data.created).toBe(true);
    expect(dec2Data.created).toBe(true);
    expect(dec1Data.decisionId).not.toBe(dec2Data.decisionId);

    // 3. save_context_pack
    const pack = await h.client.callTool({
      name: 'save_context_pack',
      arguments: {
        runId,
        title: 'full-session smoke',
        content: '# full session\n\nworked end-to-end.',
      },
    });
    const packData = unwrapData<{ ok: boolean; contextPackId: string; savedAt: string }>(
      pack as { content: Array<{ text?: string }> },
    );
    expect(packData.ok).toBe(true);
    expect(packData.contextPackId).toMatch(/^cp_/);

    // 4. query_run_history
    const history = await h.client.callTool({
      name: 'query_run_history',
      arguments: { projectSlug },
    });
    const historyData = unwrapData<{
      ok: boolean;
      runs: Array<{ runId: string; status: string; title: string | null; endedAt: string | null }>;
    }>(history as { content: Array<{ text?: string }> });
    expect(historyData.ok).toBe(true);
    expect(historyData.runs).toHaveLength(1);
    const [entry] = historyData.runs;
    if (!entry) throw new Error('expected exactly one run');
    expect(entry.runId).toBe(runId);
    expect(entry.status).toBe('completed');
    expect(entry.title).toBe('full-session smoke');
    expect(entry.endedAt).not.toBeNull();
  });
});

describe('full-session — DB + FS state matches the wire responses', () => {
  it('decisions and context_packs and FS file all line up with the runId', async () => {
    const handle = h.boot.dbHandle;
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');

    const decisionRows = await handle.db.select().from(sqliteSchema.decisions);
    expect(decisionRows.length).toBeGreaterThanOrEqual(2);
    const descriptions = decisionRows.map((r) => r.description).sort();
    expect(descriptions).toContain('pick cockatiel for retries');
    expect(descriptions).toContain('use pgvector HNSW on context_packs');

    const packs = await handle.db.select().from(sqliteSchema.contextPacks);
    expect(packs).toHaveLength(1);
    const pack = packs[0];
    if (!pack) throw new Error('expected one context pack');
    expect(pack.title).toBe('full-session smoke');

    const fsFile = findPackFile(h.boot.contextPacksRoot);
    expect(fsFile).toBeTruthy();
    if (fsFile) expect(existsSync(fsFile)).toBe(true);

    const runs = await handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.id, pack.runId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('completed');
    expect(runs[0]?.endedAt).toBeTruthy();
  });
});
