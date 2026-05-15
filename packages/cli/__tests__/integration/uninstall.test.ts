import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runUninstallCommand, type UninstallIO } from '../../src/commands/uninstall.js';
import { EXIT_OK } from '../../src/exit-codes.js';

interface Capture {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
}

function makeIo(args: { homePath: string; cwd: string; settingsPath: string; cap: Capture }): UninstallIO {
  return {
    writeStdout: (c) => args.cap.stdout.push(c),
    writeStderr: (c) => args.cap.stderr.push(c),
    exit: (code) => {
      args.cap.exitCode = code;
      throw new Error(`__exit__:${code}`);
    },
    coodraHome: args.homePath,
    cwd: args.cwd,
    bridgePort: 3101,
    settingsPath: args.settingsPath,
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
    // Every step should be unchanged on the second run.
    for (const s of payload.steps) {
      expect(s.action).toBe('unchanged');
    }
  });
});
