import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..', '..');
const distBin = resolve(cliRoot, 'dist', 'index.js');

/**
 * Cold-install end-to-end smoke test.
 *
 * Verifies the user's Phase 2 DoD line (decision dec_83ba10c1, 2026-05-02):
 *
 *   1. A reviewer in a clean directory runs `node <bundled-cli> init`.
 *   2. After init, the four artifacts are on disk:
 *      - `<cwd>/.mcp.json` — points at the bundled mcp-server
 *      - `<cwd>/.env`     — solo-mode sentinels
 *      - `<HOME>/.claude/settings.json` — five hook entries (post-Fix-G)
 *      - `<CONTEXTOS_HOME>/data.db` — migrations applied
 *   3. The path in `.mcp.json` is `node <abs-path>` and the abs path
 *      is a real file (the bundled mcp-server).
 *   4. Spawning that mcp-server binary with stdio + a JSON-RPC
 *      `initialize` produces a valid response (handshake works).
 *
 * This is the test that catches "published install path is broken"
 * regressions that the audit flagged.
 */

describe('cold install — bundled binary works end-to-end', () => {
  let cwd: string;
  let home: string;
  let claudeHome: string;

  beforeAll(async () => {
    const { existsSync } = await import('node:fs');
    if (!existsSync(distBin)) {
      throw new Error(
        `dist/index.js missing at ${distBin}. Run \`pnpm --filter @coodra/contextos-cli build\` before integration tests.`,
      );
    }
    const bundle = resolve(cliRoot, 'dist', 'runtime', 'mcp-server', 'index.js');
    if (!existsSync(bundle)) {
      throw new Error(
        `Bundle missing at ${bundle}. The CLI's build step bundles apps/{mcp-server,hooks-bridge}/dist into here.`,
      );
    }
  });

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'contextos-cold-install-cwd-'));
    home = await mkdtemp(join(tmpdir(), 'contextos-cold-install-home-'));
    // Mock $HOME → claudeHome so init's settings.json writer doesn't
    // touch the real ~/.claude on the dev machine.
    claudeHome = await mkdtemp(join(tmpdir(), 'contextos-cold-install-claude-home-'));
    await mkdir(join(claudeHome, '.claude'), { recursive: true });
    // Need a project-root marker so detectProjectRoot resolves to cwd.
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'cold-install-test' }));
  });

  afterEach(() => {
    /* tmp cleaned by OS */
  });

  it('init writes .mcp.json + .env + .contextos.json + ~/.claude/settings.json + data.db, all consistent', async () => {
    const result = await execa('node', [distBin, 'init', '--project-slug', 'cold-install'], {
      cwd,
      env: {
        ...process.env,
        CONTEXTOS_HOME: home,
        HOME: claudeHome,
        // Strip parent inherits that could leak into the test.
        CONTEXTOS_LOG_DESTINATION: undefined,
      },
      reject: false,
      timeout: 30_000,
    });
    expect(result.exitCode, `init exited non-zero. stderr=${String(result.stderr)}`).toBe(0);

    // 1) data.db + ~/.contextos/{logs,pids} exist and migrations applied.
    expect((await stat(join(home, 'data.db'))).isFile()).toBe(true);
    expect((await stat(join(home, 'logs'))).isDirectory()).toBe(true);
    expect((await stat(join(home, 'pids'))).isDirectory()).toBe(true);

    // 2) .contextos.json points at the slug.
    const contextosJson = JSON.parse(await readFile(join(cwd, '.contextos.json'), 'utf8'));
    expect(contextosJson.projectSlug).toBe('cold-install');

    // 3) .mcp.json shape: command=node, args[0] absolute and a real file.
    const mcpJson = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'));
    const entry = mcpJson.mcpServers.contextos;
    expect(entry.command).toBe('node');
    expect(Array.isArray(entry.args)).toBe(true);
    const binPath = entry.args[0] as string;
    expect(binPath.startsWith('/')).toBe(true);
    expect((await stat(binPath)).isFile()).toBe(true);
    // env carries the migrations override + log destination.
    expect(entry.env.CONTEXTOS_LOG_DESTINATION).toBe('stderr');
    expect(typeof entry.env.CONTEXTOS_MIGRATIONS_DIR).toBe('string');

    // 4) .env solo-mode sentinels.
    const envBody = await readFile(join(cwd, '.env'), 'utf8');
    expect(envBody).toContain('CONTEXTOS_MODE=solo');
    expect(envBody).toContain('CLERK_SECRET_KEY=sk_test_replace_me');
    expect(envBody).toMatch(/LOCAL_HOOK_SECRET=[0-9a-f]{64}/);

    // 5) ~/.claude/settings.json got five hook entries (post-Fix-G).
    const settingsPath = join(claudeHome, '.claude', 'settings.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
    // Phase 4 Fix G (Slice 2 — 2026-05-03 audit): SessionEnd registered
    // so real Claude Code POSTs SessionEnd → bridge flips runs.status to
    // completed AND auto-saves the Context Pack. Pre-Fix-G real sessions
    // accumulated as `in_progress` indefinitely.
    expect(settings.hooks.SessionEnd).toHaveLength(1);
    const ours = settings.hooks.SessionStart[0];
    // Phase 4 Fix F (2026-05-02): non-tool events omit `matcher` entirely.
    // Pre-Fix-F asserted `'__contextos__'` here, but the literal sentinel
    // never matched any tool. Fix F switched ownership detection to URL.
    expect(ours.matcher).toBeUndefined();
    expect(ours.hooks[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/hooks\/claude-code$/);
    expect(ours.hooks[0].headers['X-Local-Hook-Secret']).toBe('$LOCAL_HOOK_SECRET');
    // SessionEnd: same shape as SessionStart (no matcher, bridge URL).
    const sessionEnd = settings.hooks.SessionEnd[0];
    expect(sessionEnd.matcher).toBeUndefined();
    expect(sessionEnd.hooks[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/hooks\/claude-code$/);

    // 6) Phase 3 Fix C (2026-05-02): Feature Pack seeded with all
    // four files (meta.json + spec.md + implementation.md +
    // techstack.md) so MCP `get_feature_pack`'s Promise.all-on-read
    // does not throw ENOENT immediately after init.
    const featurePackDir = join(cwd, 'docs', 'feature-packs', 'cold-install');
    expect((await stat(join(featurePackDir, 'meta.json'))).isFile()).toBe(true);
    expect((await stat(join(featurePackDir, 'spec.md'))).isFile()).toBe(true);
    expect((await stat(join(featurePackDir, 'implementation.md'))).isFile()).toBe(true);
    expect((await stat(join(featurePackDir, 'techstack.md'))).isFile()).toBe(true);
  }, 30_000);

  it('the bundled mcp-server binary spawns and answers JSON-RPC initialize', async () => {
    // First, run init to lay down everything.
    await execa('node', [distBin, 'init', '--project-slug', 'cold-install-spawn'], {
      cwd,
      env: { ...process.env, CONTEXTOS_HOME: home, HOME: claudeHome, CONTEXTOS_LOG_DESTINATION: undefined },
      reject: false,
      timeout: 30_000,
    });

    const mcpJson = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'));
    const entry = mcpJson.mcpServers.contextos;
    const binPath = entry.args[0] as string;

    // Spawn the bundled mcp-server with stdio + send `initialize` and `tools/list`.
    const initializeMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cold-install-test', version: '1' },
      },
    });
    const initializedNotif = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    const toolsListMsg = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const stdin = `${initializeMsg}\n${initializedNotif}\n${toolsListMsg}\n`;

    const child = await execa('node', [binPath, '--transport', 'stdio'], {
      input: stdin,
      env: {
        ...entry.env,
        CONTEXTOS_HOME: home,
        CONTEXTOS_MODE: 'solo',
        CLERK_SECRET_KEY: 'sk_test_replace_me',
      },
      timeout: 10_000,
      reject: false,
    });
    const out = String(child.stdout);
    expect(out).toContain('"jsonrpc":"2.0"');
    expect(out).toContain('"id":1');
    // tools/list response includes the 9 ContextOS tools.
    expect(out).toContain('"name":"get_feature_pack"');
    expect(out).toContain('"name":"check_policy"');
    expect(out).toContain('"name":"save_context_pack"');
  }, 30_000);

  it('Phase 3 Fix C: get_feature_pack roundtrip succeeds against the freshly seeded pack', async () => {
    // Phase 2 verification (2026-04-28) found that pre-Fix-C init shipped
    // only meta.json + spec.md, while apps/mcp-server/src/lib/feature-pack.ts
    // reads all four files via Promise.all → ENOENT on missing. Every
    // fresh install had `get_feature_pack` broken until the user
    // hand-authored implementation.md + techstack.md. Fix C seeds all
    // four; this test exercises the MCP roundtrip end-to-end.
    await execa('node', [distBin, 'init', '--project-slug', 'cold-install-fpack'], {
      cwd,
      env: { ...process.env, CONTEXTOS_HOME: home, HOME: claudeHome, CONTEXTOS_LOG_DESTINATION: undefined },
      reject: false,
      timeout: 30_000,
    });

    const mcpJson = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'));
    const entry = mcpJson.mcpServers.contextos;
    const binPath = entry.args[0] as string;

    const initializeMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fpack-test', version: '1' } },
    });
    const initializedNotif = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    const callMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'get_feature_pack',
        arguments: { projectSlug: 'cold-install-fpack' },
      },
    });
    const stdin = `${initializeMsg}\n${initializedNotif}\n${callMsg}\n`;

    const child = await execa('node', [binPath, '--transport', 'stdio'], {
      input: stdin,
      cwd,
      env: {
        ...entry.env,
        CONTEXTOS_HOME: home,
        CONTEXTOS_MODE: 'solo',
        CLERK_SECRET_KEY: 'sk_test_replace_me',
      },
      timeout: 10_000,
      reject: false,
    });
    const out = String(child.stdout);
    expect(out).toContain('"id":2');
    // The handler should NOT have thrown ENOENT — pre-Fix-C the
    // Promise.all on the 4 file reads would reject before returning a
    // tool result. Post-Fix-C the call returns successfully and the
    // body includes the slug echo from meta.json.
    expect(out).not.toContain('ENOENT');
    expect(out).toContain('cold-install-fpack');
  }, 30_000);
});
