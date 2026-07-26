import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runUninstallCommand, type UninstallIO } from '../../src/commands/uninstall.js';
import { EXIT_OK } from '../../src/exit-codes.js';
import type { DaemonManager } from '../../src/lib/daemon/index.js';
import { mergeCursorMcpConfig } from '../../src/lib/init/cursor-merge.js';

interface Capture {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
}

/**
 * Hermetic daemon-manager stub. Records every stop/uninstall so tests can
 * assert the tear-down happened, WITHOUT ever shelling `launchctl` /
 * `systemctl` against the host's real Coodra units. Every uninstall test
 * MUST inject one of these (via makeIo) — otherwise `selectDaemonManager`
 * would resolve the real platform manager and stop the developer's actual
 * daemons during the test run.
 */
type StubDaemonManager = DaemonManager & { readonly calls: Array<{ op: string; unit: string }> };

function makeStubDaemonManager(): StubDaemonManager {
  const calls: Array<{ op: string; unit: string }> = [];
  return {
    kind: 'fallback',
    calls,
    isAvailable: async () => true,
    install: async () => {},
    uninstall: async (u: string) => {
      calls.push({ op: 'uninstall', unit: u });
    },
    start: async () => {},
    stop: async (u: string) => {
      calls.push({ op: 'stop', unit: u });
    },
    status: async (u: string) => ({ name: u, state: 'stopped' as const }),
    list: async () => [],
  };
}

// `cwd` omitted → the command falls back to detectProjectRoot(process.cwd())
// (the field-bug regression path exercised in Fixture 7). `daemonManager`
// omitted → a fresh benign stub so the test never touches host daemons.
function makeIo(args: {
  homePath: string;
  cwd?: string;
  settingsPath: string;
  cap: Capture;
  daemonManager?: DaemonManager;
}): UninstallIO {
  return {
    writeStdout: (c) => args.cap.stdout.push(c),
    writeStderr: (c) => args.cap.stderr.push(c),
    exit: (code) => {
      args.cap.exitCode = code;
      throw new Error(`__exit__:${code}`);
    },
    coodraHome: args.homePath,
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    bridgePort: 3101,
    settingsPath: args.settingsPath,
    daemonManager: args.daemonManager ?? makeStubDaemonManager(),
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI for assertion.
const ANSI = /\x1b\[[0-9;]*m/g;

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
let projectCwd: string;
let settingsPath: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'cli-uninstall-int-'));
  homePath = join(cwd, '.coodra');
  projectCwd = join(cwd, 'project');
  settingsPath = join(cwd, '.claude-settings.json');
  mkdirSync(homePath, { recursive: true });
  mkdirSync(projectCwd, { recursive: true });
  writeFileSync(join(homePath, 'data.db'), 'dummy-sqlite-bytes');
  writeFileSync(join(homePath, 'config.json'), JSON.stringify({ keep: 'me' }));
});

afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('coodra uninstall integration', () => {
  it('Fixture 1 — removes coodra-owned hook entries from claude settings (URL match)', async () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'http',
                url: 'http://127.0.0.1:3101/v1/hooks/claude-code',
                headers: {},
                allowedEnvVars: [],
                timeout: 10,
              },
            ],
          },
        ],
        PreToolUse: [
          {
            matcher: 'Write|Edit',
            hooks: [
              {
                type: 'http',
                url: 'http://127.0.0.1:3101/v1/hooks/claude-code',
                headers: {},
                allowedEnvVars: [],
                timeout: 10,
              },
            ],
          },
          {
            matcher: 'OtherTool',
            hooks: [{ type: 'http', url: 'http://example.com/other', headers: {}, allowedEnvVars: [], timeout: 10 }],
          },
        ],
      },
      otherKey: 'preserved',
    };
    writeFileSync(settingsPath, JSON.stringify(settings));

    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUninstallCommand({ json: true }, makeIo({ homePath, cwd: projectCwd, settingsPath, cap })),
    );
    expect(code).toBe(EXIT_OK);

    const next = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string }>>;
      otherKey: string;
    };
    expect(next.otherKey).toBe('preserved');
    expect(next.hooks.SessionStart).toBeUndefined(); // had only coodra entry → key removed
    expect(next.hooks.PreToolUse).toHaveLength(1);
    expect(next.hooks.PreToolUse?.[0]?.matcher).toBe('OtherTool');
  });

  it('Fixture 2 — removes coodra entry from .mcp.json; preserves other servers', async () => {
    writeFileSync(
      join(projectCwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          coodra: { command: 'node', args: ['/path/to/runtime'] },
          otherServer: { command: 'other', args: [] },
        },
      }),
    );

    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUninstallCommand({ json: true }, makeIo({ homePath, cwd: projectCwd, settingsPath, cap })),
    );
    expect(code).toBe(EXIT_OK);

    const next = JSON.parse(readFileSync(join(projectCwd, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(next.mcpServers).not.toHaveProperty('coodra');
    expect(next.mcpServers).toHaveProperty('otherServer');
  });

  it('Fixture 3 — default-safe: preserves ~/.coodra/data.db + config.json', async () => {
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUninstallCommand({ json: true }, makeIo({ homePath, cwd: projectCwd, settingsPath, cap })),
    );
    expect(code).toBe(EXIT_OK);
    expect(existsSync(join(homePath, 'data.db'))).toBe(true);
    expect(existsSync(join(homePath, 'config.json'))).toBe(true);
  });

  it('Fixture 4 — --purge removes ~/.coodra/ entirely', async () => {
    expect(existsSync(homePath)).toBe(true);
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUninstallCommand({ json: true, purge: true }, makeIo({ homePath, cwd: projectCwd, settingsPath, cap })),
    );
    expect(code).toBe(EXIT_OK);
    expect(existsSync(homePath)).toBe(false);
  });

  it('Fixture 5 — idempotent: re-running on a clean uninstall is exit 0 with all-unchanged steps', async () => {
    // First run already cleans up; second run should be a no-op.
    const cap1: Capture = { stdout: [], stderr: [], exitCode: null };
    await expectExit(() =>
      runUninstallCommand({ json: true }, makeIo({ homePath, cwd: projectCwd, settingsPath, cap: cap1 })),
    );

    const cap2: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUninstallCommand({ json: true }, makeIo({ homePath, cwd: projectCwd, settingsPath, cap: cap2 })),
    );
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(cap2.stdout.join('')) as {
      ok: boolean;
      steps: Array<{ step: string; action: string }>;
    };
    expect(payload.ok).toBe(true);
    // Every file-reversal step should be unchanged on the second run. The
    // daemon steps always issue stop+uninstall (idempotent, best-effort) so
    // they report 'merged' each run — that's correct: uninstall is a
    // tear-down, and issuing an idempotent stop twice is harmless.
    for (const s of payload.steps) {
      if (s.step.startsWith('daemon:')) {
        expect(s.action).toBe('merged');
        continue;
      }
      expect(s.action).toBe('unchanged');
    }
  });

  it('Fixture 6 — removes the coodra entry a real init wrote into .cursor/mcp.json (io.cwd honored)', async () => {
    // Write via the SAME writer `coodra init` uses, so the fixture matches
    // production bytes rather than a hand-rolled shape.
    const wrote = await mergeCursorMcpConfig({
      cwd: projectCwd,
      entry: { command: 'node', args: ['/abs/runtime/mcp-server.js'] },
      force: false,
      dryRun: false,
    });
    expect(wrote.action).toBe('wrote');

    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUninstallCommand({ json: true }, makeIo({ homePath, cwd: projectCwd, settingsPath, cap })),
    );
    expect(code).toBe(EXIT_OK);

    const payload = JSON.parse(cap.stdout.join('')) as {
      projectRoot: string;
      steps: Array<{ step: string; action: string }>;
    };
    // io.cwd is honored verbatim as the project root.
    expect(payload.projectRoot).toBe(projectCwd);
    expect(payload.steps.find((s) => s.step === 'cursor-mcp')?.action).toBe('merged');
    const next = JSON.parse(readFileSync(join(projectCwd, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(next.mcpServers).not.toHaveProperty('coodra');
  });

  it('Fixture 7 — THE FIELD BUG: run from a subdirectory still removes the entry at the project root', async () => {
    // 2026-07-12: uninstall used the raw process.cwd(), so running it from
    // a subdirectory inspected a DIFFERENT .cursor/mcp.json and truthfully
    // reported "no coodra entry to remove" while the real entry persisted.
    // It must now walk up to the same project root `coodra init` used.
    const repoDir = join(cwd, 'repo');
    const subDir = join(repoDir, 'sub');
    mkdirSync(join(repoDir, '.git'), { recursive: true }); // project-root marker
    mkdirSync(subDir, { recursive: true });
    await mergeCursorMcpConfig({
      cwd: repoDir,
      entry: { command: 'node', args: ['/abs/runtime/mcp-server.js'] },
      force: false,
      dryRun: false,
    });

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(subDir);
    try {
      const cap: Capture = { stdout: [], stderr: [], exitCode: null };
      // io.cwd deliberately UNDEFINED — the command must resolve the root itself.
      const code = await expectExit(() => runUninstallCommand({ json: true }, makeIo({ homePath, settingsPath, cap })));
      expect(code).toBe(EXIT_OK);

      const payload = JSON.parse(cap.stdout.join('')) as {
        projectRoot: string;
        steps: Array<{ step: string; action: string }>;
      };
      expect(payload.projectRoot).toBe(repoDir);
      expect(payload.steps.find((s) => s.step === 'cursor-mcp')?.action).toBe('merged');
      const next = JSON.parse(readFileSync(join(repoDir, '.cursor', 'mcp.json'), 'utf8')) as {
        mcpServers: Record<string, unknown>;
      };
      expect(next.mcpServers).not.toHaveProperty('coodra');
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('Fixture 8 — human output names the resolved project root right after the title', async () => {
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUninstallCommand({ skipNpmHint: true }, makeIo({ homePath, cwd: projectCwd, settingsPath, cap })),
    );
    expect(code).toBe(EXIT_OK);
    const lines = cap.stdout
      .join('')
      .replace(ANSI, '')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines[0]).toContain('coodra uninstall');
    expect(lines[1]).toBe(`  project root: ${projectCwd}`);
  });

  it('Fixture 9 — THE PORT-3001 BUG: stops AND uninstalls every daemon unit, web included', async () => {
    // 2026-07-18: `coodra uninstall` never called the daemon manager, so the
    // web daemon kept holding port 3001 after "uninstall". It must now stop +
    // uninstall all four units (mcp-server, hooks-bridge, sync-daemon, web).
    const stub = makeStubDaemonManager();
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUninstallCommand(
        { json: true },
        makeIo({ homePath, cwd: projectCwd, settingsPath, cap, daemonManager: stub }),
      ),
    );
    expect(code).toBe(EXIT_OK);

    // Every service was BOTH stopped and uninstalled.
    for (const unit of ['mcp-server', 'hooks-bridge', 'sync-daemon', 'web'] as const) {
      expect(stub.calls).toContainEqual({ op: 'stop', unit });
      expect(stub.calls).toContainEqual({ op: 'uninstall', unit });
    }
    // The web unit is present — the exact regression (port 3001 survivor).
    const payload = JSON.parse(cap.stdout.join('')) as { steps: Array<{ step: string; action: string }> };
    expect(payload.steps.find((s) => s.step === 'daemon:web')?.action).toBe('merged');
  });

  it('Fixture 10 — --remove-data deletes data.db (+wal/shm) but keeps config.json', async () => {
    // Lay down the WAL + SHM sidecars so removal covers all three files.
    writeFileSync(join(homePath, 'data.db-wal'), 'wal');
    writeFileSync(join(homePath, 'data.db-shm'), 'shm');

    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUninstallCommand({ json: true, removeData: true }, makeIo({ homePath, cwd: projectCwd, settingsPath, cap })),
    );
    expect(code).toBe(EXIT_OK);

    // SQLite store gone…
    expect(existsSync(join(homePath, 'data.db'))).toBe(false);
    expect(existsSync(join(homePath, 'data.db-wal'))).toBe(false);
    expect(existsSync(join(homePath, 'data.db-shm'))).toBe(false);
    // …but config + the home dir itself survive (narrower than --purge).
    expect(existsSync(join(homePath, 'config.json'))).toBe(true);
    expect(existsSync(homePath)).toBe(true);

    const payload = JSON.parse(cap.stdout.join('')) as {
      preserved: string[];
      steps: Array<{ step: string; action: string }>;
    };
    expect(payload.steps.find((s) => s.step === 'remove-data')?.action).toBe('merged');
    expect(payload.preserved).toContain(`${homePath}/config.json`);
    expect(payload.preserved).not.toContain(`${homePath}/data.db`);
  });

  it('Fixture 11 — --dry-run stops nothing and deletes no data', async () => {
    const stub = makeStubDaemonManager();
    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUninstallCommand(
        { json: true, dryRun: true, removeData: true },
        makeIo({ homePath, cwd: projectCwd, settingsPath, cap, daemonManager: stub }),
      ),
    );
    expect(code).toBe(EXIT_OK);
    // Dry-run must not touch the daemon manager…
    expect(stub.calls).toHaveLength(0);
    // …nor delete the SQLite store.
    expect(existsSync(join(homePath, 'data.db'))).toBe(true);
    const payload = JSON.parse(cap.stdout.join('')) as { steps: Array<{ step: string; action: string }> };
    expect(payload.steps.find((s) => s.step === 'daemon:web')?.action).toBe('unchanged');
    expect(payload.steps.find((s) => s.step === 'remove-data')?.action).toBe('unchanged');
  });
});
