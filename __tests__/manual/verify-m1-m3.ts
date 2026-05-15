/**
 * Manual end-to-end verification harness for Modules 01 + 02 + 03.
 *
 * NOT a test file — not picked up by vitest. Runnable as:
 *   pnpm exec tsx __tests__/manual/verify-m1-m3.ts
 *
 * Spawns the built mcp-server as a stdio subprocess against a fresh
 * sqlite path, connects via the MCP SDK Client, and walks every tool
 * with non-trivial inputs. Records every response on stdout as JSON
 * Lines so the verification report can quote them verbatim.
 *
 * Read-only: writes only to /tmp/coodra-verify-m1-m3/. No source
 * edits, no commits.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..', '..');
const SERVER_BIN = resolve(ROOT, 'apps/mcp-server/dist/index.js');

interface ToolResult {
  readonly content: ReadonlyArray<{ readonly text?: string }>;
}

function unwrap(r: ToolResult): Record<string, unknown> {
  return JSON.parse(r.content[0]?.text ?? '{}') as Record<string, unknown>;
}

function emit(label: string, payload: unknown): void {
  process.stdout.write(`${JSON.stringify({ label, payload })}\n`);
}

async function main(): Promise<void> {
  const verifyRoot = '/tmp/coodra-verify-m1-m3';
  rmSync(verifyRoot, { recursive: true, force: true });
  mkdirSync(verifyRoot, { recursive: true });

  const sqlitePath = `${verifyRoot}/data.db`;
  const contextPacksRoot = `${verifyRoot}/context-packs`;
  const graphifyRoot = `${verifyRoot}/graphify`;
  mkdirSync(contextPacksRoot, { recursive: true });
  mkdirSync(graphifyRoot, { recursive: true });

  emit('boot', { sqlitePath, contextPacksRoot, graphifyRoot, serverBin: SERVER_BIN });

  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_BIN, '--transport', 'stdio'],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'production',
      COODRA_SQLITE_PATH: sqlitePath,
      COODRA_CONTEXT_PACKS_ROOT: contextPacksRoot,
      COODRA_GRAPHIFY_ROOT: graphifyRoot,
      COODRA_LOG_DESTINATION: 'stderr',
      COODRA_MODE: 'solo',
      CLERK_SECRET_KEY: 'sk_test_replace_me',
      CLERK_PUBLISHABLE_KEY: 'pk_test_replace_me',
    },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'verify-m1-m3', version: '0.0.0' });
  await client.connect(transport);
  emit('connected', { transport: 'stdio' });

  // --- 2.3: tools/list ---
  const list = await client.listTools();
  const toolNames = list.tools.map((t) => t.name).sort();
  emit('tools/list', {
    count: list.tools.length,
    names: toolNames,
    descriptionLengths: Object.fromEntries(list.tools.map((t) => [t.name, t.description?.length ?? 0])),
  });

  // --- 2.4 walk every tool ---

  // ping — sessionId + idempotencyKey shape
  const ping = await client.callTool({ name: 'ping', arguments: { echo: 'verify-m1-m3' } });
  const pingData = unwrap(ping as ToolResult);
  emit('ping', pingData);

  // get_run_id — mints run, auto-creates project
  const projectSlug = 'verify-m1-m3-walkthrough';
  const runIdResp = await client.callTool({ name: 'get_run_id', arguments: { projectSlug } });
  const runIdUnwrapped = unwrap(runIdResp as ToolResult);
  emit('get_run_id', runIdUnwrapped);
  const innerData = (runIdUnwrapped as { data?: { runId?: string } }).data;
  const runId = innerData?.runId;
  if (!runId) throw new Error(`expected runId, got ${JSON.stringify(runIdUnwrapped)}`);

  // get_feature_pack — verify an unknown slug returns soft-failure
  const fpUnknown = await client.callTool({
    name: 'get_feature_pack',
    arguments: { projectSlug: 'does-not-exist' },
  });
  emit('get_feature_pack(unknown)', unwrap(fpUnknown as ToolResult));

  // record_decision × 2 + 1 retry
  const dec1 = await client.callTool({
    name: 'record_decision',
    arguments: {
      runId,
      description: 'verify-m1-m3 decision A — choose verify path',
      rationale: 'Phase 2 walks every tool with non-trivial input',
      alternatives: ['skip phase 2', 'walk only first 3 tools'],
    },
  });
  emit('record_decision(A)', unwrap(dec1 as ToolResult));

  const dec2 = await client.callTool({
    name: 'record_decision',
    arguments: {
      runId,
      description: 'verify-m1-m3 decision B — record_decision idempotency proof',
      rationale: 'second distinct decision',
      alternatives: ['none'],
    },
  });
  emit('record_decision(B)', unwrap(dec2 as ToolResult));

  const dec1Retry = await client.callTool({
    name: 'record_decision',
    arguments: {
      runId,
      description: 'verify-m1-m3 decision A — choose verify path',
      rationale: 'Phase 2 walks every tool with non-trivial input',
      alternatives: ['skip phase 2', 'walk only first 3 tools'],
    },
  });
  emit('record_decision(A-retry)', unwrap(dec1Retry as ToolResult));

  // check_policy — synthetic Write toolName
  const pingSessionId = (pingData as { data?: { sessionId?: string } }).data?.sessionId;
  if (!pingSessionId) throw new Error('expected sessionId from ping.data');
  const policy = await client.callTool({
    name: 'check_policy',
    arguments: {
      projectSlug,
      sessionId: pingSessionId,
      agentType: 'claude_code',
      eventType: 'PreToolUse',
      toolName: 'Write',
      toolInput: { file_path: '/tmp/synthetic/file.ts', content: 'noop' },
    },
  });
  emit('check_policy(Write)', unwrap(policy as ToolResult));

  // check_policy invalid_input — confirm Zod-layer rejection of bad input
  const policyBad = await client.callTool({
    name: 'check_policy',
    arguments: {
      projectSlug,
      sessionId: 'has:colon',
      agentType: 'claude_code',
      eventType: 'PreToolUse',
      toolName: 'Write',
      toolInput: {},
    },
  });
  emit('check_policy(invalid sessionId)', unwrap(policyBad as ToolResult));

  // query_codebase_graph — should return codebase_graph_not_indexed soft-failure
  const graph = await client.callTool({
    name: 'query_codebase_graph',
    arguments: { projectSlug, query: 'symbol Foo' },
  });
  emit('query_codebase_graph', unwrap(graph as ToolResult));

  // save_context_pack — DB row + FS file
  const pack = await client.callTool({
    name: 'save_context_pack',
    arguments: {
      runId,
      title: 'verify-m1-m3 context pack',
      content: '# Verify M1-M3\n\nThis pack was saved by the verification harness.\n',
    },
  });
  emit('save_context_pack', unwrap(pack as ToolResult));

  // query_run_history — should include this run
  const hist = await client.callTool({
    name: 'query_run_history',
    arguments: { projectSlug, limit: 5 },
  });
  emit('query_run_history', unwrap(hist as ToolResult));

  // search_packs_nl — LIKE fallback (no embedding)
  const search = await client.callTool({
    name: 'search_packs_nl',
    arguments: { projectSlug, query: 'verify' },
  });
  emit('search_packs_nl', unwrap(search as ToolResult));

  emit('done', { ok: true });
  await client.close();
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
