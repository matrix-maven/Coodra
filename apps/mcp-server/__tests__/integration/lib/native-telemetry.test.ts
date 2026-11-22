import { getRunWithEverything, migrateSqlite, type SqliteHandle } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __internal as envInternal } from '../../../src/config/env.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createNativeTelemetryReceiver, pruneNativeTelemetry } from '../../../src/lib/native-telemetry.js';
import { type HttpTransportHandle, startHttpTransport } from '../../../src/transports/http.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';
import { drainOutbox } from '../_helpers/drain-outbox.js';

const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
function batch(
  name = 'claude_code.api_request',
  extra: ReturnType<typeof attr>[] = [],
  time = String(BigInt(Date.now()) * 1_000_000n),
) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [attr('service.name', 'claude-code')] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: time,
                body: { stringValue: name },
                attributes: [
                  attr('session.id', 'native-session'),
                  attr('app.version', 'fixture-not-live'),
                  attr('event.sequence', '1'),
                  ...extra,
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('native telemetry — HTTP/JSON to durable Run evidence', () => {
  let db: SqliteHandle;
  let closeDb: () => Promise<void>;
  const events = () =>
    db.raw.prepare('SELECT * FROM native_telemetry_events ORDER BY source_time_ms').all() as Record<string, unknown>[];
  let http: HttpTransportHandle | undefined;
  beforeEach(() => {
    const client = createDbClient({ mode: 'solo', sqlite: { path: ':memory:', skipPragmas: true } });
    const handle = client.asInternalHandle();
    if (handle.kind !== 'sqlite') throw new Error('sqlite required');
    db = handle;
    closeDb = () => client.client.close();
    migrateSqlite(db.db);
    db.raw
      .prepare("INSERT INTO projects (id, slug, org_id, name) VALUES ('project', 'fixture', 'org', 'Fixture')")
      .run();
    db.raw
      .prepare(
        "INSERT INTO runs (id, project_id, session_id, agent_type, mode) VALUES ('run', 'project', 'native-session', 'claude_code', 'solo')",
      )
      .run();
  });
  afterEach(async () => {
    await http?.close();
    http = undefined;
    await closeDb();
  });

  async function listen(enabled = true) {
    http = await startHttpTransport({
      registry: new ToolRegistry({ deps: makeFakeDeps() }),
      serverName: 'telemetry-test',
      serverVersion: '0',
      env: envInternal.schema.parse({
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        COODRA_MODE: 'solo',
        COODRA_LOG_DESTINATION: 'stderr',
        MCP_SERVER_HOST: '127.0.0.1',
        MCP_SERVER_PORT: 0,
        CLERK_SECRET_KEY: 'sk_test_replace_me',
      }),
      ...(enabled ? { telemetryLogs: createNativeTelemetryReceiver({ db }) } : {}),
    });
    return `${http.url}/telemetry/claude_code/fixture/v1/logs`;
  }

  it('persists usage metadata once through HTTP, queue and dispatcher; strips content before the queue', async () => {
    const url = await listen();
    const input = batch('claude_code.api_request', [
      attr('input_tokens', '120'),
      attr('cost_usd', '0.002'),
      attr('prompt', 'PRIVATE_PROMPT'),
      attr('tool_input', 'PRIVATE_TOOL'),
      attr('error', 'PRIVATE_ERROR'),
    ]);
    const post = () =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    expect((await post()).status).toBe(200);
    const queued = db.raw.prepare('SELECT payload FROM pending_jobs').all();
    expect(queued).toHaveLength(1);
    expect(JSON.stringify(queued)).not.toContain('PRIVATE_');
    expect(events()).toHaveLength(0);
    await drainOutbox(db);
    expect((await post()).status).toBe(200);
    await drainOutbox(db);
    const rows = events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      harness: 'claude_code',
      session_id: 'native-session',
      run_id: 'run',
      project_id: 'project',
      source: 'otlp_logs',
      event_name: 'claude_code.api_request',
      content_policy: 'excluded',
      cost_kind: 'provider_estimate',
      input_tokens: 120,
      cost_usd_micros: 2000,
      tool_use_id: null,
      success: null,
    });
    expect(JSON.parse(String(rows[0]?.attributes_json))).toMatchObject({ input_tokens: 120, cost_usd: 0.002 });
    expect(JSON.stringify(rows)).not.toContain('PRIVATE_');
    // Hook/MCP audit trail is untouched by native telemetry.
    expect(db.raw.prepare('SELECT id FROM run_events').all()).toHaveLength(0);
    expect((await getRunWithEverything(db, 'run'))?.events).toHaveLength(0);
  });

  it('preserves native tool identity and execution failure independently of policy', async () => {
    const receive = createNativeTelemetryReceiver({ db });
    await receive(
      'fixture',
      batch('claude_code.tool_result', [attr('tool_use_id', 'tool-1'), attr('success', 'false')]),
    );
    await drainOutbox(db);
    const [row] = events();
    expect(row).toMatchObject({
      tool_use_id: 'tool-1',
      success: 0,
      cost_kind: 'unavailable',
      cost_usd_micros: null,
      event_name: 'claude_code.tool_result',
    });
  });

  it('does not collapse repeated sequence numbers after resume or reordered arrival', async () => {
    const receive = createNativeTelemetryReceiver({ db });
    const now = BigInt(Date.now()) * 1_000_000n;
    await receive('fixture', batch('claude_code.api_error', [], String(now)));
    await receive('fixture', batch('claude_code.api_error', [], String(now - 1_000_000n)));
    await drainOutbox(db);
    expect(events()).toHaveLength(2);
  });

  it('retries an unavailable Run and validates project and harness without creating or guessing identity', async () => {
    const url = await listen();
    db.raw.prepare("UPDATE runs SET agent_type = 'codex'").run();
    const input = JSON.stringify(batch());
    const post = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: input });
    expect((await post()).status).toBe(503);
    expect(db.raw.prepare('SELECT id FROM pending_jobs').all()).toHaveLength(0);
    db.raw.prepare("UPDATE runs SET agent_type = 'claude_code'").run();
    expect((await post()).status).toBe(200);
    await expect(createNativeTelemetryReceiver({ db })('unknown', batch())).rejects.toMatchObject({ status: 404 });
  });

  it('returns OTLP partial rejection for unsupported or expired evidence', async () => {
    const receive = createNativeTelemetryReceiver({ db });
    expect(await receive('fixture', batch('claude_code.user_prompt', [attr('prompt', 'PRIVATE')]))).toMatchObject({
      partialSuccess: { rejectedLogRecords: '1' },
    });
    expect(await receive('fixture', batch('claude_code.api_error', [], '1'))).toMatchObject({
      partialSuccess: { rejectedLogRecords: '1' },
    });
    expect(db.raw.prepare('SELECT id FROM pending_jobs').all()).toHaveLength(0);
  });

  it('does not acknowledge enqueue failure as durable acceptance', async () => {
    const url = await listen();
    db.raw.exec(
      "CREATE TRIGGER fail_telemetry BEFORE INSERT ON pending_jobs BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
    );
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch()),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
  });

  it('keeps the endpoint opt-in and rejects browser origins, unsupported protocols and malformed payloads', async () => {
    const url = await listen();
    const request = (headers: Record<string, string>, body = '{}') => fetch(url, { method: 'POST', headers, body });
    expect((await request({ origin: 'https://example.com', 'content-type': 'application/json' })).status).toBe(403);
    expect((await request({ 'content-type': 'application/x-protobuf' })).status).toBe(415);
    expect((await request({ 'content-type': 'application/json' }, '{')).status).toBe(400);
    expect((await request({ 'content-type': 'application/json' })).status).toBe(400);
    expect(
      (await request({ 'content-type': 'application/json' }, JSON.stringify({ padding: 'x'.repeat(1_048_576) })))
        .status,
    ).toBe(413);
    await http?.close();
    http = undefined;
    const disabledUrl = await listen(false);
    expect((await fetch(disabledUrl, { method: 'POST' })).status).toBe(404);
    expect((await fetch(disabledUrl.replace('claude_code', 'codex'), { method: 'POST' })).status).toBe(404);
  });

  it('bounds concurrent admission while allowing exact replay at capacity', async () => {
    db.raw.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 9999)
      INSERT INTO pending_jobs (id, queue, payload, run_after)
      SELECT 'native_telemetry_budget_' || x, 'native_telemetry', '{}', 1 FROM n`);
    const receive = createNativeTelemetryReceiver({ db });
    const now = BigInt(Date.now()) * 1_000_000n;
    const first = batch('claude_code.api_request', [], String(now));
    const results = await Promise.allSettled([
      receive('fixture', first),
      receive('fixture', batch('claude_code.api_request', [], String(now + 1n))),
    ]);
    expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'rejected']);
    await expect(receive('fixture', first)).resolves.toEqual({});
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM pending_jobs').get()).toEqual({ count: 10000 });
  });

  it('expires only native telemetry evidence and its retained queue payloads', async () => {
    await createNativeTelemetryReceiver({ db })('fixture', batch());
    await drainOutbox(db);
    db.raw.exec('UPDATE native_telemetry_events SET received_at = 1; UPDATE pending_jobs SET created_at = 1');
    const pruned = await pruneNativeTelemetry(db);
    expect(pruned).toBeGreaterThanOrEqual(1);
    expect(events()).toHaveLength(0);
    expect(db.raw.prepare("SELECT id FROM runs WHERE id = 'run'").all()).toHaveLength(1);
  });

  it('removes telemetry with its Run and leaves hook run_events alone', async () => {
    db.raw
      .prepare(
        "INSERT INTO run_events (id, run_id, phase, tool_name, tool_use_id, tool_input) VALUES ('hook', 'run', 'post', 'Read', 't', '{}')",
      )
      .run();
    await createNativeTelemetryReceiver({ db })('fixture', batch());
    await drainOutbox(db);
    expect(events()).toHaveLength(1);
    db.raw.exec("DELETE FROM runs WHERE id = 'run'");
    expect(events()).toHaveLength(0);
  });

  it('records an unreadable job as dead rather than writing a partial row', async () => {
    db.raw
      .prepare("INSERT INTO pending_jobs (id, queue, payload) VALUES ('native_telemetry_bad', 'native_telemetry', ?)")
      .run(JSON.stringify({ v: 1, rowId: 'native_telemetry_bad' }));
    await drainOutbox(db);
    expect(events()).toHaveLength(0);
    const job = db.raw.prepare("SELECT status FROM pending_jobs WHERE id = 'native_telemetry_bad'").get() as {
      status: string;
    };
    expect(job.status).not.toBe('pending');
  });
});
