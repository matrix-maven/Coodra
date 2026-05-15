/**
 * F5 closure live demonstration — spawns a fresh stdio subprocess
 * against the current rebuilt dist (NOT the IDE's stale subprocess)
 * and calls check_policy with sessionId='has:colon'. Pastes the
 * actual response.
 *
 * Phase 4 Fix F (2026-05-02) extension: also calls check_policy
 * with tool_name='Edit' against `.env` and tool_name='MultiEdit'
 * against `apps/web/.env` — both must return permissionDecision='deny'
 * after Phase 4 Fix F lands. Pre-Fix-F dist returned 'allow' for
 * MultiEdit because the default policy only seeded Write+Edit rules.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..', '..');
const SERVER_BIN = resolve(ROOT, 'apps/mcp-server/dist/index.js');

async function main(): Promise<void> {
  const sqliteDir = mkdtempSync(join(tmpdir(), 'verify-f5-live-'));
  const sqlitePath = join(sqliteDir, 'data.db');

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
  const client = new Client({ name: 'verify-f5-live', version: '0.0.0' });
  await client.connect(transport);

  // Make sure a project exists so check_policy reaches the schema-validation layer
  // (project_not_found short-circuits before sessionId validation otherwise).
  await client.callTool({ name: 'get_run_id', arguments: { projectSlug: 'verify-f5-live' } });

  // F5 case (Phase 3): colon-bearing sessionId. Pre-fix dist returns
  // permissionDecision='allow'; post-fix dist returns invalid_input.
  process.stdout.write('--- F5 (sessionId colon shape) ---\n');
  const f5Result = await client.callTool({
    name: 'check_policy',
    arguments: {
      projectSlug: 'verify-f5-live',
      sessionId: 'has:colon',
      agentType: 'claude_code',
      eventType: 'PreToolUse',
      toolName: 'Write',
      toolInput: { file_path: '/tmp/x.ts' },
    },
  });
  process.stdout.write(`${(f5Result as { content: { text: string }[] }).content[0]?.text ?? '{}'}\n`);

  // Phase 4 Fix F regression: Edit on .env. Pre-Fix-F default policy
  // seeded Write+Edit deny rules so this returns 'deny' on BOTH pre-
  // and post-Fix-F. Asserts the Edit coverage didn't regress.
  process.stdout.write('--- Phase 4 Fix F: Edit → .env ---\n');
  const editResult = await client.callTool({
    name: 'check_policy',
    arguments: {
      projectSlug: 'verify-f5-live',
      sessionId: 'phase4-edit-env',
      agentType: 'claude_code',
      eventType: 'PreToolUse',
      toolName: 'Edit',
      toolInput: { file_path: '.env' },
    },
  });
  process.stdout.write(`${(editResult as { content: { text: string }[] }).content[0]?.text ?? '{}'}\n`);

  // Phase 4 Fix F regression: MultiEdit on apps/web/.env (nested).
  // Pre-Fix-F: returns 'allow' (no MultiEdit rules + no nested-glob).
  // Post-Fix-F: returns 'deny' with the MultiEdit rule's reason.
  process.stdout.write('--- Phase 4 Fix F: MultiEdit → apps/web/.env (nested) ---\n');
  const multiEditResult = await client.callTool({
    name: 'check_policy',
    arguments: {
      projectSlug: 'verify-f5-live',
      sessionId: 'phase4-multiedit-nested-env',
      agentType: 'claude_code',
      eventType: 'PreToolUse',
      toolName: 'MultiEdit',
      toolInput: { file_path: 'apps/web/.env' },
    },
  });
  process.stdout.write(`${(multiEditResult as { content: { text: string }[] }).content[0]?.text ?? '{}'}\n`);

  // Phase 4 Fix F regression: NotebookEdit on .git/HEAD.
  // Pre-Fix-F: returns 'allow' (no NotebookEdit rules).
  // Post-Fix-F: returns 'deny' with the NotebookEdit rule's reason.
  process.stdout.write('--- Phase 4 Fix F: NotebookEdit → .git/HEAD ---\n');
  const notebookEditResult = await client.callTool({
    name: 'check_policy',
    arguments: {
      projectSlug: 'verify-f5-live',
      sessionId: 'phase4-notebookedit-git',
      agentType: 'claude_code',
      eventType: 'PreToolUse',
      toolName: 'NotebookEdit',
      toolInput: { file_path: '.git/HEAD' },
    },
  });
  process.stdout.write(`${(notebookEditResult as { content: { text: string }[] }).content[0]?.text ?? '{}'}\n`);

  await client.close();
  rmSync(sqliteDir, { recursive: true, force: true });
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
