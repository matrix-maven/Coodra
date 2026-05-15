/**
 * Closeout helper — saves the M01-M02-M03 verification context pack
 * via the MCP server. The IDE's MCP subprocess died when verify-phase
 * tests killed all Node servers, so spawn a fresh stdio one for this
 * single call.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..', '..');
const SERVER_BIN = resolve(ROOT, 'apps/mcp-server/dist/index.js');

const REPORT_PATH = resolve(ROOT, 'docs/verification/2026-04-27-module-01-02-03-verification.md');

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_BIN, '--transport', 'stdio'],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'production',
      COODRA_LOG_DESTINATION: 'stderr',
      COODRA_MODE: 'solo',
      CLERK_SECRET_KEY: 'sk_test_replace_me',
      CLERK_PUBLISHABLE_KEY: 'pk_test_replace_me',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'verify-closeout', version: '0.0.0' });
  await client.connect(transport);

  // Get a runId for this closeout session.
  const runIdResp = await client.callTool({
    name: 'get_run_id',
    arguments: { projectSlug: 'coodra' },
  });
  const data = JSON.parse((runIdResp as { content: { text: string }[] }).content[0]?.text ?? '{}') as {
    ok?: boolean;
    data?: { runId?: string };
  };
  const runId = data.data?.runId;
  if (!runId) throw new Error(`no runId: ${JSON.stringify(data)}`);
  process.stderr.write(`runId: ${runId}\n`);

  const reportBody = readFileSync(REPORT_PATH, 'utf8');
  const summary = `# Whole-Product Verification — Modules 01 + 02 + 03 (2026-04-27)

Read-only verification of M01+M02+M03 as one shipped product on \`feat/03-hooks-bridge\` @ \`f41a01b\`.

**Outcome:** the closed loop runs end-to-end (SessionStart→get_run_id→Pre/Post→record_decision→Stop→query_run_history); 13 findings logged; 2 high-severity bugs (F3 broken local-dev integration test cleanup, F8 \`run_events.run_id\` always NULL because \`scheduleRunEventInsert\` calls \`lookupRunId(undefined, …)\` and \`recordPolicyDecision\` hardcodes \`runId: null\`). 4 architectural design gaps surfaced (F5 §8.6 closure incomplete at MCP-input layer, F7 audit gap when \`.coodra.json\` is absent, F9 bridge and MCP server mint distinct \`runs\` rows for one logical session, F11 apps are SQLite-only by design — Phase 6 cloud-mode parity as scoped is impossible without code changes).

Full findings table, per-phase results, and remediation paths in:

\`docs/verification/2026-04-27-module-01-02-03-verification.md\`

## Closures of prior verification findings

§8.1 (auto-migrate) ✅, §8.2 (.mcp.dev.json) ✅, §8.3 (createDb kind discriminator) ✅, §8.4 (sanitized filenames) ✅, §8.5 (env-overridable roots) ✅, §8.6 (sessionId no-colon) ⚠️ partially — bridge boundary closed, MCP input layer still accepts (F5).

## Test result baseline (this branch)

- pnpm lint: 0 errors, 1 warning (F1)
- pnpm typecheck: clean (8 cached, FULL TURBO)
- migration-lock: ok (2 blocks verified)
- pnpm test:unit per package: shared 117/117, db 42/42, policy 7/7, mcp-server 223/223, hooks-bridge 12/12 = **401/401**
- @coodra/db integration: each file passes individually (7/7 + 2/2); suite fails as a unit due to F3
- 9 MCP tools registered, all descriptions ≤800 chars, soft-failure contracts honored, idempotency proven (record_decision retry → \`created: false\`)
- HTTP transport auth chain: solo bypass / valid X-Local-Hook-Secret / 401 (no auth) / 401 (wrong secret) / 401 (bad Bearer) all correct
- Hooks bridge: per-agent adapters parse correctly, normalizeSessionId at boundary verified, idempotent replay (5× → 1 row), full lifecycle PASS modulo F8

## Files written this session (read-only on source)

- \`docs/verification/2026-04-27-module-01-02-03-verification.md\` (this report)
- \`context_memory/current-session.md\` (session log)
- \`context_memory/sessions/2026-04-26-module-03-closeout.md\` (archived prior session)
- \`__tests__/manual/verify-m1-m3.ts\`, \`verify-sigterm-drain.ts\`, \`verify-phase5-loop.ts\`, \`verify-save-pack.ts\` (harnesses)

No source code modified. No commits made.

## Recommended next moves

- Two-line fix for F3 + ~30 LOC fix for F8 before Module 08a or Module 04 builds on top.
- User decisions needed on F7 (audit policy when no .coodra.json), F9 (bridge vs MCP run-identity), F11 (cloud-mode boot path scope).
- F1 quick lint:fix; F2 closeout count edits; F13 pack-naming convention doc.

---

(Full report below for archive parity.)

${reportBody}
`;

  const packResp = await client.callTool({
    name: 'save_context_pack',
    arguments: {
      runId,
      title: 'Whole-product verification M01+M02+M03 (2026-04-27) — 13 findings',
      content: summary,
    },
  });
  process.stdout.write(
    `save_context_pack response: ${(packResp as { content: { text: string }[] }).content[0]?.text ?? ''}\n`,
  );

  await client.close();
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
