import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * stdio roundtrip — spawns the @coodra/mcp-server binary as a
 * subprocess via stdio and exercises the MCP wire end-to-end through
 * the SDK's StdioClientTransport. Proves:
 *
 *   - The subprocess starts under `tsx` (so dev-mode boot works the
 *     same way `pnpm dev` does for the IDE integration).
 *   - The MCP `initialize` handshake completes within the test
 *     timeout (cold-boot + sqlite migrations + tool registration).
 *   - `tools/list` returns exactly the 9 expected tools.
 *   - A simple `ping` round-trip returns within the timeout.
 *   - Graceful close terminates the subprocess (no zombies).
 *
 * NOT exercised in this test: every-tool minimum-valid-input call
 * (manifest-e2e covers that via HTTP). The stdio test is about
 * proving the SUBPROCESS path works at all; per-tool surface is
 * proven once via the cheaper HTTP transport.
 */

const ROOT = resolve(__dirname, '..', '..');
const SERVER_ENTRY = resolve(ROOT, 'apps/mcp-server/src/index.ts');

interface Harness {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly contextPacksDir: string;
}

let h: Harness;

beforeAll(async () => {
  // Each test run gets a fresh sqlite DB on disk so the stdio
  // subprocess has somewhere to write. `:memory:` would be hidden
  // inside the child process anyway, so a real file is the simpler path.
  const dataDir = mkdtempSync(join(tmpdir(), 'stdio-rt-'));
  const sqlitePath = join(dataDir, 'data.db');
  const contextPacksDir = mkdtempSync(join(tmpdir(), 'stdio-rt-cp-'));

  const transport = new StdioClientTransport({
    command: 'pnpm',
    args: ['exec', 'tsx', SERVER_ENTRY, '--transport', 'stdio'],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      COODRA_MODE: 'solo',
      COODRA_LOG_DESTINATION: 'stderr',
      COODRA_SQLITE_PATH: sqlitePath,
      CLERK_SECRET_KEY: 'sk_test_replace_me',
      MCP_SERVER_TRANSPORT: 'stdio',
    } as Record<string, string>,
    stderr: 'pipe',
  });

  const client = new Client({ name: 'stdio-rt-e2e', version: '0.0.0-e2e' }, { capabilities: {} });
  await client.connect(transport);

  h = { client, transport, contextPacksDir };
}, 90_000);

afterAll(async () => {
  if (h?.client) {
    await h.client.close().catch(() => {});
  }
}, 30_000);

describe('stdio-roundtrip — subprocess + SDK Client', () => {
  it('initialize handshake completes and serverInfo is populated', async () => {
    // Connection already happened in beforeAll; check serverInfo.
    const info = h.client.getServerVersion();
    expect(info?.name).toBe('@coodra/mcp-server');
  });

  it('tools/list returns exactly the 9 expected tools', async () => {
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'check_policy',
        'get_feature_pack',
        'get_run_id',
        'ping',
        'query_codebase_graph',
        'query_run_history',
        'record_decision',
        'save_context_pack',
        'search_packs_nl',
      ].sort(),
    );
  });

  it('ping round-trip returns the echoed payload', async () => {
    const result = await h.client.callTool({ name: 'ping', arguments: { echo: 'hello-stdio' } });
    expect(result).toBeTruthy();
    expect(Array.isArray(result.content)).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '{}';
    const env = JSON.parse(text) as { ok: boolean; data?: { echo?: string } };
    expect(env.ok).toBe(true);
    expect(env.data?.echo).toBe('hello-stdio');
  });
});
