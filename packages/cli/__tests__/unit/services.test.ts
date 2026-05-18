import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveServices, SERVICES } from '../../src/lib/services.js';

describe('SERVICES descriptor', () => {
  it('declares mcp-server + hooks-bridge + sync-daemon + web (M04a S4 + W1 2026-05-13)', () => {
    const names = SERVICES.map((s) => s.name);
    expect(names).toEqual(['mcp-server', 'hooks-bridge', 'sync-daemon', 'web']);

    const mcp = SERVICES.find((s) => s.name === 'mcp-server');
    if (mcp?.kind !== 'http') throw new Error('mcp-server should be http kind');
    expect(mcp.defaultPort).toBe(3100);
    expect(mcp.healthUrl(3100)).toBe('http://127.0.0.1:3100/healthz');

    const bridge = SERVICES.find((s) => s.name === 'hooks-bridge');
    if (bridge?.kind !== 'http') throw new Error('hooks-bridge should be http kind');
    expect(bridge.defaultPort).toBe(3101);
    expect(bridge.healthUrl(3101)).toBe('http://127.0.0.1:3101/healthz');

    const sync = SERVICES.find((s) => s.name === 'sync-daemon');
    if (sync?.kind !== 'worker') throw new Error('sync-daemon should be worker kind');
    expect(sync.requiresTeamMode).toBe(true);
    expect(sync.relativeEntry).toBe('apps/sync-daemon/dist/index.js');

    // Web Bundle W1 (2026-05-13) — Next.js standalone bundled inside the
    // CLI tarball; runs in both modes; /api/healthz is the supervisor probe.
    const web = SERVICES.find((s) => s.name === 'web');
    if (web?.kind !== 'http') throw new Error('web should be http kind');
    expect(web.defaultPort).toBe(3001);
    expect(web.healthUrl(3001)).toBe('http://127.0.0.1:3001/api/healthz');
  });
});

describe('resolveServices — team-mode gating (M04a S4)', () => {
  it('omits sync-daemon when COODRA_MODE is solo', async () => {
    const resolved = await resolveServices({
      coodraHome: '/var/test/.coodra',
      env: { COODRA_MODE: 'solo' } as NodeJS.ProcessEnv,
    });
    const names = resolved.map((r) => r.descriptor.name);
    expect(names).not.toContain('sync-daemon');
    expect(names).toEqual(expect.arrayContaining(['mcp-server', 'hooks-bridge']));
  });

  it('includes sync-daemon when COODRA_MODE is team', async () => {
    const resolved = await resolveServices({
      coodraHome: '/var/test/.coodra',
      env: { COODRA_MODE: 'team', DATABASE_URL: 'postgres://x:y@h/d' } as NodeJS.ProcessEnv,
    });
    const names = resolved.map((r) => r.descriptor.name);
    expect(names).toContain('sync-daemon');
    const sync = resolved.find((r) => r.descriptor.name === 'sync-daemon');
    expect(sync?.port).toBeNull();
    expect(sync?.unit.env.DATABASE_URL).toBe('postgres://x:y@h/d');
  });
});

/**
 * Locks the 2026-05-18 macOS healthcheck regression: HOSTNAME used to be
 * `localhost`, which macOS getaddrinfo resolves IPv6-first → Next.js 15.5
 * bound only `::1:3001` → the CLI's IPv4 healthcheck failed → `coodra
 * start` reported "Web did not become healthy" even though Next was up.
 * Pinning to the IPv4 literal eliminates the resolver dependency. Any
 * future change away from `127.0.0.1` must restore IPv4 reachability AND
 * keep loopback-only binding (no LAN exposure).
 */
describe('resolveServices — web service env (2026-05-18 regression)', () => {
  it('stamps HOSTNAME=127.0.0.1, PORT, NODE_ENV=production on the web DaemonUnit', async () => {
    const resolved = await resolveServices({
      coodraHome: '/var/test/.coodra',
      env: {} as NodeJS.ProcessEnv,
    });
    const web = resolved.find((r) => r.descriptor.name === 'web');
    expect(web).toBeDefined();
    expect(web?.unit.env.HOSTNAME).toBe('127.0.0.1');
    expect(web?.unit.env.PORT).toBe('3001');
    expect(web?.unit.env.NODE_ENV).toBe('production');
  });
});

/**
 * Locks integration finding 2026-04-27 (post-08a walk): the daemon manager
 * was spawning bridge + mcp-server with stderr → /dev/null (launchd default).
 * Doctor check 8 (F15 spot-check) could never green and field debugging was
 * blind. resolveServices now stamps stdoutPath/stderrPath on every DaemonUnit
 * pointing into <coodra-home>/logs/<name>.log.
 */
