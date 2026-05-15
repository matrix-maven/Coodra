/**
 * Phase 5 closed-loop integration test for the 2026-04-27 verification.
 *
 * Drives:
 *   (a) SessionStart hook → bridge → runs row in shared DB
 *   (b) MCP get_run_id WITH agentSessionId=SESSID → MCP must find the
 *       SAME runs row (F9 closure)
 *   (c) PreToolUse + PostToolUse hooks → policy_decisions + run_events,
 *       both linked to the runs row (F8 closure)
 *   (d) MCP record_decision → decisions table
 *   (e) Stop hook → runs.status=completed
 *   (f) MCP query_run_history → returns the one shared run
 *
 * Bridge is assumed running on http://127.0.0.1:3201 against the same
 * sqlite path this script spawns the MCP subprocess against.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..', '..');
const SERVER_BIN = resolve(ROOT, 'apps/mcp-server/dist/index.js');

const SHARED_DB = '/tmp/p4p5-verify/data.db';
const BRIDGE_URL = 'http://127.0.0.1:3201';
const SECRET = process.env.LOCAL_HOOK_SECRET ?? '';
const PROJECT_SLUG = 'p4p5-test';
const SESSID = `phase5-shared-${Date.now()}`;

interface ToolResult {
  readonly content: ReadonlyArray<{ readonly text?: string }>;
}
function unwrap(r: unknown): Record<string, unknown> {
  return JSON.parse((r as ToolResult).content[0]?.text ?? '{}') as Record<string, unknown>;
}
function emit(label: string, payload: unknown): void {
  process.stdout.write(`${label}\n  ${JSON.stringify(payload)}\n`);
}

async function postHook(eventName: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${BRIDGE_URL}/v1/hooks/claude-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-Hook-Secret': SECRET },
    body: JSON.stringify({
      session_id: SESSID,
      hook_event_name: eventName,
      cwd: '/tmp/p4p5-cwd-registered',
      ...body,
    }),
  });
  return { status: res.status, body: await res.json() };
}

async function main(): Promise<void> {
  process.stdout.write(`SESSID = ${SESSID}\n`);
  process.stdout.write(`SHARED_DB = ${SHARED_DB}\n\n`);

  // (a) SessionStart hook → bridge writes runs row
  emit('(a) SessionStart hook', await postHook('SessionStart', {}));

  // Spawn MCP server against the SAME sqlite the bridge is using
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_BIN, '--transport', 'stdio'],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'production',
      COODRA_SQLITE_PATH: SHARED_DB,
      COODRA_LOG_DESTINATION: 'stderr',
      COODRA_MODE: 'solo',
      CLERK_SECRET_KEY: 'sk_test_replace_me',
      CLERK_PUBLISHABLE_KEY: 'pk_test_replace_me',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'phase5-closed-loop', version: '0.0.0' });
  await client.connect(transport);

  // (b) MCP get_run_id WITH agentSessionId — must resolve to the same runs row
  const runIdResp = await client.callTool({
    name: 'get_run_id',
    arguments: {
      projectSlug: PROJECT_SLUG,
      agentSessionId: SESSID,
      agentType: 'claude_code',
    },
  });
  const runIdData = unwrap(runIdResp);
  emit('(b) MCP get_run_id (agentSessionId supplied)', runIdData);
  const runId = (runIdData as { data?: { runId?: string } }).data?.runId;
  if (!runId) throw new Error('no runId from get_run_id');

  // (c) Pre/Post hooks
  emit(
    '(c) PreToolUse hook',
    await postHook('PreToolUse', {
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/safe/closedloop.ts' },
      tool_use_id: 'tu-cl-1',
    }),
  );
  emit(
    '(c) PostToolUse hook',
    await postHook('PostToolUse', {
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/safe/closedloop.ts' },
      tool_use_id: 'tu-cl-1',
    }),
  );

  // (d) MCP record_decision against the run
  const decResp = await client.callTool({
    name: 'record_decision',
    arguments: {
      runId,
      description: 'Phase 5 closed-loop decision — agent identity reconciled',
      rationale: 'Pass agentSessionId so MCP and bridge share one runs row',
    },
  });
  emit('(d) MCP record_decision', unwrap(decResp));

  // (e) Stop hook
  emit('(e) Stop hook', await postHook('Stop', {}));

  // Wait for async writes to drain
  await new Promise((r) => setTimeout(r, 1500));

  // (f) MCP query_run_history
  const histResp = await client.callTool({
    name: 'query_run_history',
    arguments: { projectSlug: PROJECT_SLUG, limit: 5 },
  });
  emit('(f) MCP query_run_history', unwrap(histResp));

  await client.close();
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
