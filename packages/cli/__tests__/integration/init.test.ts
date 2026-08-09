import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInitCommand } from '../../src/commands/init.js';
import { FORBIDDEN_INIT_KEYS } from '../../src/lib/init/forbidden-env.js';

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

describe('runInitCommand — integration', () => {
  let cwd: string;
  let home: string;
  let userHome: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-init-cwd-'));
    home = await mkdtemp(join(tmpdir(), 'coodra-init-home-'));
    userHome = await mkdtemp(join(tmpdir(), 'coodra-init-userhome-'));
    // Need a marker so detectProjectRoot succeeds.
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'sample-app' }));
  });

  afterEach(() => {
    /* tmp cleaned by OS */
  });

  it('greenfield: writes project registration and project-local Coodra layout only', async () => {
    const { io, captured } = makeIO();
    await expect(runInitCommand({ cwd, home, userHome, env: {} }, io)).rejects.toThrow('__exit__:0');
    expect(captured.exit).toBe(0);

    // ~/.coodra/ artifacts
    expect((await stat(join(home, 'data.db'))).isFile()).toBe(true);
    expect((await stat(join(home, 'logs'))).isDirectory()).toBe(true);
    expect((await stat(join(home, 'pids'))).isDirectory()).toBe(true);

    // Project artifacts
    const projectConfig = JSON.parse(await readFile(join(cwd, '.coodra', 'config.json'), 'utf8'));
    expect(projectConfig.projectSlug).toBeDefined();
    await expect(stat(join(cwd, '.coodra.json'))).rejects.toThrow();
    await expect(stat(join(cwd, '.mcp.json'))).rejects.toThrow();
    await expect(stat(join(cwd, '.codex', 'config.toml'))).rejects.toThrow();
    await expect(stat(join(cwd, 'AGENTS.md'))).rejects.toThrow();
    expect((await stat(join(cwd, '.coodra', 'recipes'))).isDirectory()).toBe(true);
    expect((await stat(join(cwd, '.coodra', 'work-packs'))).isDirectory()).toBe(true);
    expect((await stat(join(cwd, '.coodra', 'graphify'))).isDirectory()).toBe(true);
    expect((await stat(join(cwd, '.coodra', 'wiki'))).isDirectory()).toBe(true);

    await expect(stat(join(cwd, '.env'))).rejects.toThrow();
    const homeEnvBody = await readFile(join(home, '.env'), 'utf8');
    expect(homeEnvBody).toMatch(/LOCAL_HOOK_SECRET=[0-9a-f]{64}/);
    expect(homeEnvBody).toContain('MCP_SERVER_PORT=3100');

    const manifest = JSON.parse(await readFile(join(cwd, '.coodra', 'manifest.json'), 'utf8'));
    expect(manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: join(home, 'data.db'), scope: 'global', kind: 'sqlite-db' }),
        expect.objectContaining({ path: join(home, '.env'), scope: 'global', kind: 'env' }),
        expect.objectContaining({ path: join(home, 'logs'), scope: 'global', kind: 'logs-dir' }),
        expect.objectContaining({ path: join(home, 'pids'), scope: 'global', kind: 'pids-dir' }),
        expect.objectContaining({ path: '.coodra/recipes', scope: 'project', kind: 'recipes-dir' }),
        expect.objectContaining({ path: '.coodra/work-packs', scope: 'project', kind: 'work-packs-dir' }),
        expect.objectContaining({ path: '.coodra/graphify', scope: 'project', kind: 'graphify-dir' }),
        expect.objectContaining({ path: '.coodra/wiki', scope: 'project', kind: 'wiki-dir' }),
      ]),
    );

    // Project init keeps root-level docs untouched by default.
    await expect(stat(join(cwd, 'docs', 'feature-packs', projectConfig.projectSlug))).rejects.toThrow();

    // Stdout includes the "Coodra is ready" banner.
    const stdout = captured.stdout.join('');
    expect(stdout).toContain('Coodra is ready');
    expect(stdout).toContain('Project Coodra layout ready');
    expect(stdout).toContain('Project init only creates project-local .coodra state');
  });

  it('idempotent re-run: no destructive writes (action: unchanged)', async () => {
    const { io: io1 } = makeIO();
    await expect(runInitCommand({ cwd, home, userHome, env: {} }, io1)).rejects.toThrow('__exit__:0');

    // Snapshot the Coodra-owned home .env body before re-run.
    const before = await readFile(join(home, '.env'), 'utf8');

    const { io: io2, captured: captured2 } = makeIO();
    await expect(runInitCommand({ cwd, home, userHome, env: {} }, io2)).rejects.toThrow('__exit__:0');
    expect(captured2.exit).toBe(0);

    await expect(stat(join(cwd, '.env'))).rejects.toThrow();
    const after = await readFile(join(home, '.env'), 'utf8');
    expect(after).toBe(before); // re-run preserves Coodra runtime values

    // Stdout shows the idempotent re-run preserved existing project files.
    const stdout = captured2.stdout.join('');
    expect(stdout).toMatch(/file exists; pass --force to overwrite|projectSlug='/);
  });

  it('--force overwrites .coodra/config.json baseline (Decision 3)', async () => {
    const { io: io1 } = makeIO();
    await expect(runInitCommand({ cwd, home, userHome, env: {}, projectSlug: 'first' }, io1)).rejects.toThrow(
      '__exit__:0',
    );
    expect(JSON.parse(await readFile(join(cwd, '.coodra', 'config.json'), 'utf8')).projectSlug).toBe('first');

    // Without --force, providing a different slug preserves the existing value.
    const { io: io2 } = makeIO();
    await expect(runInitCommand({ cwd, home, userHome, env: {}, projectSlug: 'second' }, io2)).rejects.toThrow(
      '__exit__:0',
    );
    expect(JSON.parse(await readFile(join(cwd, '.coodra', 'config.json'), 'utf8')).projectSlug).toBe('first');

    // With --force, baseline overwrites.
    const { io: io3 } = makeIO();
    await expect(
      runInitCommand({ cwd, home, userHome, env: {}, projectSlug: 'second', force: true }, io3),
    ).rejects.toThrow('__exit__:0');
    expect(JSON.parse(await readFile(join(cwd, '.coodra', 'config.json'), 'utf8')).projectSlug).toBe('second');
  });

  it('preserves an existing .mcp.json without adding Coodra during project init', async () => {
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'npx', args: ['something-else'] } } }),
    );
    const { io } = makeIO();
    await expect(runInitCommand({ cwd, home, userHome, env: {} }, io)).rejects.toThrow('__exit__:0');
    const existing = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'));
    expect(existing.mcpServers.other).toEqual({ command: 'npx', args: ['something-else'] });
    expect(existing.mcpServers.coodra).toBeUndefined();
  });

  it('--dry-run: prints outcomes but writes nothing', async () => {
    const { io, captured } = makeIO();
    await expect(runInitCommand({ cwd, home, userHome, env: {}, dryRun: true }, io)).rejects.toThrow('__exit__:0');
    // No project config written
    await expect(stat(join(cwd, '.coodra', 'config.json'))).rejects.toThrow();
    await expect(stat(join(cwd, '.coodra.json'))).rejects.toThrow();
    // No data.db written
    await expect(stat(join(home, 'data.db'))).rejects.toThrow();
    expect(captured.stdout.join('')).toContain('--dry-run was set');
  });

  it('detected agent config homes do not change project init output', async () => {
    await mkdir(join(userHome, '.codex'), { recursive: true });
    const { io, captured } = makeIO();
    await expect(runInitCommand({ cwd, home, userHome, env: {} }, io)).rejects.toThrow('__exit__:0');
    expect(captured.exit).toBe(0);

    expect(JSON.parse(await readFile(join(cwd, '.coodra', 'config.json'), 'utf8')).projectSlug).toBeDefined();
    await expect(stat(join(cwd, '.mcp.json'))).rejects.toThrow();
    await expect(stat(join(cwd, '.codex', 'config.toml'))).rejects.toThrow();
    await expect(stat(join(cwd, 'AGENTS.md'))).rejects.toThrow();
    expect(captured.stdout.join('')).toContain('Project init only creates project-local .coodra state');
    expect(captured.stdout.join('')).toContain('coodra agent add <agent>');
  });

  it('NO secrets-leaked invariant: init does not write forbidden production keys', async () => {
    const { io } = makeIO();
    await expect(runInitCommand({ cwd, home, userHome, env: {} }, io)).rejects.toThrow('__exit__:0');
    await expect(stat(join(cwd, '.env'))).rejects.toThrow();
    const envBody = await readFile(join(home, '.env'), 'utf8');
    for (const key of FORBIDDEN_INIT_KEYS) {
      // The key may appear nowhere; if it does appear, it must be absent or empty.
      const lineRe = new RegExp(`^${key}=(.*)$`, 'm');
      const match = lineRe.exec(envBody);
      if (match !== null) {
        expect(match[1]).toBe('');
      }
    }
  });

  it('Phase 3 Fix D: seeds default policy + rules in ~/.coodra/data.db', async () => {
    // Pre-Phase-3 init created the project row but inserted zero
    // policy_rules. The evaluator returned 'allow' for every
    // PreToolUse because no rule ever matched. This test opens the
    // freshly-initialised data.db and asserts the baseline rule
    // set is present and tagged with the canonical name.
    const { io } = makeIO();
    await expect(runInitCommand({ cwd, home, userHome, env: {} }, io)).rejects.toThrow('__exit__:0');

    const { createDb, sqliteSchema } = await import('@coodra/db');
    const { eq } = await import('drizzle-orm');
    const handle = createDb({ kind: 'local', sqlite: { path: join(home, 'data.db') } });
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    try {
      const policies = await handle.db
        .select({
          id: sqliteSchema.policies.id,
          name: sqliteSchema.policies.name,
          projectId: sqliteSchema.policies.projectId,
        })
        .from(sqliteSchema.policies)
        .where(eq(sqliteSchema.policies.name, '__default__'));
      expect(policies.length).toBe(1);

      const rules = await handle.db
        .select({
          priority: sqliteSchema.policyRules.priority,
          matchToolName: sqliteSchema.policyRules.matchToolName,
          matchPathGlob: sqliteSchema.policyRules.matchPathGlob,
          decision: sqliteSchema.policyRules.decision,
        })
        .from(sqliteSchema.policyRules)
        .where(eq(sqliteSchema.policyRules.policyId, policies[0]?.id ?? ''));
      expect(rules.length).toBeGreaterThan(0);

      const envWriteDeny = rules.find(
        (r) => r.matchToolName === 'Write' && r.matchPathGlob === '.env' && r.decision === 'deny',
      );
      expect(envWriteDeny).toBeDefined();

      // .git/** is a hygiene rule, not a security boundary — softened to
      // ask (2026-08-09), see ensure-default-policy.ts.
      const gitWriteAsk = rules.find(
        (r) => r.matchToolName === 'Write' && r.matchPathGlob === '.git/**' && r.decision === 'ask',
      );
      expect(gitWriteAsk).toBeDefined();

      const bashAsk = rules.find((r) => r.matchToolName === 'Bash' && r.decision === 'ask');
      expect(bashAsk).toBeDefined();
    } finally {
      handle.close();
    }
  });

  it('fails with EXIT_USER_RECOVERABLE when no project root marker is found', async () => {
    const isolated = await mkdtemp(join(tmpdir(), 'coodra-init-no-root-'));
    const sub = join(isolated, 'a', 'b');
    await mkdir(sub, { recursive: true });
    const { io, captured } = makeIO();
    await expect(runInitCommand({ cwd: sub, home, env: {} }, io)).rejects.toThrow('__exit__:1');
    expect(captured.exit).toBe(1);
    expect(captured.stderr.join('')).toMatch(/no project root marker found/);
  });

  it('creates the managed Graphify artifact directory without wiring Graphify MCP', async () => {
    const { io } = makeIO();
    await expect(runInitCommand({ cwd, home, userHome, env: {} }, io)).rejects.toThrow('__exit__:0');
    expect((await stat(join(cwd, '.coodra', 'graphify'))).isDirectory()).toBe(true);
    await expect(stat(join(cwd, '.mcp.json'))).rejects.toThrow();
    await expect(stat(join(cwd, 'docs/features/graphify-seed-packs'))).rejects.toThrow();
  });
});
