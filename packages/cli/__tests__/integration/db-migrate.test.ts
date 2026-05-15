import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type DbMigrateIO, runDbMigrateCommand } from '../../src/commands/db-migrate.js';
import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../../src/exit-codes.js';

/**
 * Module 08b S5 — `coodra db migrate` integration tests (4 fixtures).
 *
 * Tests use the real bundled migrations folder (resolved by the same
 * runtime-paths helper init.ts uses) so any drift between migrate's
 * idea of "head" and what init produces is caught here.
 */

const REPO_DRIZZLE_SQLITE = join(__dirname, '..', '..', '..', 'db', 'drizzle', 'sqlite');

interface Capture {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
}

function makeIo(homePath: string, cap: Capture, migrationsDir = REPO_DRIZZLE_SQLITE): DbMigrateIO {
  return {
    writeStdout: (c) => cap.stdout.push(c),
    writeStderr: (c) => cap.stderr.push(c),
    exit: (code) => {
      cap.exitCode = code;
      throw new Error(`__exit__:${code}`);
    },
    coodraHome: homePath,
    migrationsDir,
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
let pidsDir: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'cli-db-migrate-int-'));
  homePath = join(cwd, '.coodra');
  pidsDir = join(homePath, 'pids');
  mkdirSync(homePath, { recursive: true });
  mkdirSync(pidsDir, { recursive: true });
});

afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('coodra db migrate integration', () => {
  it('Fixture 1 — clean DB applies all migrations and reports the count', async () => {
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() => runDbMigrateCommand({ json: true }, makeIo(homePath, cap)));
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(cap.stdout.join('')) as { ok: boolean; applied: number; totalAfter: number };
    expect(payload.ok).toBe(true);
    expect(payload.applied).toBeGreaterThan(0);
    expect(payload.totalAfter).toBe(payload.applied);
  });

  it('Fixture 2 — re-running on an already-migrated DB is a no-op (applied=0)', async () => {
    const cap1: Capture = { stdout: [], stderr: [], exitCode: null };
    await expectExit(() => runDbMigrateCommand({ json: true }, makeIo(homePath, cap1)));
    const firstPayload = JSON.parse(cap1.stdout.join('')) as { applied: number; totalAfter: number };
    expect(firstPayload.applied).toBeGreaterThan(0);

    const cap2: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() => runDbMigrateCommand({ json: true }, makeIo(homePath, cap2)));
    expect(code).toBe(EXIT_OK);
    const second = JSON.parse(cap2.stdout.join('')) as { applied: number; totalAfter: number };
    expect(second.applied).toBe(0);
    expect(second.totalAfter).toBe(firstPayload.totalAfter);
  });

  it('Fixture 3 — alive daemon PID file → exit 1 with remediation', async () => {
    // Write a fake PID file referencing this very process — `kill(pid, 0)`
    // returns alive for our own pid, so the check correctly reports alive.
    writeFileSync(join(pidsDir, 'hooks-bridge.pid'), String(process.pid));

    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() => runDbMigrateCommand({ json: true }, makeIo(homePath, cap)));
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    const payload = JSON.parse(cap.stdout.join('')) as {
      ok: boolean;
      daemonsRunning?: { unit: string; pid: number }[];
    };
    expect(payload.ok).toBe(false);
    expect(payload.daemonsRunning?.[0]?.unit).toBe('hooks-bridge');
  });

  it('Fixture 4 — --dry-run does not apply migrations and reports pendingBefore', async () => {
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() => runDbMigrateCommand({ json: true, dryRun: true }, makeIo(homePath, cap)));
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(cap.stdout.join('')) as {
      ok: boolean;
      applied: number;
      pendingBefore: number;
      dryRun: boolean;
    };
    expect(payload.dryRun).toBe(true);
    expect(payload.applied).toBe(0);
    expect(payload.pendingBefore).toBeGreaterThan(0); // clean DB has all migrations pending
  });

  it('Fixture 5 (bonus) — --with-daemons-running bypasses the alive check', async () => {
    writeFileSync(join(pidsDir, 'mcp-server.pid'), String(process.pid));

    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runDbMigrateCommand({ json: true, withDaemonsRunning: true }, makeIo(homePath, cap)),
    );
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(cap.stdout.join('')) as { ok: boolean; applied: number };
    expect(payload.ok).toBe(true);
    expect(payload.applied).toBeGreaterThan(0);
  });
});
