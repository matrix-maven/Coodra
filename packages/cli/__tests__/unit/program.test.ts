import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../../src/program.js';

describe('buildProgram — full surface (post-S8)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit__:${code ?? 0}`);
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('registers all 18 top-level subcommands (M08a 8 + M08b S3-S12: pause/resume/logs/db/upgrade/uninstall/policy/project/run/export)', () => {
    const program = buildProgram();
    const top = program.commands.map((c) => c.name()).sort();
    expect(top).toEqual([
      'cloud-migrate',
      'db',
      'doctor',
      'export',
      'init',
      'logs',
      'pause',
      'policy',
      'project',
      'resume',
      'run',
      'start',
      'status',
      'stop',
      'team',
      'uninstall',
      'upgrade',
    ]);

    const team = program.commands.find((c) => c.name() === 'team');
    expect(team).toBeDefined();
    const sub = team?.commands.map((c) => c.name()).sort() ?? [];
    expect(sub).toEqual(['login', 'logout']);

    const db = program.commands.find((c) => c.name() === 'db');
    expect(db).toBeDefined();
    const dbSub = db?.commands.map((c) => c.name()).sort() ?? [];
    expect(dbSub).toEqual(['backup', 'migrate', 'restore']);

    const policy = program.commands.find((c) => c.name() === 'policy');
    expect(policy).toBeDefined();
    const policySub = policy?.commands.map((c) => c.name()).sort() ?? [];
    expect(policySub).toEqual(['add', 'disable', 'enable', 'list', 'show']);

    const projectCmd = program.commands.find((c) => c.name() === 'project');
    expect(projectCmd).toBeDefined();
    const projectSub = projectCmd?.commands.map((c) => c.name()).sort() ?? [];
    expect(projectSub).toEqual(['list', 'reset', 'show']);

    const runCmd = program.commands.find((c) => c.name() === 'run');
    expect(runCmd).toBeDefined();
    const runSub = runCmd?.commands.map((c) => c.name()).sort() ?? [];
    expect(runSub).toEqual(['cancel', 'list', 'show']);
  });

  it('wires `cloud-migrate` to the real runCloudMigrate handler (M04a S1) — passes flags through', async () => {
    const calls: Array<unknown> = [];
    const fakeRunCloudMigrate = async (opts: unknown) => {
      calls.push(opts);
      throw new Error('__exit__:0');
    };
    const program = buildProgram({ runCloudMigrate: fakeRunCloudMigrate });
    await expect(
      program.parseAsync([
        'node',
        'contextos',
        'cloud-migrate',
        '--database-url',
        'postgres://u:p@h/db',
        '--dry-run',
        '--json',
      ]),
    ).rejects.toThrow('__exit__:0');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ databaseUrl: 'postgres://u:p@h/db', dryRun: true, json: true });
  });

  it('wires `doctor` to the real runDoctor handler (S3 wiring)', async () => {
    const calls: Array<unknown> = [];
    const fakeRunDoctor = async (opts: unknown) => {
      calls.push(opts);
      throw new Error('__exit__:0');
    };
    const program = buildProgram({ runDoctor: fakeRunDoctor });
    await expect(program.parseAsync(['node', 'contextos', 'doctor', '--json'])).rejects.toThrow('__exit__:0');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ json: true });
  });

  it('wires `init` to the real runInit handler (S5 wiring) — passes flags through', async () => {
    const calls: Array<unknown> = [];
    const fakeRunInit = async (opts: unknown) => {
      calls.push(opts);
      throw new Error('__exit__:0');
    };
    const program = buildProgram({ runInit: fakeRunInit });
    await expect(
      program.parseAsync(['node', 'contextos', 'init', '--project-slug', 'demo', '--dry-run']),
    ).rejects.toThrow('__exit__:0');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ projectSlug: 'demo', dryRun: true });
  });

  it('wires `start` to the real runStart handler (S7 wiring)', async () => {
    const calls: Array<unknown> = [];
    const fakeRunStart = async (opts: unknown) => {
      calls.push(opts);
      throw new Error('__exit__:0');
    };
    const program = buildProgram({ runStart: fakeRunStart });
    await expect(program.parseAsync(['node', 'contextos', 'start', '--no-mcp'])).rejects.toThrow('__exit__:0');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ mcp: false });
  });

  it('wires `stop` to the real runStop handler (S7 wiring)', async () => {
    const calls: Array<unknown> = [];
    const fakeRunStop = async (opts: unknown) => {
      calls.push(opts);
      throw new Error('__exit__:0');
    };
    const program = buildProgram({ runStop: fakeRunStop });
    await expect(program.parseAsync(['node', 'contextos', 'stop', '--service', 'mcp-server'])).rejects.toThrow(
      '__exit__:0',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ service: 'mcp-server' });
  });

  it('wires `status` to the real runStatus handler (S8 wiring)', async () => {
    const calls: Array<unknown> = [];
    const fakeRunStatus = async (opts: unknown) => {
      calls.push(opts);
      throw new Error('__exit__:0');
    };
    const program = buildProgram({ runStatus: fakeRunStatus });
    await expect(program.parseAsync(['node', 'contextos', 'status', '--json'])).rejects.toThrow('__exit__:0');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ json: true });
  });

  it('wires `team login` to the real handler (S8 stub) — passes token + --server', async () => {
    const calls: Array<unknown> = [];
    const fakeRunTeamLogin = async (opts: unknown) => {
      calls.push(opts);
      throw new Error('__exit__:2');
    };
    const program = buildProgram({ runTeamLogin: fakeRunTeamLogin });
    await expect(
      program.parseAsync(['node', 'contextos', 'team', 'login', 'tok-abc', '--server', 'https://x.example']),
    ).rejects.toThrow('__exit__:2');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ token: 'tok-abc', server: 'https://x.example' });
  });

  it('wires `team logout` to the real handler (S8 stub)', async () => {
    let called = false;
    const fakeRunTeamLogout = async () => {
      called = true;
      throw new Error('__exit__:2');
    };
    const program = buildProgram({ runTeamLogout: fakeRunTeamLogout });
    await expect(program.parseAsync(['node', 'contextos', 'team', 'logout'])).rejects.toThrow('__exit__:2');
    expect(called).toBe(true);
  });

  it('exposes `--version` (placeholder VERSION until S2 prebuild lands)', () => {
    const program = buildProgram();
    expect(program.version()).toBeTruthy();
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
