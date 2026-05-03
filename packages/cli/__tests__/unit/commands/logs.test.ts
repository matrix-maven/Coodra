import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type LogsIO, runLogsCommand } from '../../../src/commands/logs.js';
import { EXIT_OK, EXIT_USER_ACTION_REQUIRED, EXIT_USER_RECOVERABLE } from '../../../src/exit-codes.js';

interface Capture {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
}

function makeIo(homePath: string, cap: Capture): LogsIO {
  return {
    writeStdout: (c) => cap.stdout.push(c),
    writeStderr: (c) => cap.stderr.push(c),
    exit: (code) => {
      cap.exitCode = code;
      throw new Error(`__exit__:${code}`);
    },
    contextosHome: homePath,
  };
}

async function expectExit(p: () => Promise<unknown>): Promise<number> {
  try {
    await p();
    throw new Error('did not exit');
  } catch (err) {
    const m = (err as Error).message.match(/^__exit__:(\d+)$/);
    if (!m) throw err;
    return Number(m[1]);
  }
}

let cwd: string;
let homePath: string;
let logsDir: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'cli-logs-test-'));
  homePath = join(cwd, '.contextos');
  logsDir = join(homePath, 'logs');
  mkdirSync(logsDir, { recursive: true });
});

afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('runLogsCommand', () => {
  it('Fixture 1 — unknown service → exit 1 with valid-services list', async () => {
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() => runLogsCommand('not-a-service', {}, makeIo(homePath, cap)));
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    expect(cap.stderr.join('')).toMatch(/unknown service "not-a-service"/);
    expect(cap.stderr.join('')).toMatch(/mcp-server.*hooks-bridge.*sync-daemon/);
  });

  it('Fixture 2 — known service but missing log file → exit 2 with `contextos start` remediation', async () => {
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() => runLogsCommand('hooks-bridge', {}, makeIo(homePath, cap)));
    expect(code).toBe(EXIT_USER_ACTION_REQUIRED);
    expect(cap.stderr.join('')).toMatch(/log file .* does not exist/);
    expect(cap.stderr.join('')).toMatch(/contextos start/);
  });

  it('Fixture 3 — default last-100 read prints every line for a small file', async () => {
    writeFileSync(join(logsDir, 'mcp-server.log'), 'line A\nline B\nline C\n');
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() => runLogsCommand('mcp-server', {}, makeIo(homePath, cap)));
    expect(code).toBe(EXIT_OK);
    expect(cap.stdout.join('')).toBe('line A\nline B\nline C\n');
  });

  it('Fixture 4 — --lines N returns the last N lines from a 100-line file', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `entry-${i + 1}`);
    writeFileSync(join(logsDir, 'sync-daemon.log'), `${lines.join('\n')}\n`);
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() => runLogsCommand('sync-daemon', { lines: '10' }, makeIo(homePath, cap)));
    expect(code).toBe(EXIT_OK);
    const printed = cap.stdout.join('').trim().split('\n');
    expect(printed).toHaveLength(10);
    expect(printed[0]).toBe('entry-91');
    expect(printed[9]).toBe('entry-100');
  });

  it('Fixture 5 — --since duration filters by JSON time field', async () => {
    // Place the "old" line clearly outside any reasonable --since window
    // and the "new" line clearly inside, with a ~10-minute spread on
    // either side of the 30-minute window to avoid ms-level flakiness
    // between test setup and command execution.
    const olderTs = new Date(Date.now() - 60 * 60_000).toISOString(); // 60 min ago
    const newerTs = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 min ago
    const content = `${JSON.stringify({ time: olderTs, msg: 'old' })}
${JSON.stringify({ time: newerTs, msg: 'new' })}
`;
    writeFileSync(join(logsDir, 'hooks-bridge.log'), content);
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() => runLogsCommand('hooks-bridge', { since: '30m' }, makeIo(homePath, cap)));
    expect(code).toBe(EXIT_OK);
    const out = cap.stdout.join('');
    expect(out).toContain('"msg":"new"');
    expect(out).not.toContain('"msg":"old"');
  });

  it('Fixture 6 (bonus) — --lines invalid value → exit 1', async () => {
    writeFileSync(join(logsDir, 'mcp-server.log'), 'foo\n');
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() => runLogsCommand('mcp-server', { lines: 'abc' }, makeIo(homePath, cap)));
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    expect(cap.stderr.join('')).toMatch(/--lines must be an integer/);
  });

  it('Fixture 7 (bonus) — --since malformed → exit 1 with parser hint', async () => {
    writeFileSync(join(logsDir, 'mcp-server.log'), 'foo\n');
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() => runLogsCommand('mcp-server', { since: 'abracadabra' }, makeIo(homePath, cap)));
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    expect(cap.stderr.join('')).toMatch(/--since "abracadabra"/);
  });
});
