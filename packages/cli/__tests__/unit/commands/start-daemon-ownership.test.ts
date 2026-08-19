import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `coodra start` must not report success because SOMETHING answered the
 * port.
 *
 * Field failure this locks down: an orphaned daemon from 2026-08-08
 * held :3100 for eleven days. Every `coodra start` bootstrapped a unit
 * that died of `EADDRINUSE` — 105832 times, all of it only in the log —
 * while `waitForHealth` saw the orphan's 200 and printed
 * "✓ listening on :3100". The rollup worker, which only runs on the
 * HTTP transport, therefore never ran once, and the user reasonably
 * believed the daemon was up the whole time.
 */

const started: string[] = [];

vi.mock('../../../src/lib/services.js', () => ({
  resolveServices: vi.fn(async () => [
    {
      descriptor: {
        kind: 'http' as const,
        name: 'mcp-server',
        displayName: 'Coodra MCP Server',
        port: 3100,
        defaultPort: 3100,
        relativeEntry: 'apps/mcp-server/dist/index.js',
        healthUrl: (p: number) => `http://127.0.0.1:${p}/healthz`,
      },
      entryPath: '/fake/mcp-server.js',
      port: 3100,
      unit: { name: 'mcp-server', command: 'node', args: ['/fake/mcp-server.js'], env: {} },
    },
  ]),
}));

vi.mock('../../../src/lib/daemon/index.js', () => ({
  selectDaemonManager: vi.fn(async () => ({
    kind: 'launchd' as const,
    isAvailable: vi.fn(async () => true),
    install: vi.fn(async () => {}),
    // launchd `bootstrap` succeeds even when the process it launched
    // immediately dies of EADDRINUSE — which is precisely why start
    // cannot take the supervisor's word for it.
    start: vi.fn(async (name: string) => {
      started.push(name);
    }),
    stop: vi.fn(async () => {}),
    status: vi.fn(async (name: string) => ({ name, state: 'stopped' as const })),
    list: vi.fn(async () => []),
    uninstall: vi.fn(async () => {}),
  })),
}));

vi.mock('../../../src/lib/wait-for-health.js', () => ({
  waitForHealth: vi.fn(async () => true),
}));

const probePortOccupant = vi.fn();
const waitForOwnDaemon = vi.fn();
vi.mock('../../../src/lib/daemon-identity.js', () => ({
  probePortOccupant: (...args: unknown[]) => probePortOccupant(...args),
  waitForOwnDaemon: (...args: unknown[]) => waitForOwnDaemon(...args),
}));

import { runStartCommand, type StartIO } from '../../../src/commands/start.js';
import { EXIT_OK, EXIT_SERVICE_STARTUP_FAILED } from '../../../src/exit-codes.js';

class ExitSentinel extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
    this.name = 'ExitSentinel';
  }
}

function makeIO(): { io: StartIO; out: () => string; err: () => string } {
  const outBuf: string[] = [];
  const errBuf: string[] = [];
  return {
    io: {
      writeStdout: (c) => {
        outBuf.push(c);
      },
      writeStderr: (c) => {
        errBuf.push(c);
      },
      exit: (code) => {
        throw new ExitSentinel(code);
      },
    },
    out: () => outBuf.join(''),
    err: () => errBuf.join(''),
  };
}

async function runAndCaptureExit(home: string, io: StartIO): Promise<number> {
  try {
    await runStartCommand({ platform: 'darwin', home, env: {}, web: false, sync: false }, io);
    throw new Error('runStartCommand returned without exiting');
  } catch (e) {
    if (e instanceof ExitSentinel) return e.code;
    throw e;
  }
}

const ORPHAN = {
  kind: 'coodra' as const,
  service: 'mcp-server',
  pid: 10564,
  bootId: 'boot-orphan',
  home: null,
};

describe('coodra start — daemon ownership', () => {
  let home: string;

  beforeEach(() => {
    started.length = 0;
    probePortOccupant.mockReset();
    waitForOwnDaemon.mockReset();
    home = mkdtempSync(join(tmpdir(), 'coodra-start-ownership-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('succeeds when the daemon it launched is the one answering', async () => {
    probePortOccupant.mockResolvedValue({ kind: 'none' });
    waitForOwnDaemon.mockResolvedValue({
      ok: true,
      identity: { ...ORPHAN, pid: 777, bootId: 'boot-fresh' },
    });

    const { io, out } = makeIO();
    expect(await runAndCaptureExit(home, io)).toBe(EXIT_OK);
    // The pid is printed so the user can tell one daemon from the next.
    expect(out()).toContain('pid 777');
  });

  it('fails, naming the pid, when an earlier daemon still holds the port', async () => {
    // Before: a green "listening on :3100" over a dying daemon.
    probePortOccupant.mockResolvedValue(ORPHAN);
    waitForOwnDaemon.mockResolvedValue({ ok: false, reason: 'stale_owner', identity: ORPHAN });

    const { io, out, err } = makeIO();
    expect(await runAndCaptureExit(home, io)).toBe(EXIT_SERVICE_STARTUP_FAILED);
    expect(err()).toContain('10564');
    expect(err()).toContain('still held by an earlier daemon');
    expect(err()).toContain('coodra stop');
    expect(out()).not.toContain('listening on :3100');
  });

  it('passes the previous bootId so a replacement can be distinguished', async () => {
    probePortOccupant.mockResolvedValue(ORPHAN);
    waitForOwnDaemon.mockResolvedValue({ ok: true, identity: { ...ORPHAN, pid: 1, bootId: 'boot-fresh' } });

    const { io } = makeIO();
    await runAndCaptureExit(home, io);
    expect(waitForOwnDaemon).toHaveBeenCalledWith(expect.objectContaining({ previousBootId: 'boot-orphan' }));
  });

  it('refuses to start over a foreign listener, and never launches the unit', async () => {
    probePortOccupant.mockResolvedValue({ kind: 'foreign', detail: 'responded 200 with a non-JSON body' });

    const { io, err } = makeIO();
    expect(await runAndCaptureExit(home, io)).toBe(EXIT_SERVICE_STARTUP_FAILED);
    expect(err()).toContain('not a Coodra daemon');
    // Bailing before install/start matters: bootstrapping a unit that
    // cannot bind is what produced the 105832-line crash loop.
    expect(started).toEqual([]);
  });

  it('reports a plain timeout distinctly from a stale owner', async () => {
    probePortOccupant.mockResolvedValue({ kind: 'none' });
    waitForOwnDaemon.mockResolvedValue({ ok: false, reason: 'timeout' });

    const { io, err } = makeIO();
    expect(await runAndCaptureExit(home, io)).toBe(EXIT_SERVICE_STARTUP_FAILED);
    expect(err()).toContain('did not become healthy');
    expect(err()).not.toContain('still held by an earlier daemon');
  });
});
