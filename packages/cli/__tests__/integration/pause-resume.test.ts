import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, migrateSqlite } from '@coodra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type PauseIO, runPauseCommand } from '../../src/commands/pause.js';
import { type ResumeIO, runResumeCommand } from '../../src/commands/resume.js';
import { resolveCoodraDataDb } from '../../src/lib/coodra-home.js';

/**
 * Module 08b S3 — pause + resume integration roundtrip against a tmpdir SQLite store.
 *
 * This is the full happy-path verification: pause writes a row,
 * resume by id flips resumed_at + resumed_by_session_id, a second
 * pause (now that nothing is active at the same scope) succeeds,
 * resume --all flips both active rows.
 */

interface Capture {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
}

function pauseIo(home: string, cap: Capture): PauseIO {
  return {
    writeStdout: (c) => cap.stdout.push(c),
    writeStderr: (c) => cap.stderr.push(c),
    exit: (code) => {
      cap.exitCode = code;
      throw new Error(`__exit__:${code}`);
    },
    coodraHome: home,
  };
}

function resumeIo(home: string, cap: Capture): ResumeIO {
  return {
    writeStdout: (c) => cap.stdout.push(c),
    writeStderr: (c) => cap.stderr.push(c),
    exit: (code) => {
      cap.exitCode = code;
      throw new Error(`__exit__:${code}`);
    },
    coodraHome: home,
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

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'cli-pause-resume-int-'));
  homePath = join(cwd, '.coodra');
  mkdirSync(homePath, { recursive: true });
  const opened = createDb({ kind: 'local', sqlite: { path: resolveCoodraDataDb(homePath) } });
  if (opened.kind !== 'sqlite') throw new Error('expected sqlite');
  migrateSqlite(opened.db);
  opened.close();
});

afterAll(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('pause + resume roundtrip', () => {
  it('pause global → resume by id → pause again → resume --all', async () => {
    // Step 1: pause global (hard mode is the default).
    const cap1: Capture = { stdout: [], stderr: [], exitCode: null };
    const code1 = await expectExit(() => runPauseCommand({ json: true, reason: 'first' }, pauseIo(homePath, cap1)));
    expect(code1).toBe(0);
    const payload1 = JSON.parse(cap1.stdout.join('')) as { ok: boolean; id: string; scope: string };
    expect(payload1.scope).toBe('global');
    const firstId = payload1.id;

    // Step 2: resume by id.
    const cap2: Capture = { stdout: [], stderr: [], exitCode: null };
    const code2 = await expectExit(() => runResumeCommand({ id: firstId, json: true }, resumeIo(homePath, cap2)));
    expect(code2).toBe(0);
    const payload2 = JSON.parse(cap2.stdout.join('')) as { ok: boolean; resumed: { id: string }[] };
    expect(payload2.resumed).toHaveLength(1);
    expect(payload2.resumed[0]?.id).toBe(firstId);

    // Step 3: pause again — fresh row because the prior row is resumed.
    const cap3: Capture = { stdout: [], stderr: [], exitCode: null };
    const code3 = await expectExit(() => runPauseCommand({ json: true, reason: 'second' }, pauseIo(homePath, cap3)));
    expect(code3).toBe(0);
    const payload3 = JSON.parse(cap3.stdout.join('')) as { ok: boolean; id: string };
    expect(payload3.id).not.toBe(firstId);

    // Step 4: pause a second concurrent switch on a different scope.
    const cap4: Capture = { stdout: [], stderr: [], exitCode: null };
    const code4 = await expectExit(() =>
      runPauseCommand({ scope: 'tool', target: 'Bash', json: true, reason: 'no shell' }, pauseIo(homePath, cap4)),
    );
    expect(code4).toBe(0);

    // Step 5: --all resumes both active switches.
    const cap5: Capture = { stdout: [], stderr: [], exitCode: null };
    const code5 = await expectExit(() => runResumeCommand({ all: true, json: true }, resumeIo(homePath, cap5)));
    expect(code5).toBe(0);
    const payload5 = JSON.parse(cap5.stdout.join('')) as { ok: boolean; resumed: { id: string; scope: string }[] };
    expect(payload5.resumed).toHaveLength(2);
    expect(payload5.resumed.map((r) => r.scope).sort()).toEqual(['global', 'tool']);

    // Step 6: --all on no active switches exits 1.
    const cap6: Capture = { stdout: [], stderr: [], exitCode: null };
    const code6 = await expectExit(() => runResumeCommand({ all: true, json: true }, resumeIo(homePath, cap6)));
    expect(code6).toBe(1);

    // Step 7: total of 3 rows, all resumed.
    const reopened = createDb({ kind: 'local', sqlite: { path: resolveCoodraDataDb(homePath) } });
    if (reopened.kind !== 'sqlite') throw new Error('expected sqlite');
    const all = reopened.raw.prepare('SELECT id, resumed_at FROM kill_switches').all() as Array<{
      id: string;
      resumed_at: number | null;
    }>;
    reopened.close();
    expect(all).toHaveLength(3);
    expect(all.every((r) => r.resumed_at !== null)).toBe(true);
  });
});
