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

  it('registers all top-level subcommands (M08a 8 + M08b S3-S17 + features 2026-05-08: pause/resume/logs/db/upgrade/uninstall/policy/project/run/export/pack/template/feature + Phase G login + Phase H invite + terminal-UI ui)', () => {
    const program = buildProgram();
    const top = program.commands.map((c) => c.name()).sort();
    expect(top).toEqual([
      // 0.2.0-beta.1 — read-only multi-agent wiring status.
      'agents',
      'cloud-migrate',
      'db',
      'doctor',
      'export',
      'feature',
      // Module 09 Track 9B — Graphify MCP wiring (enable/disable/status).
      'graphify',
      'init',
      'invite',
      'login',
      'logout',
      'logs',
      'org',
      'pack',
      'pause',
      'policy',
      'project',
      'resume',
      'run',
      'start',
      'status',
      'stop',
      'team',
      'template',
      // Terminal-UI redesign — `coodra ui` launches the interactive TUI.
      'ui',
      'uninstall',
      'upgrade',
    ]);

    const team = program.commands.find((c) => c.name() === 'team');
    expect(team).toBeDefined();
    const sub = team?.commands.map((c) => c.name()).sort() ?? [];
    expect(sub).toEqual(['init', 'install', 'join', 'leave', 'login', 'logout', 'migrate', 'setup']);

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
    // W5 / beta.5 — `promote` (solo→team). W6 / beta.6 — `demote` (team→solo, cloud-gated).
    expect(projectSub).toEqual(['demote', 'list', 'promote', 'reset', 'show']);

    const runCmd = program.commands.find((c) => c.name() === 'run');
    expect(runCmd).toBeDefined();
    const runSub = runCmd?.commands.map((c) => c.name()).sort() ?? [];
    expect(runSub).toEqual(['cancel', 'list', 'show']);

    const packCmd = program.commands.find((c) => c.name() === 'pack');
    expect(packCmd).toBeDefined();
    const packSub = packCmd?.commands.map((c) => c.name()).sort() ?? [];
    expect(packSub).toEqual(['delete', 'list', 'new', 'regenerate', 'show']);

    const templateCmd = program.commands.find((c) => c.name() === 'template');
    expect(templateCmd).toBeDefined();
    const templateSub = templateCmd?.commands.map((c) => c.name()).sort() ?? [];
    expect(templateSub).toEqual(['install', 'list']);

    // 2026-05-08 — features admin under `coodra feature`.
    const featureCmd = program.commands.find((c) => c.name() === 'feature');
    expect(featureCmd).toBeDefined();
    const featureSub = featureCmd?.commands.map((c) => c.name()).sort() ?? [];
    expect(featureSub).toEqual(['add', 'edit', 'index', 'list', 'remove', 'show']);

    // Module 09 Track 9B — `coodra graphify {enable,disable,status}`.
    const graphifyCmd = program.commands.find((c) => c.name() === 'graphify');
    expect(graphifyCmd).toBeDefined();
    const graphifySub = graphifyCmd?.commands.map((c) => c.name()).sort() ?? [];
    expect(graphifySub).toEqual(['disable', 'enable', 'status']);
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
        'coodra',
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
    await expect(program.parseAsync(['node', 'coodra', 'doctor', '--json'])).rejects.toThrow('__exit__:0');
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
    await expect(program.parseAsync(['node', 'coodra', 'init', '--project-slug', 'demo', '--dry-run'])).rejects.toThrow(
      '__exit__:0',
    );
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
    await expect(program.parseAsync(['node', 'coodra', 'start', '--no-mcp'])).rejects.toThrow('__exit__:0');
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
    await expect(program.parseAsync(['node', 'coodra', 'stop', '--service', 'mcp-server'])).rejects.toThrow(
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
    await expect(program.parseAsync(['node', 'coodra', 'status', '--json'])).rejects.toThrow('__exit__:0');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ json: true });
  });

  it('wires `graphify enable` to the real runGraphifyEnable handler (Module 09 G3) — passes flags through', async () => {
    const calls: Array<unknown> = [];
    const fakeRun = async (opts: unknown) => {
      calls.push(opts);
      throw new Error('__exit__:0');
    };
    const program = buildProgram({ runGraphifyEnable: fakeRun });
    await expect(
      program.parseAsync([
        'node',
        'coodra',
        'graphify',
        'enable',
        '--ide',
        'claude',
        '--python',
        'python3',
        '--dry-run',
      ]),
    ).rejects.toThrow('__exit__:0');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ ide: 'claude', python: 'python3', dryRun: true });
  });

  it('wires `graphify disable` to the real runGraphifyDisable handler (Module 09 G3)', async () => {
    const calls: Array<unknown> = [];
    const fakeRun = async (opts: unknown) => {
      calls.push(opts);
      throw new Error('__exit__:0');
    };
    const program = buildProgram({ runGraphifyDisable: fakeRun });
    await expect(program.parseAsync(['node', 'coodra', 'graphify', 'disable', '--json'])).rejects.toThrow('__exit__:0');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ json: true });
  });

  it('wires `graphify status` to the real runGraphifyStatus handler (Module 09 G3)', async () => {
    const calls: Array<unknown> = [];
    const fakeRun = async (opts: unknown) => {
      calls.push(opts);
      throw new Error('__exit__:0');
    };
    const program = buildProgram({ runGraphifyStatus: fakeRun });
    await expect(program.parseAsync(['node', 'coodra', 'graphify', 'status', '--json'])).rejects.toThrow('__exit__:0');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ json: true });
  });

  it('wires `team login` to the Phase G login runner (legacy token+server flags accepted but token ignored)', async () => {
    // Phase G replaced the stub-based team-login with `runLoginCommand`.
    // `team login` is now a backward-compat alias for `coodra login` —
    // the legacy `[token]` argument is silently dropped (Phase G captures
    // the token via browser handoff). `--server` maps to `webUrl`.
    const calls: Array<unknown> = [];
    const fakeRunLogin = async (opts: unknown) => {
      calls.push(opts);
      throw new Error('__exit__:2');
    };
    const program = buildProgram({ runLogin: fakeRunLogin });
    await expect(
      program.parseAsync(['node', 'coodra', 'team', 'login', 'legacy-tok', '--server', 'https://x.example']),
    ).rejects.toThrow('__exit__:2');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ webUrl: 'https://x.example' });
    // The legacy positional token argument is intentionally dropped — not
    // round-tripped into LoginOptions.
    expect(calls[0]).not.toHaveProperty('token');
  });

  it('wires `team logout` to the Phase G logout runner (alias for `coodra logout`)', async () => {
    let called = false;
    const fakeRunLogout = async () => {
      called = true;
      throw new Error('__exit__:2');
    };
    const program = buildProgram({ runLogout: fakeRunLogout });
    await expect(program.parseAsync(['node', 'coodra', 'team', 'logout'])).rejects.toThrow('__exit__:2');
    expect(called).toBe(true);
  });

  it('wires top-level `logout` to the Phase G logout runner', async () => {
    const calls: Array<unknown> = [];
    const fakeRunLogout = async (opts: unknown) => {
      calls.push(opts);
      throw new Error('__exit__:0');
    };
    const program = buildProgram({ runLogout: fakeRunLogout });
    await expect(program.parseAsync(['node', 'coodra', 'logout'])).rejects.toThrow('__exit__:0');
    expect(calls).toHaveLength(1);
  });

  it('exposes `--version` (placeholder VERSION until S2 prebuild lands)', () => {
    const program = buildProgram();
    expect(program.version()).toBeTruthy();
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
