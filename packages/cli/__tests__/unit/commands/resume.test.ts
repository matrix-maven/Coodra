import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, type DbHandle, insertKillSwitch, migrateSqlite } from '@coodra/contextos-db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type ResumeIO, type ResumeOptions, runResumeCommand } from '../../../src/commands/resume.js';
import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../../../src/exit-codes.js';
import { resolveContextosDataDb } from '../../../src/lib/contextos-home.js';

/**
 * Module 08b S3 — `contextos resume` unit tests (4 fixtures).
 */

interface IoCapture {
  readonly io: ResumeIO;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly getExitCode: () => number | null;
}

function makeIo(homePath: string): IoCapture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | null = null;
  const io: ResumeIO = {
    writeStdout: (chunk) => {
      stdout.push(chunk);
    },
    writeStderr: (chunk) => {
      stderr.push(chunk);
    },
    exit: (code) => {
      exitCode = code;
      throw new Error(`__exit__:${code}`);
    },
    contextosHome: homePath,
  };
  return { io, stdout, stderr, getExitCode: () => exitCode };
}

async function run(options: ResumeOptions, io: ResumeIO): Promise<number> {
  try {
    await runResumeCommand(options, io);
    return -1;
  } catch (err) {
    const m = (err as Error).message.match(/^__exit__:(\d+)$/);
    if (m) return Number(m[1]);
    throw err;
  }
}

let cwd: string;
let homePath: string;
let handle: DbHandle;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'cli-resume-test-'));
  homePath = join(cwd, '.contextos');
  mkdirSync(homePath, { recursive: true });
  const opened = createDb({ kind: 'local', sqlite: { path: resolveContextosDataDb(homePath) } });
  if (opened.kind !== 'sqlite') throw new Error('expected sqlite');
  handle = opened;
  migrateSqlite(handle.db);
});

afterEach(() => {
  if (handle?.kind === 'sqlite') {
    try {
      handle.close();
    } catch {
      // already closed by the command
    }
  }
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('runResumeCommand', () => {
  it('Fixture 1 — no flags exits 1 with usage message', async () => {
    const cap = makeIo(homePath);
    const code = await run({}, cap.io);
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    expect(cap.stderr.join('')).toMatch(/requires one of --id/);
    expect(cap.stderr.join('')).toContain('--all');
    expect(cap.stderr.join('')).toContain('--scope');
  });

  it('Fixture 2 — --id with unknown id exits 1', async () => {
    const cap = makeIo(homePath);
    const code = await run({ id: 'ks_does_not_exist' }, cap.io);
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    expect(cap.stderr.join('')).toMatch(/no active kill switch with id "ks_does_not_exist"/);
  });

  it('Fixture 3 — --all with active switches resumes all and emits JSON when requested', async () => {
    await insertKillSwitch(handle, { scope: 'global', target: null, reason: 'r1' });
    await insertKillSwitch(handle, { scope: 'tool', target: 'Bash', reason: 'r2' });
    handle.close();

    const cap = makeIo(homePath);
    const code = await run({ all: true, json: true }, cap.io);
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(cap.stdout.join('')) as { ok: boolean; resumed: { id: string; scope: string }[] };
    expect(payload.ok).toBe(true);
    expect(payload.resumed).toHaveLength(2);
    expect(payload.resumed.map((r) => r.scope).sort()).toEqual(['global', 'tool']);
  });

  it('Fixture 4 — mutually-exclusive: passing both --id AND --all exits 1', async () => {
    const cap = makeIo(homePath);
    const code = await run({ id: 'ks_x', all: true }, cap.io);
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    expect(cap.stderr.join('')).toMatch(/mutually exclusive/);
  });

  it('Fixture 5 (bonus) — --scope tool resumes only tool-scoped active switches', async () => {
    await insertKillSwitch(handle, { scope: 'global', target: null, reason: 'gr' });
    const t1 = await insertKillSwitch(handle, { scope: 'tool', target: 'Bash', reason: 'tr' });
    const t2 = await insertKillSwitch(handle, { scope: 'tool', target: 'Edit', reason: 'tr2' });
    handle.close();

    const cap = makeIo(homePath);
    const code = await run({ scope: 'tool', json: true }, cap.io);
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(cap.stdout.join('')) as { resumed: { id: string }[] };
    expect(payload.resumed.map((r) => r.id).sort()).toEqual([t1.id, t2.id].sort());

    // Re-open and confirm global stayed active.
    const reopened = createDb({ kind: 'local', sqlite: { path: resolveContextosDataDb(homePath) } });
    if (reopened.kind !== 'sqlite') throw new Error('expected sqlite');
    const stillActive = reopened.raw
      .prepare('SELECT scope FROM kill_switches WHERE resumed_at IS NULL')
      .all() as Array<{ scope: string }>;
    reopened.close();
    expect(stillActive.map((r) => r.scope)).toEqual(['global']);
  });
});
