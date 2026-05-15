import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type LogsIO, runLogsCommand } from '../../src/commands/logs.js';
import { EXIT_OK } from '../../src/exit-codes.js';

/**
 * Module 08b S4 — logs integration roundtrip.
 *
 * Generates a 100-line log file under a tmpdir coodra-home and
 * verifies that --lines 10 returns exactly the last 10 lines.
 */

let cwd: string;
let homePath: string;
let logsDir: string;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'cli-logs-int-'));
  homePath = join(cwd, '.coodra');
  logsDir = join(homePath, 'logs');
  mkdirSync(logsDir, { recursive: true });
  const lines = Array.from({ length: 100 }, (_, i) =>
    JSON.stringify({
      level: 'info',
      time: new Date(Date.now() - (100 - i) * 1000).toISOString(),
      n: i + 1,
      msg: `entry-${i + 1}`,
    }),
  );
  writeFileSync(join(logsDir, 'mcp-server.log'), `${lines.join('\n')}\n`);
});

afterAll(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('coodra logs <service> integration', () => {
  it('--lines 10 prints exactly the last 10 lines of a 100-line file', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let exitCode: number | null = null;
    const io: LogsIO = {
      writeStdout: (c) => stdout.push(c),
      writeStderr: (c) => stderr.push(c),
      exit: (code) => {
        exitCode = code;
        throw new Error(`__exit__:${code}`);
      },
      coodraHome: homePath,
    };

    try {
      await runLogsCommand('mcp-server', { lines: '10' }, io);
    } catch (err) {
      // intentional exit
      if (!(err as Error).message.startsWith('__exit__:')) throw err;
    }

    expect(exitCode).toBe(EXIT_OK);
    const printed = stdout.join('').trim().split('\n');
    expect(printed).toHaveLength(10);
    const last = printed[9] ?? '';
    expect(JSON.parse(last)).toMatchObject({ msg: 'entry-100' });
    const first = printed[0] ?? '';
    expect(JSON.parse(first)).toMatchObject({ msg: 'entry-91' });
  });
});
