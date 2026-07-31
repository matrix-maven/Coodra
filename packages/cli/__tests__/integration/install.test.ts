import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInstallCommand } from '../../src/commands/install.js';
import type { InstallCommandRunner } from '../../src/lib/init/graphify-install.js';

function makeIO(): {
  io: { writeStdout(c: string): void; writeStderr(c: string): void; exit(code: number): never };
  stdout: string[];
} {
  const stdout: string[] = [];
  const io = {
    writeStdout(c: string) {
      stdout.push(c);
    },
    writeStderr(_c: string) {},
    exit(code: number): never {
      throw new Error(`__exit__:${code}`);
    },
  };
  return { io, stdout };
}

describe('runInstallCommand — integration', () => {
  it('creates machine runtime state and ~/.coodra/manifest.json', async () => {
    const home = await mkdtemp(join(tmpdir(), 'coodra-install-home-'));
    const userHome = await mkdtemp(join(tmpdir(), 'coodra-install-userhome-'));
    const { io, stdout } = makeIO();
    const graphifyRunner: InstallCommandRunner = async () => ({ ok: true });

    await expect(
      runInstallCommand(
        {
          home,
          userHome,
          env: {},
          graphifyRunner,
          graphifyProbeUv: async () => true,
          graphifyVerify: async () => ({ ok: true }),
        },
        io,
      ),
    ).rejects.toThrow('__exit__:0');

    expect((await stat(join(home, 'data.db'))).isFile()).toBe(true);
    expect((await stat(join(home, 'logs'))).isDirectory()).toBe(true);
    expect((await stat(join(home, 'pids'))).isDirectory()).toBe(true);
    expect((await stat(join(home, 'manifest.json'))).isFile()).toBe(true);
    const envBody = await readFile(join(home, '.env'), 'utf8');
    expect(envBody).toContain('# Graphify semantic build backend (optional)');
    expect(envBody).toContain('# GRAPHIFY_BACKEND=claude');
    expect(envBody).toContain('# ANTHROPIC_API_KEY=');
    expect(envBody).not.toMatch(/^ANTHROPIC_API_KEY=/m);

    const manifest = JSON.parse(await readFile(join(home, 'manifest.json'), 'utf8'));
    expect(manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'config.json', scope: 'machine', kind: 'machine-config' }),
        expect.objectContaining({ path: '.env', scope: 'machine', kind: 'runtime-env' }),
        expect.objectContaining({ path: 'data.db', scope: 'machine', kind: 'sqlite-db' }),
        expect.objectContaining({ path: 'logs', scope: 'machine', kind: 'logs-dir' }),
        expect.objectContaining({ path: 'pids', scope: 'machine', kind: 'pids-dir' }),
        expect.objectContaining({ path: 'manifest.json', scope: 'machine', kind: 'machine-manifest' }),
        expect.objectContaining({ path: 'graphify-mcp', scope: 'machine', kind: 'managed-mcp-runtime' }),
      ]),
    );
    expect(manifest.agents).toEqual([]);
    expect(stdout.join('')).toContain('Machine manifest');
    expect(stdout.join('')).toContain('Graphify MCP runtime');
    expect(stdout.join('')).toContain('Graphify LLM backend placeholders');
    expect(stdout.join('')).toContain('Next: run `coodra start` to launch the local Coodra services.');
    expect(stdout.join('')).toContain('Then run `coodra doctor` to verify this machine runtime.');
    expect(stdout.join('')).toContain(
      'Wire your coding agent with `coodra agent add codex` or `coodra agent add claude`.',
    );
    expect(stdout.join('')).toContain(
      'Then open a project and run `coodra init`, or ask the installed agent to use `/coodra init`.',
    );
    expect(stdout.join('')).not.toContain('COOD-6 through COOD-9');
  });

  it('records detected but not installed agents in the machine manifest', async () => {
    const home = await mkdtemp(join(tmpdir(), 'coodra-install-home-'));
    const userHome = await mkdtemp(join(tmpdir(), 'coodra-install-userhome-'));
    await mkdir(join(userHome, '.codex'), { recursive: true });
    const { io } = makeIO();
    const graphifyRunner: InstallCommandRunner = async () => ({ ok: true });

    await expect(
      runInstallCommand(
        {
          home,
          userHome,
          env: {},
          graphifyRunner,
          graphifyProbeUv: async () => false,
          graphifyVerify: async () => ({ ok: true }),
        },
        io,
      ),
    ).rejects.toThrow('__exit__:0');

    const manifest = JSON.parse(await readFile(join(home, 'manifest.json'), 'utf8'));
    expect(manifest.agents).toEqual([expect.objectContaining({ id: 'codex', status: 'detected', installed: false })]);
  });

  it('reports user-facing next steps in JSON output', async () => {
    const home = await mkdtemp(join(tmpdir(), 'coodra-install-home-'));
    const userHome = await mkdtemp(join(tmpdir(), 'coodra-install-userhome-'));
    const { io, stdout } = makeIO();
    const graphifyRunner: InstallCommandRunner = async () => ({ ok: true });

    await expect(
      runInstallCommand(
        {
          home,
          userHome,
          env: {},
          json: true,
          graphifyRunner,
          graphifyProbeUv: async () => false,
          graphifyVerify: async () => ({ ok: true }),
        },
        io,
      ),
    ).rejects.toThrow('__exit__:0');

    const parsed = JSON.parse(stdout.join('')) as { next: string[]; pluginInstallers?: string };
    expect(parsed.next).toEqual(['coodra start', 'coodra doctor', 'coodra agent add <agent>', 'coodra init']);
    expect(parsed.pluginInstallers).toBeUndefined();
  });
});
