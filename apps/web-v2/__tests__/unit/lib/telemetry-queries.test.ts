import { createDb, type DbHandle, insertNativeTelemetryEvent, migrateSqlite } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTelemetrySession, listTelemetryEvents, listTelemetrySessions } from '@/lib/queries/telemetry';

const SESSION = 'sess-1';
const key = (event: 'PreToolUse' | 'PostToolUse', tool: string, native: string) =>
  `lifecycle_event:claude_code:${SESSION}:${event}:${tool}:${native}`;

describe('agent telemetry queries', () => {
  let handle: DbHandle;
  const raw = () => {
    if (handle.kind !== 'sqlite') throw new Error('sqlite required');
    return handle.raw;
  };
  const longAgo = Math.floor(Date.now() / 1000) - 3600;

  beforeEach(() => {
    handle = createDb({
      kind: 'local',
      mode: 'solo',
      sqlite: { path: ':memory:', skipPragmas: true },
    });
    if (handle.kind !== 'sqlite') throw new Error('sqlite required');
    migrateSqlite(handle.db);
    raw().prepare("INSERT INTO projects (id, slug, org_id, name) VALUES ('p', 'proj', 'org', 'Project')").run();
    raw()
      .prepare(
        "INSERT INTO runs (id, project_id, session_id, agent_type, mode, status) VALUES ('run', 'p', ?, 'claude_code', 'solo', 'completed')",
      )
      .run(SESSION);
    const hook = raw().prepare(
      "INSERT INTO run_events (id, run_id, phase, tool_name, tool_use_id, tool_input, outcome, created_at) VALUES (?, 'run', ?, ?, ?, '{}', 'allow', ?)",
    );
    // t1: both hooks. t2: pre only (tool failed). t3: hooks only, never reported by telemetry.
    hook.run('h1', 'pre', 'Read', key('PreToolUse', 'Read', 't1'), longAgo);
    hook.run('h2', 'post', 'Read', key('PostToolUse', 'Read', 't1'), longAgo);
    hook.run('h3', 'pre', 'Bash', key('PreToolUse', 'Bash', 't2'), longAgo);
    hook.run('h4', 'pre', 'Edit', key('PreToolUse', 'Edit', 't3'), longAgo);
    hook.run('h5', 'post', 'Edit', key('PostToolUse', 'Edit', 't3'), longAgo);
  });
  afterEach(() => {
    if (handle.kind === 'sqlite') handle.close();
  });

  const row = (id: string, over: Record<string, unknown> = {}) =>
    insertNativeTelemetryEvent(handle, {
      id,
      projectId: 'p',
      runId: 'run',
      harness: 'claude_code',
      source: 'otlp_logs',
      eventName: 'claude_code.tool_result',
      sourceTimeUnixNano: '1',
      sourceTimeMs: Date.now() - 3_000_000,
      sessionId: SESSION,
      costKind: 'unavailable',
      attributesJson: '{}',
      receivedAt: new Date(Date.now() - 3_000_000),
      ...over,
    });

  it('reconciles a session on native tool-use ids and keeps cost unavailable when no request reported one', async () => {
    await row('n1', { toolUseId: 't1', toolName: 'Read', success: true, durationMs: 4 });
    await row('n2', { toolUseId: 't2', toolName: 'Bash', success: false });
    await row('n3', { toolUseId: 't9', toolName: 'Grep', success: true });
    await row('n4', { eventName: 'claude_code.api_request', model: 'm', inputTokens: 10, outputTokens: 5 });
    const d = await getTelemetrySession('p', SESSION, handle);
    expect(d.found).toBe(true);
    expect(d.run).toMatchObject({ id: 'run', status: 'completed' });
    const byId = Object.fromEntries(d.reconciliation.operations.map((o) => [o.nativeToolUseId, o]));
    expect(byId.t1).toMatchObject({ status: 'matched', disagreements: [] });
    expect(byId.t2).toMatchObject({ status: 'matched', disagreements: [] }); // failed tool, pre hook only
    expect(byId.t3).toMatchObject({ status: 'hook_only' });
    expect(byId.t9).toMatchObject({ status: 'telemetry_only' });
    expect(d.reconciliation.summary).toMatchObject({ matched: 2, hookOnly: 1, telemetryOnly: 1 });
    expect(d.usage).toMatchObject({ requests: 1, inputTokens: 10, outputTokens: 5, costUsdMicros: null });
    expect(d.usageByModel).toMatchObject([{ model: 'm', requests: 1 }]);
  });

  it('sums provider estimates only when requests reported one', async () => {
    await row('n1', {
      eventName: 'claude_code.api_request',
      model: 'm',
      costKind: 'provider_estimate',
      costUsdMicros: 1500,
    });
    await row('n2', {
      eventName: 'claude_code.api_request',
      model: 'm',
      costKind: 'provider_estimate',
      costUsdMicros: 500,
    });
    await row('n3', { eventName: 'claude_code.api_request', model: 'm' });
    const d = await getTelemetrySession('p', SESSION, handle);
    expect(d.usage).toMatchObject({ requests: 3, costUsdMicros: 2000, requestsWithCost: 2 });
  });

  it('reports hook health and MCP connection summaries', async () => {
    await row('n1', {
      eventName: 'claude_code.hook_execution_complete',
      hookEvent: 'SessionStart',
      hookCount: 2,
      hookSuccessCount: 1,
      hookErrorCount: 1,
      durationMs: 80,
    });
    await row('n2', {
      eventName: 'claude_code.mcp_server_connection',
      connectionStatus: 'failed',
      transportType: 'http',
      serverScope: 'dynamic',
      durationMs: 1400,
    });
    const d = await getTelemetrySession('p', SESSION, handle);
    expect(d.hookHealth).toMatchObject([{ hookEvent: 'SessionStart', hooks: 2, succeeded: 1, errors: 1, maxMs: 80 }]);
    expect(d.mcpConnections).toMatchObject([{ status: 'failed', transportType: 'http', count: 1 }]);
  });

  it('marks hooks not comparable when a session has telemetry but only non-tool events, and lists unattached sessions', async () => {
    await row('n1', { eventName: 'claude_code.api_request', model: 'm' });
    await row('n2', {
      sessionId: 'no-run-session',
      runId: null,
      toolUseId: 'x1',
      toolName: 'Read',
      success: true,
      receivedAt: new Date(Date.now() - 3_000_000),
    });
    const list = await listTelemetrySessions(handle);
    expect(list.localOnly).toBe(false);
    expect(list.overview).toMatchObject({ totalEvents: 2, sessions: 2, unattachedSessions: 1, unattachedEvents: 1 });
    const attached = list.sessions.find((s) => s.sessionId === SESSION);
    const unattached = list.sessions.find((s) => s.sessionId === 'no-run-session');
    expect(attached?.runId).toBe('run');
    expect(attached?.reconciliation).toMatchObject({ hookOnly: 3, matched: 0 });
    expect(unattached).toMatchObject({ runId: null, reconciliation: null });
    const detail = await getTelemetrySession('p', 'no-run-session', handle);
    expect(detail.run).toBeNull();
    expect(detail.reconciliation.operations[0]).toMatchObject({ status: 'telemetry_only', nativeToolUseId: 'x1' });
    expect(detail.reconciliation.limitations.join(' ')).toContain('No Run exists');
  });

  it('reports queue health and a missing session without inventing data', async () => {
    await row('n1', { eventName: 'claude_code.api_request', model: 'm' });
    raw()
      .prepare(
        "INSERT INTO pending_jobs (id, queue, payload, status, project_id) VALUES ('native_telemetry_dead', 'native_telemetry', '{}', 'dead', 'p')",
      )
      .run();
    raw()
      .prepare(
        "INSERT INTO pending_jobs (id, queue, payload, status, project_id) VALUES ('native_telemetry_wait', 'native_telemetry', '{}', 'pending', 'p')",
      )
      .run();
    const list = await listTelemetrySessions(handle);
    expect(list.queue).toMatchObject({ pending: 1, dead: 1 });
    const missing = await getTelemetrySession('p', 'nope', handle);
    expect(missing).toMatchObject({ found: false, eventsTotal: 0 });
  });

  it('returns an empty overview when nothing was received', async () => {
    const list = await listTelemetrySessions(handle);
    expect(list.overview).toMatchObject({ totalEvents: 0, lastReceivedAtMs: null, sessions: 0 });
    expect(list.sessions).toEqual([]);
  });

  describe('raw events explorer', () => {
    const base = Date.now() - 600_000;
    beforeEach(async () => {
      await row('e1', {
        receivedAt: new Date(base + 5001),
        sourceTimeMs: base + 1,
        toolUseId: 'toolu_a',
        toolName: 'Read',
        success: true,
        attributesJson: '{"x":1}',
      });
      await row('e2', { sourceTimeMs: base + 2, toolUseId: 'toolu_b', toolName: 'Bash', success: false });
      await row('e3', {
        sourceTimeMs: base + 3,
        eventName: 'claude_code.api_error',
        model: 'claude-x',
        statusCode: 429,
      });
      await row('e4', {
        sourceTimeMs: base + 4,
        eventName: 'claude_code.hook_execution_complete',
        hookEvent: 'SessionStart',
        hookCount: 1,
        hookErrorCount: 1,
      });
      await row('e5', {
        sourceTimeMs: base + 5,
        eventName: 'claude_code.mcp_server_connection',
        connectionStatus: 'connected',
        transportType: 'stdio',
        serverScope: 'user',
      });
      await row('e6', { sourceTimeMs: Date.now() - 20 * 86_400_000, sessionId: 'old', runId: null, toolName: 'Old' });
    });

    it('returns newest first with every stored column and the parsed attributes', async () => {
      const r = await listTelemetryEvents({}, handle);
      expect(r.matched).toBe(6);
      expect(r.events.map((e) => e.id).slice(0, 3)).toEqual(['e5', 'e4', 'e3']);
      const e1 = r.events.find((e) => e.id === 'e1');
      expect(e1).toMatchObject({
        eventName: 'claude_code.tool_result',
        projectSlug: 'proj',
        runId: 'run',
        columns: { tool_use_id: 'toolu_a', tool_name: 'Read', success: true },
        attributes: { x: 1 },
        contentPolicy: 'excluded',
      });
      expect(e1?.lagMs).toBeGreaterThan(0);
      expect(r.eventNames.map((n) => n.name)).toContain('claude_code.api_error');
    });

    it('filters by event, session, text, range and problems', async () => {
      expect((await listTelemetryEvents({ event: 'claude_code.api_error' }, handle)).events.map((e) => e.id)).toEqual([
        'e3',
      ]);
      expect((await listTelemetryEvents({ sessionId: 'old' }, handle)).events.map((e) => e.id)).toEqual(['e6']);
      expect((await listTelemetryEvents({ q: 'toolu_b' }, handle)).events.map((e) => e.id)).toEqual(['e2']);
      expect((await listTelemetryEvents({ q: 'claude-x' }, handle)).events.map((e) => e.id)).toEqual(['e3']);
      const recent = await listTelemetryEvents({ range: '24h' }, handle);
      expect(recent.events.map((e) => e.id)).not.toContain('e6');
      const problems = await listTelemetryEvents({ problemsOnly: true }, handle);
      expect(problems.events.map((e) => e.id).sort()).toEqual(['e2', 'e3', 'e4']);
    });

    it('searches literally, so LIKE wildcards in the box match nothing special', async () => {
      expect((await listTelemetryEvents({ q: '%' }, handle)).events).toHaveLength(0);
      expect((await listTelemetryEvents({ q: 'toolu_' }, handle)).events).toHaveLength(2);
    });

    it('bounds the page size and reports the full match count', async () => {
      const r = await listTelemetryEvents({ limit: 2 }, handle);
      expect(r.events).toHaveLength(2);
      expect(r.matched).toBe(6);
      expect((await listTelemetryEvents({ limit: 99_999 }, handle)).limit).toBe(500);
    });
  });
});
