import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COODRA_CODEX_NATIVE_PERMISSIONS_BEGIN,
  COODRA_CODEX_NATIVE_PERMISSIONS_END,
  COODRA_POLICY_PROJECTION_BEGIN,
  COODRA_POLICY_PROJECTION_END,
} from '@coodra/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUninstallCommand, type UninstallIO } from '../../src/commands/uninstall.js';
import { EXIT_OK } from '../../src/exit-codes.js';
import type { ClaudeCliRunner } from '../../src/lib/agents/claude-plugin.js';
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

const noopClaudeCliRunner: ClaudeCliRunner = {
  detect: async () => null,
  installMarketplaceAndPlugin: async () => ({ ok: false, reason: 'test noop' }),
  uninstallPlugin: async () => ({ ok: false, reason: 'test noop' }),
  isInstalled: async () => false,
};

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

// `cwd` is accepted by older fixtures but uninstall cleanup is now registry-
// driven; `daemonManager` omitted → a fresh benign stub so the test never
// touches host daemons.
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
    userHome: args.homePath.replace(/\/\.coodra$/, ''),
    claudeCliRunner: noopClaudeCliRunner,
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

async function seedProjectsDb(
  dbPath: string,
  projects: ReadonlyArray<{ id: string; slug: string; name: string; cwd: string | null }>,
): Promise<void> {
  rmSync(dbPath, { force: true });
  const { createSqliteDb } = await import('@coodra/db');
  const handle = createSqliteDb({ path: dbPath, loadVecExtension: false });
  try {
    handle.raw.exec(`
      CREATE TABLE projects (
        id text PRIMARY KEY,
        slug text NOT NULL,
        org_id text NOT NULL DEFAULT '__solo__',
        name text NOT NULL,
        cwd text,
        created_at integer NOT NULL DEFAULT (unixepoch() * 1000),
        updated_at integer NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE TABLE runs (
        id text PRIMARY KEY,
        project_id text,
        started_at integer NOT NULL
      );
    `);
    const stmt = handle.raw.prepare(
      'INSERT INTO projects (id, slug, org_id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const project of projects) {
      stmt.run(project.id, project.slug, '__solo__', project.name, project.cwd, Date.now(), Date.now());
    }
  } finally {
    handle.close();
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

  it('Fixture 2 — default uninstall preserves project .mcp.json', async () => {
    writeFileSync(
      join(projectCwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          coodra: { command: 'node', args: ['/path/to/runtime'] },
          otherServer: { command: 'other', args: [] },
        },
      }),
    );
    await seedProjectsDb(join(homePath, 'data.db'), [
      { id: 'current', slug: 'current', name: 'Current', cwd: projectCwd },
      { id: '__global__', slug: '__global__', name: 'Global', cwd: null },
    ]);

    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUninstallCommand({ json: true }, makeIo({ homePath, cwd: projectCwd, settingsPath, cap })),
    );
    expect(code).toBe(EXIT_OK);

    const next = JSON.parse(readFileSync(join(projectCwd, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(next.mcpServers).toHaveProperty('coodra');
    expect(next.mcpServers).toHaveProperty('otherServer');
  });

  it('Fixture 2b — --purge removes coodra entry from .mcp.json and preserves other servers', async () => {
    writeFileSync(
      join(projectCwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          coodra: { command: 'node', args: ['/path/to/runtime'] },
          otherServer: { command: 'other', args: [] },
        },
      }),
    );
    await seedProjectsDb(join(homePath, 'data.db'), [
      { id: 'current', slug: 'current', name: 'Current', cwd: projectCwd },
      { id: '__global__', slug: '__global__', name: 'Global', cwd: null },
    ]);

    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUninstallCommand({ json: true, purge: true }, makeIo({ homePath, cwd: projectCwd, settingsPath, cap })),
    );
    expect(code).toBe(EXIT_OK);

    const next = JSON.parse(readFileSync(join(projectCwd, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(next.mcpServers).not.toHaveProperty('coodra');
    expect(next.mcpServers).toHaveProperty('otherServer');
  });

  it('Fixture 2c — --purge removes repo policy projection blocks without deleting unrelated settings', async () => {
    mkdirSync(join(projectCwd, '.codex'), { recursive: true });
    mkdirSync(join(projectCwd, '.claude'), { recursive: true });
    writeFileSync(
      join(projectCwd, '.codex', 'config.toml'),
      [
        'model = "gpt-5"',
        'default_permissions = "coodra-project"',
        '',
        COODRA_POLICY_PROJECTION_BEGIN,
        '[coodra.policy_projection]',
        'projection_hash = "sha256:test"',
        COODRA_POLICY_PROJECTION_END,
        '',
        COODRA_CODEX_NATIVE_PERMISSIONS_BEGIN,
        '[permissions.coodra-project]',
        'description = "Coodra"',
        COODRA_CODEX_NATIVE_PERMISSIONS_END,
      ].join('\n'),
    );
    writeFileSync(
      join(projectCwd, '.claude', 'settings.json'),
      JSON.stringify({
        theme: 'dark',
        permissions: {
          allow: ['Bash(npm test:*)', 'Read(README.md)'],
          deny: ['Read(.env)'],
          disableAutoMode: 'disable',
          disableBypassPermissionsMode: 'disable',
        },
        coodra: {
          policyProjection: {
            nativePermissions: {
              claude: {
                allow: ['Bash(npm test:*)'],
                ask: [],
                deny: ['Read(.env)'],
              },
            },
          },
        },
      }),
    );
    await seedProjectsDb(join(homePath, 'data.db'), [
      { id: 'current', slug: 'current', name: 'Current', cwd: projectCwd },
      { id: '__global__', slug: '__global__', name: 'Global', cwd: null },
    ]);

    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUninstallCommand({ json: true, purge: true }, makeIo({ homePath, cwd: projectCwd, settingsPath, cap })),
    );
    expect(code).toBe(EXIT_OK);

    const codexRaw = readFileSync(join(projectCwd, '.codex', 'config.toml'), 'utf8');
    expect(codexRaw).toContain('model = "gpt-5"');
    expect(codexRaw).not.toContain('default_permissions = "coodra-project"');
    expect(codexRaw).not.toContain(COODRA_POLICY_PROJECTION_BEGIN);
    expect(codexRaw).not.toContain(COODRA_CODEX_NATIVE_PERMISSIONS_BEGIN);

    const claudeSettings = JSON.parse(readFileSync(join(projectCwd, '.claude', 'settings.json'), 'utf8')) as {
      theme: string;
      coodra?: unknown;
      permissions: { allow: string[]; deny: string[]; disableAutoMode?: string };
    };
    expect(claudeSettings.theme).toBe('dark');
    expect(claudeSettings.coodra).toBeUndefined();
    expect(claudeSettings.permissions.allow).toEqual(['Read(README.md)']);
    expect(claudeSettings.permissions.deny).toEqual([]);
    expect(claudeSettings.permissions.disableAutoMode).toBeUndefined();
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

  it('Fixture 4b — --purge removes Coodra project dirs from every registered project cwd', async () => {
    const otherProject = join(cwd, 'docling-advanced');
    mkdirSync(join(projectCwd, '.coodra', 'work-packs'), { recursive: true });
    mkdirSync(join(projectCwd, 'docs', 'context-packs'), { recursive: true });
    mkdirSync(join(otherProject, '.coodra', 'work-packs'), { recursive: true });
    mkdirSync(join(otherProject, 'docs', 'context-packs'), { recursive: true });
    await seedProjectsDb(join(homePath, 'data.db'), [
      { id: 'current', slug: 'current', name: 'Current', cwd: projectCwd },
      { id: 'other', slug: 'docling-advanced', name: 'Docling Advanced', cwd: otherProject },
      { id: '__global__', slug: '__global__', name: 'Global', cwd: null },
    ]);

    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUninstallCommand({ json: true, purge: true }, makeIo({ homePath, cwd: projectCwd, settingsPath, cap })),
    );
    expect(code).toBe(EXIT_OK);
    expect(existsSync(join(projectCwd, '.coodra'))).toBe(false);
    expect(existsSync(join(projectCwd, 'docs', 'context-packs'))).toBe(false);
    expect(existsSync(join(otherProject, '.coodra'))).toBe(false);
    expect(existsSync(join(otherProject, 'docs', 'context-packs'))).toBe(false);
    expect(existsSync(homePath)).toBe(false);

    const payload = JSON.parse(cap.stdout.join('')) as { steps: Array<{ step: string; action: string }> };
    expect(payload.steps.find((s) => s.step.includes('current') && s.step.endsWith('project-coodra-dir'))?.action).toBe(
      'merged',
    );
    expect(
      payload.steps.find((s) => s.step.includes('docling-advanced') && s.step.endsWith('project-coodra-dir'))?.action,
    ).toBe('merged');
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

  it('Fixture 6 — --purge removes the coodra entry a real init wrote into a registered project .cursor/mcp.json', async () => {
    // Write via the SAME writer `coodra init` uses, so the fixture matches
    // production bytes rather than a hand-rolled shape.
    const wrote = await mergeCursorMcpConfig({
      cwd: projectCwd,
      entry: { command: 'node', args: ['/abs/runtime/mcp-server.js'] },
      force: false,
      dryRun: false,
    });
    expect(wrote.action).toBe('wrote');

    await seedProjectsDb(join(homePath, 'data.db'), [
      { id: 'current', slug: 'current', name: 'Current', cwd: projectCwd },
      { id: '__global__', slug: '__global__', name: 'Global', cwd: null },
    ]);

    const cap: Capture = { stdout: [], stderr: [], exitCode: null };
    const code = await expectExit(() =>
      runUninstallCommand({ json: true, purge: true }, makeIo({ homePath, cwd: projectCwd, settingsPath, cap })),
    );
    expect(code).toBe(EXIT_OK);

    const payload = JSON.parse(cap.stdout.join('')) as {
      projectRoots: string[];
      steps: Array<{ step: string; action: string }>;
    };
    // Purge acts on registered projects, independent of where the command runs.
    expect(payload.projectRoots).toEqual([projectCwd]);
    expect(payload.steps.find((s) => s.step === 'cursor-mcp')?.action).toBe('merged');
    const next = JSON.parse(readFileSync(join(projectCwd, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(next.mcpServers).not.toHaveProperty('coodra');
  });

  it('Fixture 7 — --purge run from a subdirectory still removes registered project-root entries', async () => {
    // Purge is registry-driven, not current-directory driven. Even if the
    // command starts from a subdirectory, it cleans the registered project cwd.
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
    await seedProjectsDb(join(homePath, 'data.db'), [
      { id: 'repo', slug: 'repo', name: 'Repo', cwd: repoDir },
      { id: '__global__', slug: '__global__', name: 'Global', cwd: null },
    ]);

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(subDir);
    try {
      const cap: Capture = { stdout: [], stderr: [], exitCode: null };
      // io.cwd deliberately UNDEFINED — the command must use the project registry.
      const code = await expectExit(() =>
        runUninstallCommand({ json: true, purge: true }, makeIo({ homePath, settingsPath, cap })),
      );
      expect(code).toBe(EXIT_OK);

      const payload = JSON.parse(cap.stdout.join('')) as {
        projectRoots: string[];
        steps: Array<{ step: string; action: string }>;
      };
      expect(payload.projectRoots).toEqual([repoDir]);
      expect(payload.steps.find((s) => s.step === 'cursor-mcp')?.action).toBe('merged');
      const next = JSON.parse(readFileSync(join(repoDir, '.cursor', 'mcp.json'), 'utf8')) as {
        mcpServers: Record<string, unknown>;
      };
      expect(next.mcpServers).not.toHaveProperty('coodra');
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('Fixture 8 — human output lists registered project root count right after the title', async () => {
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
    expect(lines[1]).toBe('  project roots: 0');
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
