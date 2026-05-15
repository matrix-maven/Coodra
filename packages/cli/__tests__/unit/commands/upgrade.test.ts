import { describe, expect, it, vi } from 'vitest';

import { runUpgradeCommand, type UpgradeIO } from '../../../src/commands/upgrade.js';
import { EXIT_OK, EXIT_USER_ACTION_REQUIRED, EXIT_USER_RECOVERABLE } from '../../../src/exit-codes.js';
import { VERSION } from '../../../src/version.js';

interface Capture {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
}

function makeIo(cap: Capture, overrides: Partial<UpgradeIO> = {}): UpgradeIO {
  return {
    writeStdout: (c) => cap.stdout.push(c),
    writeStderr: (c) => cap.stderr.push(c),
    exit: (code) => {
      cap.exitCode = code;
      throw new Error(`__exit__:${code}`);
    },
    ...overrides,
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

describe('runUpgradeCommand', () => {
  it('Fixture 1 — newer published version → exit 2 + install command', async () => {
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUpgradeCommand(
        { json: true },
        makeIo(cap, {
          fetchPublishedVersion: async () => '99.0.0',
        }),
      ),
    );
    expect(code).toBe(EXIT_USER_ACTION_REQUIRED);
    const payload = JSON.parse(cap.stdout.join('')) as {
      ok: boolean;
      status: string;
      installCommand: string;
    };
    expect(payload.status).toBe('newer_available');
    expect(payload.installCommand).toBe('npm i -g @coodra/cli@99.0.0');
  });

  it('Fixture 2 — installed === published → exit 0 + migrate + restart called', async () => {
    let migrateCalled = false;
    let restartCalled = false;
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUpgradeCommand(
        { json: true },
        makeIo(cap, {
          fetchPublishedVersion: async () => VERSION,
          runMigrate: async () => {
            migrateCalled = true;
          },
          restartDaemons: async () => {
            restartCalled = true;
          },
        }),
      ),
    );
    expect(code).toBe(EXIT_OK);
    expect(migrateCalled).toBe(true);
    expect(restartCalled).toBe(true);
    const payload = JSON.parse(cap.stdout.join('')) as { status: string; migrated: boolean; restarted: boolean };
    expect(payload.status).toBe('up_to_date');
    expect(payload.migrated).toBe(true);
    expect(payload.restarted).toBe(true);
  });

  it('Fixture 3 — npm view throws → exit 1 with structured error', async () => {
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUpgradeCommand(
        { json: true },
        makeIo(cap, {
          fetchPublishedVersion: async () => {
            throw new Error('ENOTFOUND registry.npmjs.org');
          },
        }),
      ),
    );
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    const payload = JSON.parse(cap.stdout.join('')) as { ok: boolean; status: string; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.status).toBe('check_failed');
    expect(payload.error).toMatch(/ENOTFOUND/);
  });

  it('Fixture 4 — --check-only does NOT call migrate or restart', async () => {
    let migrateCalled = false;
    let restartCalled = false;
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUpgradeCommand(
        { json: true, checkOnly: true },
        makeIo(cap, {
          fetchPublishedVersion: async () => VERSION,
          runMigrate: async () => {
            migrateCalled = true;
          },
          restartDaemons: async () => {
            restartCalled = true;
          },
        }),
      ),
    );
    expect(code).toBe(EXIT_OK);
    expect(migrateCalled).toBe(false);
    expect(restartCalled).toBe(false);
    const payload = JSON.parse(cap.stdout.join('')) as { migrated: boolean; restarted: boolean };
    expect(payload.migrated).toBe(false);
    expect(payload.restarted).toBe(false);
  });

  it('Fixture 5 — --no-restart calls migrate but not restart', async () => {
    let migrateCalled = false;
    let restartCalled = false;
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUpgradeCommand(
        { json: true, noRestart: true },
        makeIo(cap, {
          fetchPublishedVersion: async () => VERSION,
          runMigrate: async () => {
            migrateCalled = true;
          },
          restartDaemons: async () => {
            restartCalled = true;
          },
        }),
      ),
    );
    expect(code).toBe(EXIT_OK);
    expect(migrateCalled).toBe(true);
    expect(restartCalled).toBe(false);
  });

  it('Fixture 6 (bonus) — published is older than installed (downgrade scenario) → still up_to_date', async () => {
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUpgradeCommand(
        { json: true, checkOnly: true },
        makeIo(cap, {
          fetchPublishedVersion: async () => '0.0.1',
        }),
      ),
    );
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(cap.stdout.join('')) as { status: string };
    expect(payload.status).toBe('up_to_date');
  });
});

void vi;
