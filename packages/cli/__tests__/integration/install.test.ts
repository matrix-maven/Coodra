import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInstallCommand } from '../../src/commands/install.js';

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

    await expect(runInstallCommand({ home, userHome, env: {} }, io)).rejects.toThrow('__exit__:0');

    expect((await stat(join(home, 'data.db'))).isFile()).toBe(true);
    expect((await stat(join(home, 'logs'))).isDirectory()).toBe(true);
    expect((await stat(join(home, 'pids'))).isDirectory()).toBe(true);
    expect((await stat(join(home, 'manifest.json'))).isFile()).toBe(true);

    const manifest = JSON.parse(await readFile(join(home, 'manifest.json'), 'utf8'));
    expect(manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'config.json', scope: 'machine', kind: 'machine-config' }),
        expect.objectContaining({ path: '.env', scope: 'machine', kind: 'runtime-env' }),
        expect.objectContaining({ path: 'data.db', scope: 'machine', kind: 'sqlite-db' }),
        expect.objectContaining({ path: 'logs', scope: 'machine', kind: 'logs-dir' }),
        expect.objectContaining({ path: 'pids', scope: 'machine', kind: 'pids-dir' }),
        expect.objectContaining({ path: 'manifest.json', scope: 'machine', kind: 'machine-manifest' }),
      ]),
    );
    expect(manifest.agents).toEqual([]);
    expect(stdout.join('')).toContain('Machine manifest');
  });

  it('records detected but not installed agents in the machine manifest', async () => {
    const home = await mkdtemp(join(tmpdir(), 'coodra-install-home-'));
    const userHome = await mkdtemp(join(tmpdir(), 'coodra-install-userhome-'));
    await mkdir(join(userHome, '.codex'), { recursive: true });
    const { io } = makeIO();

    await expect(runInstallCommand({ home, userHome, env: {} }, io)).rejects.toThrow('__exit__:0');

    const manifest = JSON.parse(await readFile(join(home, 'manifest.json'), 'utf8'));
    expect(manifest.agents).toEqual([expect.objectContaining({ id: 'codex', status: 'detected', installed: false })]);
  });
});
