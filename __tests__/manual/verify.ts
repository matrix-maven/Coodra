/**
 * Manual end-to-end verification script for Modules 01 + 02.
 *
 * NOT a test file — not picked up by vitest. Runnable as:
 *   pnpm exec tsx __tests__/manual/verify.ts
 *
 * Spawns the built mcp-server as a stdio subprocess and walks a
 * realistic session through all 9 tools. Output is JSON Lines on
 * stdout for easy capture; errors go to stderr.
 *
 * Per the verification brief: not a code change, no commits, no
 * fixes. The script is the harness; the report at
 * `docs/verification/2026-04-25-module-01-02-verification.md`
 * captures findings.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

function unwrap(r: ToolResult): { ok: boolean; data?: unknown; error?: string; [k: string]: unknown } {
  return JSON.parse(r.content[0]?.text ?? '{}');
}

function emit(label: string, payload: unknown): void {
  process.stdout.write(`${JSON.stringify({ label, payload })}\n`);
}

async function main(): Promise<void> {
  // Use the externally-migrated DB at /tmp/coodra-verify/data.db
  // (the verify harness pre-migrates because the production
  // mcp-server does NOT auto-migrate at boot — see Surprises §1).
  // After Fix 1 (auto-migrate at boot), this can be a fresh path —
  // the binary will migrate on first call. Kept fixed for diagnosability.
  const sqlitePath = '/tmp/coodra-verify/data.db';
  // FINDING: lib/context-pack.ts defaults `contextPacksRoot` to
  // `process.cwd()/docs/context-packs` and lib/graphify.ts defaults
  // graphifyRoot to `~/.coodra/graphify`. Neither is env-driven.
  // For verification we use the production defaults — packs land in
  // the repo's `docs/context-packs/` (and we'll clean the new file
  // after) and graphify reads from `~/.coodra/graphify/coodra/`
  // which we seed temporarily.
  const cpRoot = resolve(ROOT, 'docs/context-packs');
  const gfxRoot = resolve(homedir(), '.coodra', 'graphify');
  const gfxSlug = join(gfxRoot, 'coodra');

  emit('paths', { sqlitePath, cpRoot, gfxRoot });

  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_BIN, '--transport', 'stdio'],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      LOG_LEVEL: 'error',
      COODRA_MODE: 'solo',
      COODRA_LOG_DESTINATION: 'stderr',
      COODRA_SQLITE_PATH: sqlitePath,
      CLERK_SECRET_KEY: 'sk_test_replace_me',
    } as Record<string, string>,
    stderr: 'inherit',
  });

  const client = new Client({ name: 'verify-script', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  emit('connected', { serverInfo: client.getServerVersion() });

  // 1. tools/list
  const listed = await client.listTools();
  emit('tools_list', { count: listed.tools.length, names: listed.tools.map((t) => t.name).sort() });

  // 2. get_run_id
  const runResp = await client.callTool({ name: 'get_run_id', arguments: { projectSlug: 'coodra' } });
  const runOut = unwrap(runResp as ToolResult) as { ok: boolean; data?: { runId: string; startedAt: string } };
  emit('get_run_id', runOut);
  const runId = runOut.data?.runId;
  if (!runId) throw new Error('get_run_id returned no runId');

  // 3. get_feature_pack
  const fpResp = await client.callTool({ name: 'get_feature_pack', arguments: { projectSlug: '02-mcp-server' } });
  const fpOut = unwrap(fpResp as ToolResult);
  emit('get_feature_pack', { ok: fpOut.ok, hasData: 'data' in fpOut, error: fpOut.error });

  // 4. record_decision × 3
  for (const dec of [
    {
      description: 'Use Hono for the HTTP transport routing layer',
      rationale: 'Hono handles /healthz cleanly; SDK Streamable HTTP handles /mcp directly',
    },
    {
      description: 'Lock turbo task env passthrough for CLERK_SECRET_KEY',
      rationale: 'CI integration job needs the sentinel to pass schema superRefine',
    },
    {
      description: 'Use testcontainers Postgres only for the idempotency e2e scenario',
      rationale: 'Sqlite serialises writes; cannot fake concurrent INSERT...ON CONFLICT race',
    },
  ]) {
    const r = await client.callTool({ name: 'record_decision', arguments: { runId, ...dec } });
    emit('record_decision', unwrap(r as ToolResult));
  }

  // 5. save_context_pack with realistic ~2KB markdown
  const packContent = `# Module 01 + 02 verification — saved via verify.ts

## What this run did
- Connected an SDK Client over stdio to the built mcp-server binary at
  apps/mcp-server/dist/index.js with COODRA_MODE=solo.
- Called every advertised tool against a non-trivial input shape and
  captured the response envelopes for the verification report.

## Decisions captured this run
1. Hono for HTTP routing — chosen over pure Hono because the MCP SDK
   Streamable HTTP transport writes directly to ServerResponse and
   conflicts with Hono's Response-return contract.
2. CLERK_SECRET_KEY sentinel in CI integration env — the schema's
   superRefine requires it under COODRA_MODE=team; sentinel is
   exempt and routes auth through the bypass path.
3. testcontainers Postgres only for idempotency e2e — sqlite cannot
   fake real concurrent INSERT...ON CONFLICT racing because writes
   serialise per file.

## Surface verified
- Manifest: 9 tools, exact set, all under 800-char descriptions.
- HTTP auth: solo-bypass / X-Local-Hook-Secret / Clerk Bearer.
- Soft-failures: project_not_found, run_not_found, codebase_graph_not_indexed.
- Side effects: DB rows, FS materialisation, audit-write drain.

This pack itself is the artifact proving save_context_pack writes.
`;

  const packResp = await client.callTool({
    name: 'save_context_pack',
    arguments: { runId, title: 'verify.ts smoke', content: packContent },
  });
  const packOut = unwrap(packResp as ToolResult);
  emit('save_context_pack', packOut);

  // 6. query_run_history
  const histResp = await client.callTool({ name: 'query_run_history', arguments: { projectSlug: 'coodra', limit: 5 } });
  emit('query_run_history', unwrap(histResp as ToolResult));

  // 7. search_packs_nl
  const searchResp = await client.callTool({
    name: 'search_packs_nl',
    arguments: { projectSlug: 'coodra', query: 'authentication' },
  });
  emit('search_packs_nl', unwrap(searchResp as ToolResult));

  // 8. check_policy — allow path (no rules seeded)
  const cpAllow = await client.callTool({
    name: 'check_policy',
    arguments: {
      projectSlug: 'coodra',
      sessionId: 'verify-session',
      agentType: 'claude_code',
      eventType: 'PreToolUse',
      toolName: 'Write',
      toolInput: { file_path: '/tmp/safe.ts' },
    },
  });
  emit('check_policy_allow', unwrap(cpAllow as ToolResult));

  // 9. query_codebase_graph — codebase_graph_not_indexed
  const graphMissing = await client.callTool({
    name: 'query_codebase_graph',
    arguments: { projectSlug: 'coodra', query: 'createDb' },
  });
  emit('query_codebase_graph_missing', unwrap(graphMissing as ToolResult));

  // 9b. seed a graph.json + retry
  // Track if we created the slug dir so cleanup only removes what we made.
  const slugAlreadyExisted = existsSync(gfxSlug);
  mkdirSync(gfxSlug, { recursive: true });
  writeFileSync(
    join(gfxSlug, 'graph.json'),
    JSON.stringify({
      nodes: [
        { id: 'createDb', kind: 'function', file: 'packages/db/src/client.ts' },
        { id: 'createDbClient', kind: 'function', file: 'apps/mcp-server/src/lib/db.ts' },
      ],
      edges: [{ from: 'createDbClient', to: 'createDb', kind: 'calls' }],
    }),
  );
  const graphPresent = await client.callTool({
    name: 'query_codebase_graph',
    arguments: { projectSlug: 'coodra', query: 'createDb' },
  });
  emit('query_codebase_graph_present', unwrap(graphPresent as ToolResult));

  // 10. Failure modes — project_not_found, run_not_found
  const pnf = await client.callTool({
    name: 'query_run_history',
    arguments: { projectSlug: `definitely-not-registered-${Math.random()}` },
  });
  emit('failure_project_not_found', unwrap(pnf as ToolResult));

  const rnf = await client.callTool({
    name: 'save_context_pack',
    arguments: { runId: 'run_does_not_exist', title: 't', content: 'c' },
  });
  emit('failure_run_not_found', unwrap(rnf as ToolResult));

  // 11. Idempotent record_decision retry — should return same id with created:false
  const retry = await client.callTool({
    name: 'record_decision',
    arguments: {
      runId,
      description: 'Use Hono for the HTTP transport routing layer',
      rationale: 'Different rationale text — should be ignored on dedupe',
    },
  });
  emit('record_decision_retry', unwrap(retry as ToolResult));

  await client.close();

  // Cleanup: remove the graph.json we seeded. Leave the context-pack
  // file in place — the report references it as the FS-materialisation
  // proof; the verification script's caller can choose to delete it.
  if (!slugAlreadyExisted) {
    try {
      rmSync(gfxSlug, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  emit('done', { runId, sqlitePath, cpRoot });
}

main().catch((err) => {
  console.error('verify.ts FATAL:', err);
  process.exit(1);
});