describe('resolveServices — log routing', () => {
  it('stamps stdoutPath + stderrPath on every DaemonUnit so doctor check 8 has logs to read', async () => {
    const resolved = await resolveServices({
      coodraHome: '/var/test/.coodra',
      env: { MCP_SERVER_PORT: '3100', HOOKS_BRIDGE_PORT: '3101' },
    });
    const mcp = resolved.find((s) => s.descriptor.name === 'mcp-server');
    const bridge = resolved.find((s) => s.descriptor.name === 'hooks-bridge');
    expect(mcp?.unit.stdoutPath).toBe('/var/test/.coodra/logs/mcp-server.log');
    expect(mcp?.unit.stderrPath).toBe('/var/test/.coodra/logs/mcp-server.log');
    expect(bridge?.unit.stdoutPath).toBe('/var/test/.coodra/logs/hooks-bridge.log');
    expect(bridge?.unit.stderrPath).toBe('/var/test/.coodra/logs/hooks-bridge.log');
  });
});

/**
 * Regression: the daemon-spawn env was built from a hardcoded keylist that
 * (a) ignored the `<COODRA_HOME>/.env` file `init` writes and
 * (b) drifted from baseEnvSchema additions. Result: out-of-the-box solo
 * worked only because `COODRA_MODE` defaults to 'solo' in the schema;
 * team-mode setups silently fell back to solo. These tests pin the new
 * pattern: home .env is read, every COODRA_xxx and CLERK_xxx plus
 * LOCAL_HOOK_SECRET are forwarded, RESERVED daemon-internal keys can't be
 * overridden.
 */
