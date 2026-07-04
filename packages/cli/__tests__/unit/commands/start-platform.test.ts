import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Windows-readiness (2026-06-16, Core scope): `coodra start` on win32 must
 * bring up the Claude Code essentials (mcp-server + hooks-bridge) and SKIP
 * the `web` dashboard cleanly — the bundled Next.js standalone is traced on
 * the maintainer's machine and won't boot under win32, and the Claude Code
 * integration needs no web. On darwin/linux web is still attempted.
 *
 * These mocks make the test deterministic on any runner: the platform is
 * driven by `options.platform`, never `process.platform`.
 */

const installed: string[] = [];
const started: string[] = [];

vi.mock('../../../src/lib/services.js', () => {
  const http = (name: string, port: number) => ({
    descriptor: {
      kind: 'http' as const,
      name,
      displayName: name,
      port,
      defaultPort: port,
      relativeEntry: `apps/${name}/dist/index.js`,
      healthUrl: (p: number) => `http://127.0.0.1:${p}/healthz`,
    },
    entryPath: `/fake/${name}.js`,
    port,
    unit: { name, command: 'node', args: [`/fake/${name}.js`], env: {} },
  });
  return {
    resolveServices: vi.fn(async () => [http('mcp-server', 3100), http('hooks-bridge', 3101), http('web', 3001)]),
  };
});

vi.mock('../../../src/lib/daemon/index.js', () => ({
  selectDaemonManager: vi.fn(async () => ({
    kind: 'fallback' as const,
    isAvailable: vi.fn(async () => true),
    install: vi.fn(async (unit: { name: string }) => {
      installed.push(unit.name);
    }),
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

import { runStartCommand, type StartIO } from '../../../src/commands/start.js';
import { EXIT_OK } from '../../../src/exit-codes.js';

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

async function runAndCaptureExit(options: Parameters<typeof runStartCommand>[0], io: StartIO): Promise<number> {
  try {
    await runStartCommand(options, io);
    throw new Error('runStartCommand returned without exiting');
  } catch (e) {
    if (e instanceof ExitSentinel) return e.code;
    throw e;
  }
}

describe('coodra start — web is platform-gated', () => {
  let home: string;

  beforeEach(() => {
    installed.length = 0;
    started.length = 0;
    home = mkdtempSync(join(tmpdir(), 'coodra-start-platform-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('skips web on win32 but starts mcp-server + hooks-bridge (exit 0)', async () => {
    const { io, out } = makeIO();
    const code = await runAndCaptureExit({ platform: 'win32', home, env: {} }, io);

    expect(code).toBe(EXIT_OK);
    expect(installed).toContain('mcp-server');
    expect(installed).toContain('hooks-bridge');
    expect(installed).not.toContain('web');
    expect(out()).toContain('Skipping');
    expect(out()).toMatch(/not yet supported on Windows/i);
  });

  it('starts web on darwin (no platform skip)', async () => {
    const { io } = makeIO();
    const code = await runAndCaptureExit({ platform: 'darwin', home, env: {} }, io);

    expect(code).toBe(EXIT_OK);
    expect(installed).toContain('mcp-server');
    expect(installed).toContain('hooks-bridge');
    expect(installed).toContain('web');
  });

  it('still honours explicit --no-web on darwin', async () => {
    const { io } = makeIO();
    const code = await runAndCaptureExit({ platform: 'darwin', web: false, home, env: {} }, io);

    expect(code).toBe(EXIT_OK);
    expect(installed).toContain('mcp-server');
    expect(installed).not.toContain('web');
  });
});
