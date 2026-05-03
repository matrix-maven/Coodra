import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, type DbHandle, ensureProject, insertKillSwitch, migrateSqlite } from '@coodra/contextos-db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type PauseIO, type PauseOptions, runPauseCommand } from '../../../src/commands/pause.js';
import { EXIT_KILL_SWITCH_REFUSAL, EXIT_OK, EXIT_USER_RECOVERABLE } from '../../../src/exit-codes.js';
import { resolveContextosDataDb } from '../../../src/lib/contextos-home.js';

/**
 * Module 08b S3 — `contextos pause` unit tests (6 fixtures).
 *
 * Tests open a real SQLite handle in a tmpdir so the validation +
 * insert path is exercised end-to-end without any mocks per
 * `01-development-discipline.md` §1.1.
 */

interface IoCapture {
  readonly io: PauseIO;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly exitCode: number | null;
}

function makeIo(homePath: string): IoCapture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | null = null;
  const io: PauseIO = {
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
  return new Proxy(
    { io, stdout, stderr, exitCode },
    {
      get(target, prop) {
        if (prop === 'exitCode') return exitCode;
        return target[prop as keyof typeof target];
      },
    },
  ) as IoCapture;
}

async function run(options: PauseOptions, io: PauseIO): Promise<number> {
  try {
    await runPauseCommand(options, io);
    return -1; // should not return without throwing
  } catch (err) {
    const m = (err as Error).message.match(/^__exit__:(\d+)$/);
    if (m) return Number(m[1]);
    throw err;
  }
}

let cwd: string;
let homePath: string;
let handle: DbHandle;
let projectId: string;

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), 'cli-pause-test-'));
  homePath = join(cwd, '.contextos');
  mkdirSync(homePath, { recursive: true });
  const opened = createDb({ kind: 'local', sqlite: { path: resolveContextosDataDb(homePath) } });
  if (opened.kind !== 'sqlite') throw new Error('expected sqlite');
  handle = opened;
  migrateSqlite(handle.db);
  const project = await ensureProject(handle, { slug: 'pause-test-project' });
  projectId = project.id;
  // Close so the command can re-open via the IO override.
  handle.close();
});

afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('runPauseCommand', () => {
  it('Fixture 1 — global hard pause with default reason inserts a row and prints success', async () => {
    const cap = makeIo(homePath);
    const code = await run({}, cap.io);
    expect(code).toBe(EXIT_OK);
    expect(cap.stdout.join('')).toMatch(/Paused global \(hard-mode/);
    expect(cap.stdout.join('')).toMatch(/id: ks_/);

    // Verify the row landed.
    const reopened = createDb({ kind: 'local', sqlite: { path: resolveContextosDataDb(homePath) } });
    if (reopened.kind !== 'sqlite') throw new Error('expected sqlite');
    const rows = reopened.raw.prepare('SELECT scope, target, mode FROM kill_switches').all() as Array<{
      scope: string;
      target: string | null;
      mode: string;
    }>;
    reopened.close();
    expect(rows).toEqual([{ scope: 'global', target: null, mode: 'hard' }]);
  });

  it('Fixture 2 — soft global pause emits JSON when --json is set', async () => {
    const cap = makeIo(homePath);
    const code = await run({ mode: 'soft', reason: 'observability', json: true }, cap.io);
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(cap.stdout.join('')) as { ok: boolean; status: string; mode: string };
    expect(payload).toMatchObject({ ok: true, status: 'paused', mode: 'soft' });
  });

  it('Fixture 3 — invalid scope exits 1 with helpful message', async () => {
    const cap = makeIo(homePath);
    const code = await run({ scope: 'org' }, cap.io);
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    expect(cap.stderr.join('')).toMatch(/--scope must be one of/);
  });

  it('Fixture 4 — scope=project requires --target slug; missing target → exit 1', async () => {
    const cap = makeIo(homePath);
    const code = await run({ scope: 'project' }, cap.io);
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    expect(cap.stderr.join('')).toMatch(/--scope=project requires --target/);
  });

  it('Fixture 5 — scope=project with unknown slug → exit 1 with remediation', async () => {
    const cap = makeIo(homePath);
    const code = await run({ scope: 'project', target: 'no-such-slug' }, cap.io);
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    expect(cap.stderr.join('')).toMatch(/project slug "no-such-slug" does not exist/);
  });

  it('Fixture 6 — duplicate active switch at same (scope, target) → exit 5 with existing id', async () => {
    // Pre-seed an active global switch directly.
    const reopened = createDb({ kind: 'local', sqlite: { path: resolveContextosDataDb(homePath) } });
    if (reopened.kind !== 'sqlite') throw new Error('expected sqlite');
    const existing = await insertKillSwitch(reopened, { scope: 'global', target: null, reason: 'pre-existing' });
    reopened.close();

    const cap = makeIo(homePath);
    const code = await run({ reason: 'second pause' }, cap.io);
    expect(code).toBe(EXIT_KILL_SWITCH_REFUSAL);
    expect(cap.stderr.join('')).toMatch(/Already paused/);
    expect(cap.stderr.join('')).toContain(existing.id);
  });

  it('Fixture 7 (bonus) — scope=project + valid slug resolves to projectId and inserts', async () => {
    const cap = makeIo(homePath);
    const code = await run({ scope: 'project', target: 'pause-test-project', json: true }, cap.io);
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(cap.stdout.join('')) as { ok: boolean; scope: string; target: string };
    expect(payload.scope).toBe('project');
    expect(payload.target).toBe(projectId);
  });

  it('Fixture 8 (bonus) — --expires-in parsed and expires_at set ~now+duration', async () => {
    const cap = makeIo(homePath);
    const before = Date.now();
    const code = await run({ expiresIn: '1h', json: true }, cap.io);
    const after = Date.now();
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(cap.stdout.join('')) as { ok: boolean; expiresAt: string };
    expect(payload.expiresAt).not.toBeNull();
    const expiresMs = new Date(payload.expiresAt).getTime();
    // SQLite stores integer({mode:'timestamp'}) as Unix SECONDS, so the
    // round-trip can lose up to 999ms. Widen the tolerance window
    // accordingly: expect expiresMs in [before + 1h - 1000ms, after + 1h + 1000ms].
    expect(expiresMs).toBeGreaterThanOrEqual(before + 60 * 60 * 1000 - 1_000);
    expect(expiresMs).toBeLessThanOrEqual(after + 60 * 60 * 1000 + 1_000);
  });
});
