import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `coodra stop` must verify the daemon is actually gone.
 *
 * On macOS every daemon operation is scoped to the launchd LABEL:
 * `stop()` is `launchctl bootout gui/<uid>/com.coodra.<name>`. A
 * process that lost its label association survives that untouched —
 * and stop reported "✓ Stopped mcp-server" over it anyway, because
 * bootout on a label that names nothing exits cleanly.
 *
 * The field case ran for eleven days: an orphan holding :3100 through
 * repeated stop AND uninstall, with the CLI green every time.
 */

const stopped: string[] = [];
const uninstalled: string[] = [];

vi.mock('../../../src/lib/daemon/index.js', () => ({
  selectDaemonManager: vi.fn(async () => ({
    kind: 'launchd' as const,
    isAvailable: vi.fn(async () => true),
    install: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    // Succeeds. It booted out a label that no longer names the running
    // process — which is exactly the failure mode, not a test shortcut.
    stop: vi.fn(async (name: string) => {
      stopped.push(name);
    }),
    status: vi.fn(async (name: string) => ({ name, state: 'stopped' as const })),
    list: vi.fn(async () => []),
    uninstall: vi.fn(async (name: string) => {
      uninstalled.push(name);
    }),
  })),
}));

vi.mock('../../../src/lib/tunnel.js', () => ({
  stopTunnelByPid: vi.fn(() => ({ stopped: false, pid: null })),
  clearTunnelUrlFromHomeEnv: vi.fn(),
}));

const reapPortOwner = vi.fn();
vi.mock('../../../src/lib/daemon-identity.js', () => ({
  reapPortOwner: (...args: unknown[]) => reapPortOwner(...args),
}));

import { runStopCommand, type StopIO } from '../../../src/commands/stop.js';
import { EXIT_OK, EXIT_SERVICE_STARTUP_FAILED } from '../../../src/exit-codes.js';

class ExitSentinel extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
    this.name = 'ExitSentinel';
  }
}

function makeIO(): { io: StopIO; out: () => string; err: () => string } {
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

async function runStop(home: string, io: StopIO, service?: string): Promise<number> {
  try {
    await runStopCommand({ home, env: {}, ...(service !== undefined ? { service } : {}) }, io);
    throw new Error('runStopCommand returned without exiting');
  } catch (e) {
    if (e instanceof ExitSentinel) return e.code;
    throw e;
  }
}

describe('coodra stop — reaps a daemon that outlived its supervisor', () => {
  let home: string;

  beforeEach(() => {
    stopped.length = 0;
    uninstalled.length = 0;
    reapPortOwner.mockReset();
    home = mkdtempSync(join(tmpdir(), 'coodra-stop-reap-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('stays quiet when the supervisor did its job', async () => {
    reapPortOwner.mockResolvedValue({ outcome: 'nothing_listening' });

    const { io, out } = makeIO();
    expect(await runStop(home, io, 'mcp-server')).toBe(EXIT_OK);
    expect(stopped).toEqual(['mcp-server']);
    expect(out()).toContain('Stopped mcp-server');
    expect(out()).not.toContain('survived its supervisor');
  });

  it('terminates the orphan and says so', async () => {
    reapPortOwner.mockResolvedValue({ outcome: 'reaped', pid: 10564, escalated: false });

    const { io, out } = makeIO();
    expect(await runStop(home, io, 'mcp-server')).toBe(EXIT_OK);
    expect(out()).toContain('survived its supervisor');
    expect(out()).toContain('10564');
  });

  it('notes the escalation when SIGTERM was not enough', async () => {
    reapPortOwner.mockResolvedValue({ outcome: 'reaped', pid: 10564, escalated: true });

    const { io, out } = makeIO();
    await runStop(home, io, 'mcp-server');
    expect(out()).toContain('SIGKILL');
  });

  it('fails loudly rather than claiming success when the orphan will not die', async () => {
    reapPortOwner.mockResolvedValue({ outcome: 'survived', pid: 10564 });

    const { io, err } = makeIO();
    expect(await runStop(home, io, 'mcp-server')).toBe(EXIT_SERVICE_STARTUP_FAILED);
    expect(err()).toContain('still holding :3100');
  });

  it('leaves a listener that is not ours alone', async () => {
    reapPortOwner.mockResolvedValue({ outcome: 'not_ours', detail: 'responded 200 with a non-JSON body' });

    const { io, out } = makeIO();
    expect(await runStop(home, io, 'mcp-server')).toBe(EXIT_OK);
    expect(out()).toContain('left alone');
  });

  it('scopes the reap to this home, so another install is not taken down', async () => {
    reapPortOwner.mockResolvedValue({ outcome: 'nothing_listening' });

    const { io } = makeIO();
    await runStop(home, io, 'mcp-server');
    expect(reapPortOwner).toHaveBeenCalledWith(expect.objectContaining({ service: 'mcp-server', home }));
  });
});
