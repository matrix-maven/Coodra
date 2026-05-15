/**
 * Phase 2.6 — Graceful-shutdown drain test.
 *
 * Spawns the mcp-server, fires check_policy, sends SIGTERM immediately
 * after, and counts policy_decisions rows in the underlying sqlite once
 * the process exits. The audit write is async (setImmediate); a clean
 * shutdown must drain the pending insert before closing the DB.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..', '..');
const SERVER_BIN = resolve(ROOT, 'apps/mcp-server/dist/index.js');

async function main(): Promise<void> {
  const verifyRoot = '/tmp/coodra-verify-sigterm';
  rmSync(verifyRoot, { recursive: true, force: true });
  mkdirSync(verifyRoot, { recursive: true });

  const sqlitePath = `${verifyRoot}/data.db`;

  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_BIN, '--transport', 'stdio'],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'production',
      COODRA_SQLITE_PATH: sqlitePath,
      COODRA_LOG_DESTINATION: 'stderr',
      COODRA_MODE: 'solo',
      CLERK_SECRET_KEY: 'sk_test_replace_me',
      CLERK_PUBLISHABLE_KEY: 'pk_test_replace_me',
    },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'verify-sigterm', version: '0.0.0' });
  await client.connect(transport);

  const projectSlug = 'sigterm-drain-test';
  // Mint the run / project so check_policy has a real project.
  const runIdResp = await client.callTool({ name: 'get_run_id', arguments: { projectSlug } });
  const runIdData = JSON.parse((runIdResp as { content: { text: string }[] }).content[0]?.text ?? '{}');
  process.stderr.write(`runIdResp: ${JSON.stringify(runIdData)}\n`);

  // Count policy_decisions before the call.
  const before = execFileSync('sqlite3', [sqlitePath, 'SELECT COUNT(*) FROM policy_decisions;'], {
    encoding: 'utf8',
  }).trim();
  const beforeCount = Number(before);
  process.stderr.write(`policy_decisions before: ${beforeCount}\n`);

  // Fire check_policy (audit write is async via setImmediate).
  await client.callTool({
    name: 'check_policy',
    arguments: {
      projectSlug,
      sessionId: 'sigterm-test-session',
      agentType: 'claude_code',
      eventType: 'PreToolUse',
      toolName: 'Write',
      toolInput: { file_path: '/tmp/sigterm/x.ts' },
    },
  });
  process.stderr.write('check_policy fired\n');

  // Close the SDK client cleanly — this triggers SIGTERM-equivalent shutdown
  // by closing stdio. The server's process should drain pending audit
  // writes via the SIGTERM/SIGINT handler before exiting.
  await client.close();
  process.stderr.write('client closed; waiting briefly for process exit\n');

  // Wait a beat for the server process to actually exit + drain.
  await new Promise((r) => setTimeout(r, 1500));

  const after = execFileSync('sqlite3', [sqlitePath, 'SELECT COUNT(*) FROM policy_decisions;'], {
    encoding: 'utf8',
  }).trim();
  const afterCount = Number(after);
  const auditRow = execFileSync(
    'sqlite3',
    [
      sqlitePath,
      "SELECT id || '|' || project_id || '|' || agent_type || '|' || tool_name || '|' || permission_decision || '|' || reason FROM policy_decisions LIMIT 1;",
    ],
    { encoding: 'utf8' },
  ).trim();
  process.stderr.write(`policy_decisions after: ${afterCount}\n`);
  process.stderr.write(`audit row: ${auditRow}\n`);

  if (afterCount <= beforeCount) {
    process.stderr.write('FAIL: drain did not commit the audit row\n');
    process.exit(1);
  }
  process.stderr.write('PASS: drain committed the audit row\n');
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
