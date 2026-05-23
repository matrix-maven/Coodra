import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type BootHandle, bootForE2E, buildE2eEnv, openSqliteHandle } from './_helpers/boot.js';

/**
 * Manifest E2E (S17 — `06-testing.md` §6.6 synthetic agent test).
 *
 * Connects a headless `@modelcontextprotocol/sdk` Client to an
 * in-process Streamable HTTP server, calls `tools/list`, and asserts:
 *
 *   1. The exact tool set is advertised — no extras, no missing.
 *      Locks down the `_no-unregistered-tools` unit guard at the
 *      protocol layer.
 *   2. Each description is ≤ 800 chars (per §24.3 / §6.6).
 *   3. Each input schema is valid JSON Schema and round-trips
 *      through Ajv 8 with the standard `format` keywords loaded
 *      (datetime, uri, …).
 *   4. Each tool's "minimal valid input" call returns a shape that
 *      either parses through the SDK without throwing, or returns a
 *      structured `isError: true` envelope (the contract for
 *      handler-level failure paths).
 *
 * Tool inventory (must match `apps/mcp-server/src/tools/index.ts::registerAllTools`).
 * Drift log (mirrors `apps/mcp-server/__tests__/integration/boot.test.ts`):
 *   Slice 4 (2026-05-03 audit): query_decisions added → 10
 *   M02 S11/12 + M05 + M06 batch (2026-05-08 → 2026-05-09):
 *     list_context_packs + read_context_pack + list_features +
 *     get_feature + get_feature_file + query_run_diff → 16
 *   Module 09 G1 (2026-05-21): query_codebase_graph removed → 15
 *   Module 09 G2 (2026-05-21): seed_feature_packs_from_graph added → 16
 */

const EXPECTED_TOOLS = [
  'ping',
  'get_run_id',
  'get_feature_pack',
  'save_context_pack',
  'search_packs_nl',
  'record_decision',
  'query_run_history',
  'check_policy',
  'query_decisions',
  'list_context_packs',
  'read_context_pack',
  'list_features',
  'get_feature',
  'get_feature_file',
  'query_run_diff',
  'seed_feature_packs_from_graph',
] as const;

interface Harness {
  readonly boot: BootHandle;
  readonly closeDb: () => Promise<void>;
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
}

let h: Harness;

beforeAll(async () => {
  const { handle, close: closeDb } = openSqliteHandle();
  // Solo-bypass auth so the SDK Client doesn't need to mint a JWT.
  const env = buildE2eEnv({ COODRA_MODE: 'solo', CLERK_SECRET_KEY: 'sk_test_replace_me' });
  const boot = await bootForE2E({ db: handle, env, withHttp: true });
  if (!boot.http) throw new Error('expected HTTP transport handle');

  const transport = new StreamableHTTPClientTransport(new URL(`${boot.http.url}/mcp`));
  const client = new Client({ name: 'manifest-e2e', version: '0.0.0-e2e' }, { capabilities: {} });
  await client.connect(transport);

  h = { boot, closeDb, client, transport };
});

afterAll(async () => {
  await h.client.close().catch(() => {});
  await h.boot.close();
  await h.closeDb();
});

describe('manifest-e2e — exactly the locked tool set is advertised', () => {
  it('returns exactly the expected tool names — no extras, no missing', async () => {
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name).sort();
    const expected = [...EXPECTED_TOOLS].sort();
    expect(names).toEqual(expected);
  });

  it('the count matches the locked inventory length even if order changes', async () => {
    const { tools } = await h.client.listTools();
    expect(tools).toHaveLength(EXPECTED_TOOLS.length);
  });
});

describe('manifest-e2e — each description ≤ 800 chars (§24.3 hard cap)', () => {
  it('all descriptions are within the 800-char ceiling', async () => {
    const { tools } = await h.client.listTools();
    for (const tool of tools) {
      const len = tool.description?.length ?? 0;
      expect(len, `tool ${tool.name} description length`).toBeLessThanOrEqual(800);
      expect(len, `tool ${tool.name} description must be present`).toBeGreaterThan(0);
    }
  });
});

describe('manifest-e2e — each input schema is valid JSON Schema (Ajv 8 round-trip)', () => {
  it('every advertised inputSchema compiles without errors', async () => {
    const { tools } = await h.client.listTools();
    // Ajv2020 supports the JSON Schema draft 2020-12 dialect that
    // Zod emits via `.toJSONSchema()`. Plain `new Ajv()` rejects the
    // `$schema: "https://json-schema.org/draft/2020-12/schema"` URI.
    const ajv = new (Ajv2020 as unknown as typeof import('ajv').default)({ strict: false, allErrors: true });
    addFormats(ajv);
    for (const tool of tools) {
      const schema = tool.inputSchema as object;
      expect(schema, `tool ${tool.name} must have inputSchema`).toBeTruthy();
      // `compile` throws synchronously on schema errors.
      const validate = ajv.compile(schema);
      expect(typeof validate, `tool ${tool.name} schema compiled`).toBe('function');
    }
  });
});

describe('manifest-e2e — minimal-valid-input round-trip per tool', () => {
  // Each tool gets a curated minimal-valid payload. The handler may
  // return success OR a soft-failure (isError: true) — both are
  // legitimate protocol shapes; what matters is the SDK doesn't throw.
  const PROBE_INPUTS: Readonly<Record<(typeof EXPECTED_TOOLS)[number], Record<string, unknown>>> = {
    ping: { echo: 'hello' },
    get_run_id: { projectSlug: 'e2e-probe', sessionId: 'sess-probe', agentType: 'claude_code', mode: 'solo' },
    get_feature_pack: { projectSlug: 'e2e-probe' },
    save_context_pack: { runId: 'run_does_not_exist', title: 't', content: 'c' },
    search_packs_nl: { projectSlug: 'e2e-probe', query: 'anything' },
    record_decision: { runId: 'run_does_not_exist', description: 'd', rationale: 'r' },
    query_run_history: { projectSlug: 'e2e-probe' },
    check_policy: {
      projectSlug: 'e2e-probe',
      sessionId: 'sess-probe',
      agentType: 'claude_code',
      eventType: 'PreToolUse',
      toolName: 'Write',
      toolInput: { file_path: '/tmp/x' },
    },
    seed_feature_packs_from_graph: {
      projectSlug: 'e2e-probe',
      communities: [{ communityId: 'c1', label: 'Probe Community' }],
    },
  };

  for (const name of EXPECTED_TOOLS) {
    it(`${name}: minimal-valid-input round-trips`, async () => {
      const result = await h.client.callTool({
        name,
        arguments: PROBE_INPUTS[name],
      });
      // Result is either { content: [...], isError?: true, structuredContent?: ... }
      // — both success and structured-failure are valid protocol shapes.
      expect(result).toBeTruthy();
      expect(Array.isArray(result.content)).toBe(true);
      // If a tool flagged isError, the description-length / schema
      // assertions still passed earlier — the soft-failure envelope is
      // an intentional return shape, not a protocol violation.
    });
  }
});
