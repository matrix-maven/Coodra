import { readFileSync } from 'node:fs';
import { getRunWithEverything, insertRun, migrateSqlite, type SqliteHandle } from '@coodra/db';
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

  it('keeps evidence unattached when no Run exists, never creates a Run, and still validates the project', async () => {
    const url = await listen();
    db.raw.prepare("UPDATE runs SET agent_type = 'codex'").run();
    const input = JSON.stringify(batch());
    const post = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: input });
    expect((await post()).status).toBe(200);
    await drainOutbox(db);
    expect(events()).toMatchObject([{ run_id: null, session_id: 'native-session', project_id: 'project' }]);
    // A Run of another harness for the same session is not claimed by Claude Code telemetry.
    expect(db.raw.prepare("SELECT id, agent_type FROM runs WHERE id = 'run'").all()).toEqual([
      { id: 'run', agent_type: 'codex' },
    ]);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM runs WHERE session_id = 'native-session'").get()).toEqual({
      n: 1,
    });
    await expect(createNativeTelemetryReceiver({ db })('unknown', batch())).rejects.toMatchObject({ status: 404 });
  });

  it('attaches unattached evidence when the Run is created later, without duplicating it', async () => {
    db.raw.exec("DELETE FROM runs WHERE id = 'run'");
    const receive = createNativeTelemetryReceiver({ db });
    const input = batch('claude_code.tool_result', [attr('tool_use_id', 'tool-late')]);
    await receive('fixture', input);
    await drainOutbox(db);
    expect(events()).toMatchObject([{ run_id: null, tool_use_id: 'tool-late' }]);
    await insertRun(db, {
      id: 'run-late',
      projectId: 'project',
      sessionId: 'native-session',
      agentType: 'claude_code',
      mode: 'solo',
    });
    expect(events()).toMatchObject([{ run_id: 'run-late', tool_use_id: 'tool-late' }]);
    // A replay after attachment is the same event (identity excludes the Run), not a second row.
    await receive('fixture', input);
    await drainOutbox(db);
    expect(events()).toHaveLength(1);
  });

  it('attaches at dispatch when the Run appears between receipt and drain', async () => {
    db.raw.exec("DELETE FROM runs WHERE id = 'run'");
    await createNativeTelemetryReceiver({ db })('fixture', batch());
    db.raw
      .prepare(
        "INSERT INTO runs (id, project_id, session_id, agent_type, mode) VALUES ('run-between', 'project', 'native-session', 'claude_code', 'solo')",
      )
      .run();
    await drainOutbox(db);
    expect(events()).toMatchObject([{ run_id: 'run-between' }]);
  });

  it('bounds unattached evidence separately from attached evidence', async () => {
    db.raw.exec("DELETE FROM runs WHERE id = 'run'");
    db.raw.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 2000)
      INSERT INTO pending_jobs (id, queue, payload, run_after)
      SELECT 'native_telemetry_unattached_' || x, 'native_telemetry', '{"runId":null}', 1 FROM n`);
    await expect(createNativeTelemetryReceiver({ db })('fixture', batch())).rejects.toMatchObject({
      status: 503,
      message: 'telemetry_unattached_capacity_exceeded',
    });
    db.raw
      .prepare(
        "INSERT INTO runs (id, project_id, session_id, agent_type, mode) VALUES ('run', 'project', 'native-session', 'claude_code', 'solo')",
      )
      .run();
    await expect(createNativeTelemetryReceiver({ db })('fixture', batch())).resolves.toEqual({});
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
      SELECT 'native_telemetry_budget_' || x, 'native_telemetry', '{"runId":"run"}', 1 FROM n`);
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

  it('keeps telemetry as unattached evidence when its Run is deleted, leaving hook run_events alone', async () => {
    db.raw
      .prepare(
        "INSERT INTO run_events (id, run_id, phase, tool_name, tool_use_id, tool_input) VALUES ('hook', 'run', 'post', 'Read', 't', '{}')",
      )
      .run();
    await createNativeTelemetryReceiver({ db })('fixture', batch());
    await drainOutbox(db);
    expect(events()).toMatchObject([{ run_id: 'run' }]);
    db.raw.exec("DELETE FROM run_events; DELETE FROM runs WHERE id = 'run'");
    expect(events()).toMatchObject([{ run_id: null }]);
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

  it('stamps queued jobs with project and run so project deletion cannot strand them', async () => {
    await createNativeTelemetryReceiver({ db })('fixture', batch());
    expect(db.raw.prepare('SELECT project_id, run_id FROM pending_jobs').all()).toEqual([
      { project_id: 'project', run_id: 'run' },
    ]);
  });

  it('upgrades revision-1 run_events telemetry into the new table, preserving id and receipt time', async () => {
    const legacy = {
      input: {},
      output: {
        version: 1,
        harness: 'claude_code',
        source: 'otlp_logs',
        eventName: 'claude_code.api_request',
        sourceTimeUnixNano: '1794911514452000000',
        receivedAt: '2026-11-17T10:32:23.773Z',
        projectId: 'project',
        runId: 'run',
        sessionId: 'native-session',
        attributes: {
          'session.id': 'native-session',
          'prompt.id': 'p1',
          model: 'm',
          input_tokens: 5,
          cost_usd: 0.25,
          success: true,
        },
        content: 'excluded',
        costKind: 'provider_estimate',
      },
    };
    db.raw
      .prepare(
        "INSERT INTO run_events (id, run_id, phase, tool_name, tool_use_id, tool_input, created_at) VALUES ('native_telemetry_legacy', 'run', 'telemetry', 'claude_code.api_request', 'x', ?, 1794911543)",
      )
      .run(JSON.stringify(legacy));
    db.raw
      .prepare(
        "INSERT INTO run_events (id, run_id, phase, tool_name, tool_use_id, tool_input) VALUES ('hook', 'run', 'post', 'Read', 't', '{}')",
      )
      .run();
    db.raw.exec(
      readFileSync(
        new URL('../../../../../packages/db/drizzle/sqlite/0042_backfill_native_telemetry.sql', import.meta.url),
        'utf8',
      ),
    );
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      id: 'native_telemetry_legacy',
      project_id: 'project',
      run_id: 'run',
      session_id: 'native-session',
      source_time_unix_nano: '1794911514452000000',
      source_time_ms: 1794911514452,
      prompt_id: 'p1',
      model: 'm',
      input_tokens: 5,
      cost_usd_micros: 250000,
      cost_kind: 'provider_estimate',
      success: 1,
      received_at: 1794911543,
    });
    expect(db.raw.prepare('SELECT id FROM run_events').all()).toEqual([{ id: 'hook' }]);
  });

  it('routes a queued revision-1 telemetry run_event job to the new table', async () => {
    const output = {
      harness: 'claude_code',
      source: 'otlp_logs',
      eventName: 'claude_code.tool_result',
      sourceTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
      receivedAt: new Date().toISOString(),
      projectId: 'project',
      sessionId: 'native-session',
      attributes: { 'session.id': 'native-session', tool_use_id: 'tool-9', success: false },
      costKind: 'unavailable',
    };
    const payload = {
      v: 1,
      rowId: 'native_telemetry_queued_legacy',
      resolution: { kind: 'pre_resolved', runId: 'run' },
      phase: 'telemetry',
      toolName: 'claude_code.tool_result',
      toolUseId: 'tool-9',
      toolInput: JSON.stringify({ input: {}, output }),
      outcome: null,
    };
    db.raw
      .prepare(
        "INSERT INTO pending_jobs (id, queue, payload) VALUES ('native_telemetry_queued_legacy', 'run_event', ?)",
      )
      .run(JSON.stringify(payload));
    await drainOutbox(db);
    expect(events()).toMatchObject([{ id: 'native_telemetry_queued_legacy', tool_use_id: 'tool-9', success: 0 }]);
    expect(db.raw.prepare('SELECT id FROM run_events').all()).toHaveLength(0);
  });

  it('expires unattached evidence after 24 hours but keeps attached evidence for 7 days', async () => {
    const day = 86_400;
    const now = Math.floor(Date.now() / 1000);
    const insert = db.raw.prepare(
      `INSERT INTO native_telemetry_events (id, project_id, run_id, harness, source, event_name,
         source_time_unix_nano, source_time_ms, session_id, cost_kind, received_at)
       VALUES (?, 'project', ?, 'claude_code', 'otlp_logs', 'claude_code.api_error', '1', 1, 's', 'unavailable', ?)`,
    );
    insert.run('native_telemetry_attached_2d', 'run', now - 2 * day);
    insert.run('native_telemetry_unattached_2d', null, now - 2 * day);
    insert.run('native_telemetry_unattached_1h', null, now - 3600);
    insert.run('native_telemetry_attached_8d', 'run', now - 8 * day);
    await pruneNativeTelemetry(db);
    expect(events().map((row) => row.id)).toEqual(['native_telemetry_attached_2d', 'native_telemetry_unattached_1h']);
  });

  it('stores Coodra hook execution metadata, which arrives before the SessionStart hook creates the Run', async () => {
    db.raw.exec("DELETE FROM runs WHERE id = 'run'");
    const receive = createNativeTelemetryReceiver({ db });
    // Shapes copied from a real Claude Code 2.1.330 export: numbers arrive as strings.
    await receive(
      'fixture',
      batch('claude_code.hook_execution_complete', [
        attr('hook_event', 'SessionStart'),
        attr('hook_name', 'SessionStart:startup'),
        attr('num_hooks', '2'),
        attr('num_success', '1'),
        attr('num_blocking', '0'),
        attr('num_non_blocking_error', '1'),
        attr('num_cancelled', '0'),
        attr('total_duration_ms', '86'),
        attr('stdout_chars', '69'),
        attr('hook_source', 'merged'),
        attr('safe_mode', 'false'),
        attr('hook_command', 'PRIVATE_COMMAND'),
        attr('user.email', 'PRIVATE@example.com'),
      ]),
    );
    await drainOutbox(db);
    expect(events()).toMatchObject([
      {
        event_name: 'claude_code.hook_execution_complete',
        run_id: null,
        hook_event: 'SessionStart',
        hook_name: 'SessionStart:startup',
        hook_count: 2,
        hook_success_count: 1,
        hook_blocking_count: 0,
        hook_error_count: 1,
        hook_cancelled_count: 0,
        duration_ms: 86,
        cost_kind: 'unavailable',
      },
    ]);
    const attrs = JSON.parse(String(events()[0]?.attributes_json));
    expect(attrs).toMatchObject({ stdout_chars: 69, hook_source: 'merged', safe_mode: false });
    expect(JSON.stringify(events())).not.toContain('PRIVATE');
    await insertRun(db, {
      id: 'run-session-start',
      projectId: 'project',
      sessionId: 'native-session',
      agentType: 'claude_code',
      mode: 'solo',
    });
    expect(events()).toMatchObject([{ run_id: 'run-session-start' }]);
  });

  it('stores MCP server connection metadata without naming the server or the plugin', async () => {
    await createNativeTelemetryReceiver({ db })(
      'fixture',
      batch('claude_code.mcp_server_connection', [
        attr('status', 'connected'),
        attr('transport_type', 'stdio'),
        attr('server_scope', 'dynamic'),
        attr('duration_ms', '167'),
        attr('is_plugin', 'true'),
        attr('plugin_id_hash', 'bbd0cba2f37d96ac'),
        attr('plugin.name', 'PRIVATE_PLUGIN'),
      ]),
    );
    await drainOutbox(db);
    expect(events()).toMatchObject([
      {
        event_name: 'claude_code.mcp_server_connection',
        connection_status: 'connected',
        transport_type: 'stdio',
        server_scope: 'dynamic',
        duration_ms: 167,
        plugin_id_hash: 'bbd0cba2f37d96ac',
        run_id: 'run',
      },
    ]);
    expect(JSON.stringify(events())).not.toContain('PRIVATE_PLUGIN');
    expect(JSON.parse(String(events()[0]?.attributes_json))).toMatchObject({ is_plugin: true });
  });

  it('still rejects other hook and plugin lifecycle events', async () => {
    const receive = createNativeTelemetryReceiver({ db });
    for (const name of [
      'claude_code.hook_execution_start',
      'claude_code.hook_registered',
      'claude_code.plugin_loaded',
      'claude_code.managed_settings_resolved',
    ]) {
      expect(await receive('fixture', batch(name))).toMatchObject({ partialSuccess: { rejectedLogRecords: '1' } });
    }
    expect(db.raw.prepare('SELECT id FROM pending_jobs').all()).toHaveLength(0);
  });
});
