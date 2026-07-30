import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..', '..');
const distBin = resolve(cliRoot, 'dist', 'index.js');
const mcpBundle = resolve(cliRoot, 'dist', 'runtime', 'mcp-server', 'index.js');

/**
 * Cold-install end-to-end smoke test.
 *
 * Verifies the user's Phase 2 DoD line (decision dec_83ba10c1, 2026-05-02):
 *
 *   1. A reviewer in a clean directory runs `node <bundled-cli> install`,
 *      then `node <bundled-cli> init`.
 *   2. After the split setup, the machine runtime artifacts and project-local
 *      `.coodra/` layout are on disk.
 *   3. Project init does not write agent config surfaces (`.mcp.json`,
 *      `~/.claude/settings.json`, `.codex/config.toml`, etc.).
 *   4. Spawning the bundled mcp-server binary with stdio + a JSON-RPC
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
        `dist/index.js missing at ${distBin}. Run \`pnpm --filter @coodra/cli build\` before integration tests.`,
      );
    }
    if (!existsSync(mcpBundle)) {
      throw new Error(
        `Bundle missing at ${mcpBundle}. The CLI's build step bundles apps/{mcp-server,hooks-bridge}/dist into here.`,
      );
    }
  });

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-cold-install-cwd-'));
    home = await mkdtemp(join(tmpdir(), 'coodra-cold-install-home-'));
    // Mock $HOME so the smoke cannot touch real machine agent config homes.
    claudeHome = await mkdtemp(join(tmpdir(), 'coodra-cold-install-claude-home-'));
    await mkdir(join(claudeHome, '.claude'), { recursive: true });
    // Need a project-root marker so detectProjectRoot resolves to cwd.
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'cold-install-test' }));
  });

  afterEach(() => {
    /* tmp cleaned by OS */
  });

  it('install + init write runtime state and project-local .coodra layout without agent config files', async () => {
    const install = await execa('node', [distBin, 'install'], {
      cwd,
      env: {
        ...process.env,
        COODRA_HOME: home,
        HOME: claudeHome,
        // Strip parent inherits that could leak into the test.
        COODRA_LOG_DESTINATION: undefined,
      },
      reject: false,
      timeout: 30_000,
    });
    expect(install.exitCode, `install exited non-zero. stderr=${String(install.stderr)}`).toBe(0);

    const result = await execa('node', [distBin, 'init', '--project-slug', 'cold-install'], {
      cwd,
      env: {
        ...process.env,
        COODRA_HOME: home,
        HOME: claudeHome,
        // Strip parent inherits that could leak into the test.
        COODRA_LOG_DESTINATION: undefined,
      },
      reject: false,
      timeout: 30_000,
    });
    expect(result.exitCode, `init exited non-zero. stderr=${String(result.stderr)}`).toBe(0);

    // 1) data.db + ~/.coodra/{logs,pids} exist and migrations applied.
    expect((await stat(join(home, 'data.db'))).isFile()).toBe(true);
    expect((await stat(join(home, 'logs'))).isDirectory()).toBe(true);
    expect((await stat(join(home, 'pids'))).isDirectory()).toBe(true);

    // 2) .coodra/config.json points at the slug; root .coodra.json is not written.
    const projectConfig = JSON.parse(await readFile(join(cwd, '.coodra', 'config.json'), 'utf8'));
    expect(projectConfig.projectSlug).toBe('cold-install');
    await expect(stat(join(cwd, '.coodra.json'))).rejects.toThrow();
    expect((await stat(join(cwd, '.coodra', 'skill-packs'))).isDirectory()).toBe(true);
    expect((await stat(join(cwd, '.coodra', 'graphify'))).isDirectory()).toBe(true);
    expect((await stat(join(cwd, '.coodra', 'wiki'))).isDirectory()).toBe(true);
    await expect(stat(join(cwd, '.mcp.json'))).rejects.toThrow();
    await expect(stat(join(cwd, '.codex', 'config.toml'))).rejects.toThrow();

    // 4) Coodra runtime config lives in COODRA_HOME, not the user's
    // project .env. The bridge / mcp-server boot path defaults to
    // solo when COODRA_MODE is absent.
    await expect(stat(join(cwd, '.env'))).rejects.toThrow();
    const envBody = await readFile(join(home, '.env'), 'utf8');
    expect(envBody).not.toContain('COODRA_MODE=');
    expect(envBody).toMatch(/LOCAL_HOOK_SECRET=[0-9a-f]{64}/);
    expect(envBody).toContain('MCP_SERVER_PORT=3100');
    expect(envBody).toContain('HOOKS_BRIDGE_PORT=3101');

    await expect(stat(join(claudeHome, '.claude', 'settings.json'))).rejects.toThrow();
    await expect(stat(join(cwd, 'docs', 'feature-packs', 'cold-install'))).rejects.toThrow();
  }, 30_000);

  it('the bundled mcp-server binary spawns and answers JSON-RPC initialize', async () => {
    // First, run init to lay down everything.
    await execa('node', [distBin, 'init', '--project-slug', 'cold-install-spawn'], {
      cwd,
      env: { ...process.env, COODRA_HOME: home, HOME: claudeHome, COODRA_LOG_DESTINATION: undefined },
      reject: false,
      timeout: 30_000,
    });

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

    const child = await execa('node', [mcpBundle, '--transport', 'stdio'], {
      input: stdin,
      env: {
        ...process.env,
        COODRA_HOME: home,
        COODRA_MODE: 'solo',
        CLERK_SECRET_KEY: 'sk_test_replace_me',
      },
      timeout: 10_000,
      reject: false,
    });
    const out = String(child.stdout);
    expect(out).toContain('"jsonrpc":"2.0"');
    expect(out).toContain('"id":1');
    // tools/list response includes the 9 Coodra tools.
    expect(out).toContain('"name":"get_feature_pack"');
    expect(out).toContain('"name":"check_policy"');
    expect(out).toContain('"name":"save_context_pack"');
  }, 30_000);
});
