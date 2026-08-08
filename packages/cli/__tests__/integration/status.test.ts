import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureGlobalProject, migrateSqlite } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStatusCommand } from '../../src/commands/status.js';
import { openLocalDb } from '../../src/lib/open-local-db.js';

interface CapturedIO {
  stdout: string[];
  stderr: string[];
  exit: number | null;
}

function makeIO(): {
  io: { writeStdout(c: string): void; writeStderr(c: string): void; exit(code: number): never };
  captured: CapturedIO;
} {
  const captured: CapturedIO = { stdout: [], stderr: [], exit: null };
  const io = {
    writeStdout(c: string) {
      captured.stdout.push(c);
    },
    writeStderr(c: string) {
      captured.stderr.push(c);
    },
    exit(code: number): never {
      captured.exit = code;
      throw new Error(`__exit__:${code}`);
    },
  };
  return { io, captured };
}

const fakeFetchAllUp = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
const fakeFetchAllDown = vi.fn(async () => {
  throw new Error('ECONNREFUSED');
});

describe('runStatusCommand — integration', () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-status-cwd-'));
    home = await mkdtemp(join(tmpdir(), 'coodra-status-home-'));
    await mkdir(join(home, 'logs'), { recursive: true });
    await mkdir(join(home, 'pids'), { recursive: true });
  });

  afterEach(() => {
    /* tmp cleaned by OS */
  });

  it('all-services-down + no .coodra/config.json → exit 2 (services down)', async () => {
    const { io, captured } = makeIO();
    await expect(
      runStatusCommand({ cwd, home, env: {}, fetchImpl: fakeFetchAllDown as unknown as typeof fetch }, io),
    ).rejects.toThrow('__exit__:2');
    expect(captured.exit).toBe(2);
    const stdout = captured.stdout.join('');
    // Section header is `/03  SERVICES  ───…` in the Phase B clarity-pass
    // renderer (2026-05-11). Match the uppercase variant.
    expect(stdout).toMatch(/SERVICES/);
    expect(stdout).toContain('stopped');
  });

  it('all-services-up + no .coodra/config.json → exit 1 (project unregistered)', async () => {
    const { io, captured } = makeIO();
    await expect(
      runStatusCommand({ cwd, home, env: {}, fetchImpl: fakeFetchAllUp as unknown as typeof fetch }, io),
    ).rejects.toThrow('__exit__:1');
    expect(captured.exit).toBe(1);
    expect(captured.stdout.join('')).toContain('(unregistered)');
  });

  it('all-services-up + .coodra/config.json + initialised db → exit 0', async () => {
    const dataDb = join(home, 'data.db');
    const handle = await openLocalDb(dataDb, { loadVecExtension: true });
    migrateSqlite(handle.db);
    await ensureGlobalProject(handle);
    handle.close();
    await mkdir(join(cwd, '.coodra'), { recursive: true });
    await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ version: 1, projectSlug: 'demo' }));

    const { io, captured } = makeIO();
    await expect(
      runStatusCommand({ cwd, home, env: {}, fetchImpl: fakeFetchAllUp as unknown as typeof fetch }, io),
    ).rejects.toThrow('__exit__:0');
    expect(captured.exit).toBe(0);
    const stdout = captured.stdout.join('');
    expect(stdout).toContain('demo');
    expect(stdout).toContain('running');
  });

  it('--json emits a structured object with project + services + recent', async () => {
    const dataDb = join(home, 'data.db');
    const handle = await openLocalDb(dataDb, { loadVecExtension: true });
    migrateSqlite(handle.db);
    await ensureGlobalProject(handle);
    handle.close();
    await mkdir(join(cwd, '.coodra'), { recursive: true });
    await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ version: 1, projectSlug: 'demo' }));

    const { io, captured } = makeIO();
    await expect(
      runStatusCommand({ cwd, home, env: {}, json: true, fetchImpl: fakeFetchAllUp as unknown as typeof fetch }, io),
    ).rejects.toThrow('__exit__:0');
    const parsed = JSON.parse(captured.stdout.join(''));
    expect(parsed.project).toBeDefined();
    // Two services in solo mode: mcp-server, web (W1 web-bundle-initiative
    // 2026-05-13 added the bundled dashboard as a default service).
    // sync-daemon is filtered out in solo mode; hooks-bridge retired COOD-53.
    expect(parsed.services).toHaveLength(2);
    expect(parsed.recent).toBeDefined();
    expect(parsed.coodraHome).toBe(home);
    expect(parsed.services.map((s: { name: string }) => s.name).sort()).toEqual(['mcp-server', 'web']);
  });
});
