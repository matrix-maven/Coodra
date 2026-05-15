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

  it('all-services-down + no .coodra.json → exit 2 (services down)', async () => {
    const { io, captured } = makeIO();
    await expect(
      runStatusCommand({ cwd, home, env: {}, fetchImpl: fakeFetchAllDown as unknown as typeof fetch }, io),
    ).rejects.toThrow('__exit__:2');
    expect(captured.exit).toBe(2);
    const stdout = captured.stdout.join('');
    expect(stdout).toContain('Services');
    expect(stdout).toContain('stopped');
  });

  it('all-services-up + no .coodra.json → exit 1 (project unregistered)', async () => {
    const { io, captured } = makeIO();
    await expect(
      runStatusCommand({ cwd, home, env: {}, fetchImpl: fakeFetchAllUp as unknown as typeof fetch }, io),
    ).rejects.toThrow('__exit__:1');
    expect(captured.exit).toBe(1);
    expect(captured.stdout.join('')).toContain('(unregistered)');
  });

  it('all-services-up + .coodra.json + initialised db → exit 0', async () => {
    const dataDb = join(home, 'data.db');
    const handle = await openLocalDb(dataDb, { loadVecExtension: true });
    migrateSqlite(handle.db);
    await ensureGlobalProject(handle);
    handle.close();
    await writeFile(join(cwd, '.coodra.json'), JSON.stringify({ projectSlug: 'demo' }));

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
    await writeFile(join(cwd, '.coodra.json'), JSON.stringify({ projectSlug: 'demo' }));

    const { io, captured } = makeIO();
    await expect(
      runStatusCommand({ cwd, home, env: {}, json: true, fetchImpl: fakeFetchAllUp as unknown as typeof fetch }, io),
    ).rejects.toThrow('__exit__:0');
    const parsed = JSON.parse(captured.stdout.join(''));
    expect(parsed.project).toBeDefined();
    expect(parsed.services).toHaveLength(2);
    expect(parsed.recent).toBeDefined();
    expect(parsed.coodraHome).toBe(home);
    expect(parsed.services.map((s: { name: string }) => s.name).sort()).toEqual(['hooks-bridge', 'mcp-server']);
  });
});

describe('team login / logout — stubs (S8)', () => {
  it('team login exits 2 with the deferred-body message', async () => {
    const { io, captured } = makeIO();
    const { runTeamLoginCommand } = await import('../../src/commands/team.js');
    await expect(runTeamLoginCommand({ token: 'tok' }, io)).rejects.toThrow('__exit__:2');
    expect(captured.exit).toBe(2);
    expect(captured.stderr.join('')).toMatch(/team mode not yet generally available/);
  });

  it('team logout exits 2 with the deferred-body message', async () => {
    const { io, captured } = makeIO();
    const { runTeamLogoutCommand } = await import('../../src/commands/team.js');
    await expect(runTeamLogoutCommand(io)).rejects.toThrow('__exit__:2');
    expect(captured.exit).toBe(2);
    expect(captured.stderr.join('')).toMatch(/team mode not yet generally available/);
  });
});