describe('resolveServices — env layering', () => {
  let tmpHome: string;
  let cleanCwd: string;
  let cwdSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'coodra-services-test-'));
    mkdirSync(join(tmpHome, 'logs'), { recursive: true });
    // Layered loader (post-Finding-A) reads `<process.cwd()>/.env` too.
    // Mock cwd to a freshly-created tmp dir with no .env so these tests
    // are deterministic regardless of where vitest runs from.
    // Without this, running from a real Coodra checkout (which has its
    // own .env at the workspace root) leaks CLERK_SECRET_KEY into the
    // "absent .env file is non-fatal" assertion.
    cleanCwd = mkdtempSync(join(tmpdir(), 'coodra-services-cwd-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cleanCwd);
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    cwdSpy = null;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(cleanCwd, { recursive: true, force: true });
  });

  it('dotenv-loads <COODRA_HOME>/.env and forwards keys to the daemon unit env', async () => {
    writeFileSync(
      join(tmpHome, '.env'),
      [
        'COODRA_MODE=solo',
        'CLERK_SECRET_KEY=sk_test_replace_me',
        'CLERK_PUBLISHABLE_KEY=pk_test_replace_me',
        `LOCAL_HOOK_SECRET=${'a'.repeat(40)}`,
        'COODRA_GRAPHIFY_ROOT=/var/graphify-override',
      ].join('\n'),
      'utf8',
    );
    const resolved = await resolveServices({ coodraHome: tmpHome, env: {} });
    const mcp = resolved.find((s) => s.descriptor.name === 'mcp-server');
    const bridge = resolved.find((s) => s.descriptor.name === 'hooks-bridge');

    for (const unit of [mcp?.unit, bridge?.unit] as const) {
      expect(unit?.env.COODRA_MODE).toBe('solo');
      expect(unit?.env.CLERK_SECRET_KEY).toBe('sk_test_replace_me');
      expect(unit?.env.CLERK_PUBLISHABLE_KEY).toBe('pk_test_replace_me');
      expect(unit?.env.LOCAL_HOOK_SECRET).toBe('a'.repeat(40));
      // Pattern-match: arbitrary COODRA_* additions flow through.
      expect(unit?.env.COODRA_GRAPHIFY_ROOT).toBe('/var/graphify-override');
    }
  });

  it('process.env wins over .env for matching keys (`MCP_SERVER_PORT=3200 coodra start` overrides file)', async () => {
    writeFileSync(join(tmpHome, '.env'), 'COODRA_MODE=solo\nCLERK_SECRET_KEY=sk_test_from_file\n', 'utf8');
    const resolved = await resolveServices({
      coodraHome: tmpHome,
      env: { CLERK_SECRET_KEY: 'sk_test_from_shell' },
    });
    expect(resolved[0]?.unit.env.CLERK_SECRET_KEY).toBe('sk_test_from_shell');
    expect(resolved[0]?.unit.env.COODRA_MODE).toBe('solo');
  });

  it('RESERVED daemon-internal keys (COODRA_HOME, port, transport, host) cannot be overridden by .env', async () => {
    writeFileSync(
      join(tmpHome, '.env'),
      [
        'COODRA_HOME=/wrong/place',
        'COODRA_LOG_DESTINATION=stdout',
        'MCP_SERVER_TRANSPORT=stdio',
        'MCP_SERVER_HOST=0.0.0.0',
        'HOOKS_BRIDGE_HOST=0.0.0.0',
      ].join('\n'),
      'utf8',
    );
    const resolved = await resolveServices({ coodraHome: tmpHome, env: {} });
    const mcp = resolved.find((s) => s.descriptor.name === 'mcp-server');
    const bridge = resolved.find((s) => s.descriptor.name === 'hooks-bridge');
    expect(mcp?.unit.env.COODRA_HOME).toBe(tmpHome);
    expect(mcp?.unit.env.COODRA_LOG_DESTINATION).toBe('stderr');
    expect(mcp?.unit.env.MCP_SERVER_TRANSPORT).toBe('http');
    expect(mcp?.unit.env.MCP_SERVER_HOST).toBe('127.0.0.1');
    expect(bridge?.unit.env.HOOKS_BRIDGE_HOST).toBe('127.0.0.1');
  });

  it('absent .env file is non-fatal — daemon still spawns with computed env', async () => {
    // No .env written under tmpHome.
    const resolved = await resolveServices({ coodraHome: tmpHome, env: {} });
    const mcp = resolved.find((s) => s.descriptor.name === 'mcp-server');
    expect(mcp?.unit.env.COODRA_HOME).toBe(tmpHome);
    expect(mcp?.unit.env.CLERK_SECRET_KEY).toBeUndefined();
  });

  it('unrelated process.env keys are NOT forwarded (no shell-leak)', async () => {
    const resolved = await resolveServices({
      coodraHome: tmpHome,
      env: { PATH: '/usr/bin', HOME: '/Users/x', AWS_SECRET_ACCESS_KEY: 'should-not-leak' },
    });
    const mcp = resolved.find((s) => s.descriptor.name === 'mcp-server');
    expect(mcp?.unit.env.PATH).toBeUndefined();
    expect(mcp?.unit.env.HOME).toBeUndefined();
    expect(mcp?.unit.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});

/**
 * Regression / contract update (decision dec_83ba10c1, 2026-05-02):
 *
 * Pre-fix, `resolveServices` walked up from `process.cwd()` only, looking
 * for `pnpm-workspace.yaml`, and threw outright when no monorepo was
 * found — directly contradicting init's "→ Run `coodra start`" next-
 * step message after a freshly-init'd project.
 *
 * Post-fix (commit a0fde…): the resolver tried `fileURLToPath(import.meta.
 * url)` (the CLI's own install location, always inside the monorepo)
 * BEFORE cwd. That patched the workspace-dev case but still required
 * the CLI to live inside a monorepo at runtime — useless for the
 * `npm i -g @coodra/cli` deployment.
 *
 * Now: `resolveServices` delegates to `lib/runtime-paths.ts::
 * resolveRuntimeBinary`, which prefers bundled artifacts shipped inside
 * `@coodra/cli/dist/runtime/<app>/index.js` and falls back to
 * `apps/<app>/dist/index.js` only when the bundle is absent (workspace
 * dev). `workingDir` is now `process.cwd()` because the daemons are
 * env-driven and don't care about cwd; anchoring to the user's project
 * directory keeps any accidental relative-path lookup sensible.
 *
 * The two assertions here pin the new contract:
 *   1. bundled-wins: when `@coodra/cli` was built (dist/runtime/
 *      exists), every entryPath resolves to that bundle, not the
 *      monorepo apps dist tree.
 *   2. workingDir is process.cwd().
 */
describe('resolveServices — runtime resolution prefers bundled', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let cwdSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'coodra-cwd-test-home-'));
    mkdirSync(join(tmpHome, 'logs'), { recursive: true });
    tmpCwd = mkdtempSync(join(tmpdir(), 'coodra-cwd-test-cwd-'));
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    cwdSpy = null;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('resolves the bundled runtime when the CLI dist/runtime tree exists, regardless of cwd', async () => {
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpCwd);

    const resolved = await resolveServices({ coodraHome: tmpHome, env: {} });
    const mcp = resolved.find((s) => s.descriptor.name === 'mcp-server');
    const bridge = resolved.find((s) => s.descriptor.name === 'hooks-bridge');

    // dec_83ba10c1: bundled artifacts always win over monorepo paths.
    // We assert the entryPath ends with the runtime bundle layout and
    // that the working dir is the user's cwd (anchored, not the
    // pre-fix repo root).
    expect(mcp?.entryPath).toMatch(/\/runtime\/mcp-server\/index\.js$/);
    expect(bridge?.entryPath).toMatch(/\/runtime\/hooks-bridge\/index\.js$/);
    expect(mcp?.entryPath.startsWith(tmpCwd)).toBe(false);
    expect(mcp?.unit.workingDir).toBe(tmpCwd);
  });
});
