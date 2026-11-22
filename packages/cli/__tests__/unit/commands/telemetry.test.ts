import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runTelemetryCommand, type TelemetryIO } from '../../../src/commands/telemetry.js';
import {
  claudeCodeEnvSnippet,
  codexConfigSnippet,
  editDotenvText,
  probeReceiver,
} from '../../../src/lib/telemetry-env.js';

describe('editDotenvText', () => {
  it('adds, replaces and removes a key without touching other lines', () => {
    const base = '# secrets\nLOCAL_HOOK_SECRET=abc\nMCP_SERVER_PORT=3100\n';
    const added = editDotenvText(base, 'COODRA_TELEMETRY_ENABLED', '1');
    expect(added).toBe('# secrets\nLOCAL_HOOK_SECRET=abc\nMCP_SERVER_PORT=3100\nCOODRA_TELEMETRY_ENABLED=1\n');
    expect(editDotenvText(added, 'COODRA_TELEMETRY_ENABLED', '1')).toBe(added);
    expect(editDotenvText(added, 'COODRA_TELEMETRY_ENABLED', null)).toBe(base);
  });

  it('collapses duplicates and handles an empty file', () => {
    expect(editDotenvText('A=1\nK=0\nK=2\n', 'K', '1')).toBe('A=1\nK=1\n');
    expect(editDotenvText('', 'K', '1')).toBe('K=1\n');
    expect(editDotenvText('export K=9\n', 'K', null)).toBe('');
  });
});

describe('probeReceiver', () => {
  const reply = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 404 })) as typeof fetch;
  it('tells a mounted receiver from an unmounted one and from an unreachable daemon', async () => {
    expect(await probeReceiver(1, reply({ error: 'project_not_found' }))).toBe('enabled');
    expect(await probeReceiver(1, reply({ error: 'not_found', path: '/x' }))).toBe('disabled');
    expect(await probeReceiver(1, (async () => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch)).toBe(
      'unreachable',
    );
  });
});

describe('coodra telemetry', () => {
  let home: string;
  let out: string[];
  let err: string[];
  let code: number | null;
  const io = (over: Partial<TelemetryIO> = {}): TelemetryIO => ({
    writeStdout: (c) => out.push(c),
    writeStderr: (c) => err.push(c),
    exit: (c) => {
      code = c;
      throw new Error(`__exit__:${c}`);
    },
    coodraHome: home,
    cwd: home,
    env: {},
    probe: async () => 'disabled',
    ...over,
  });
  const run = async (action: string, opts = {}, over: Partial<TelemetryIO> = {}) => {
    try {
      await runTelemetryCommand(action, opts, io(over));
    } catch (e) {
      if (!(e as Error).message.startsWith('__exit__')) throw e;
    }
  };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'coodra-telemetry-'));
    out = [];
    err = [];
    code = null;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('enable persists the flag privately and tells the user to restart; disable removes it', async () => {
    await run('enable');
    expect(code).toBe(0);
    expect(readFileSync(join(home, '.env'), 'utf8')).toBe('COODRA_TELEMETRY_ENABLED=1\n');
    expect(statSync(join(home, '.env')).mode & 0o777).toBe(0o600);
    expect(out.join('')).toContain('coodra stop && coodra start');
    await run('disable');
    expect(readFileSync(join(home, '.env'), 'utf8')).toBe('');
  });

  it('enable keeps an existing .env intact', async () => {
    writeFileSync(join(home, '.env'), 'LOCAL_HOOK_SECRET=keep-me\n');
    await run('enable');
    expect(readFileSync(join(home, '.env'), 'utf8')).toBe('LOCAL_HOOK_SECRET=keep-me\nCOODRA_TELEMETRY_ENABLED=1\n');
  });

  it('status separates persisted config from what the running daemon mounts', async () => {
    await run('status');
    expect(out.join('')).toContain('disabled');
    out = [];
    await run('enable');
    out = [];
    await run('status', {}, { probe: async () => 'disabled' });
    expect(out.join('')).toContain('needs a restart');
    out = [];
    await run('status', {}, { probe: async () => 'enabled' });
    expect(out.join('')).toContain('enabled and running');
    out = [];
    await run('status', { json: true }, { probe: async () => 'unreachable' });
    expect(JSON.parse(out.join(''))).toMatchObject({ persisted: true, receiver: 'unreachable', port: 3100 });
  });

  it('env prints the exports with the daemon port and project, and needs a slug', async () => {
    await run('env', { project: 'demo' }, { env: { MCP_SERVER_PORT: '3105' } });
    expect(out.join('')).toContain(
      'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:3105/telemetry/claude_code/demo/v1/logs',
    );
    expect(out.join('')).toContain('OTEL_LOG_USER_PROMPTS=0');
    out = [];
    err = [];
    await run('env');
    expect(code).toBe(1);
    expect(err.join('')).toContain('--project');
  });

  it('rejects an unknown action', async () => {
    await run('bogus');
    expect(code).toBe(1);
    expect(err.join('')).toContain('unknown telemetry action');
  });

  it('snippet never enables content logging', () => {
    const s = claudeCodeEnvSnippet({ port: 3100, projectSlug: 'x' });
    for (const k of ['USER_PROMPTS', 'TOOL_DETAILS', 'TOOL_CONTENT', 'RAW_API_BODIES', 'ASSISTANT_RESPONSES']) {
      expect(s).toContain(`OTEL_LOG_${k}=0`);
    }
  });

  it('prints a Codex config fragment, alone or alongside the Claude exports', async () => {
    await run('env', { project: 'demo', harness: 'codex' });
    expect(out.join('')).toContain('[otel]');
    expect(out.join('')).toContain('endpoint = "http://127.0.0.1:3100/telemetry/codex/demo/v1/logs"');
    expect(out.join('')).not.toContain('CLAUDE_CODE_ENABLE_TELEMETRY');
    out = [];
    await run('env', { project: 'demo' });
    expect(out.join('')).toContain('CLAUDE_CODE_ENABLE_TELEMETRY=1');
    expect(out.join('')).toContain('log_user_prompt = false');
    err = [];
    await run('env', { project: 'demo', harness: 'gemini' });
    expect(code).toBe(1);
    expect(err.join('')).toContain('unknown --harness');
    expect(codexConfigSnippet({ port: 1, projectSlug: 'x' })).toContain('protocol = "json"');
  });
});
