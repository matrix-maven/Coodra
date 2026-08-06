import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEVIN_PLUGIN_NAME,
  type DevinCliRunner,
  devinPluginPaths,
  installDevinPlugin,
  probeDevinPlugin,
  removeDevinPlugin,
} from '../../../src/lib/agents/devin-plugin.js';
import type { AgentContext, AgentRemoveContext } from '../../../src/lib/agents/types.js';

/**
 * Unlike `cursor-plugin.test.ts`, Devin's install/remove go through a
 * real CLI runner (mirroring `codex-plugin.test.ts`) — so most tests
 * here inject a fake `DevinCliRunner` rather than exercising pure
 * filesystem writes alone.
 */
function fakeCliRunner(overrides: Partial<DevinCliRunner> = {}): DevinCliRunner {
  return {
    detect: async () => ({ path: '/fake/bin/devin', viaPath: true }),
    authStatus: async () => true,
    installPlugin: async () => ({ ok: true }),
    removePlugin: async () => ({ ok: true }),
    isInstalled: async () => true,
    ...overrides,
  };
}

function noDevinCli(): DevinCliRunner {
  return {
    detect: async () => null,
    authStatus: async () => {
      throw new Error('unexpected: devin CLI should not be invoked in this test');
    },
    installPlugin: async () => {
      throw new Error('unexpected: devin CLI should not be invoked in this test');
    },
    removePlugin: async () => {
      throw new Error('unexpected: devin CLI should not be invoked in this test');
    },
    isInstalled: async () => {
      throw new Error('unexpected: devin CLI should not be invoked in this test');
    },
  };
}

describe('Devin native plugin installer', () => {
  let userHome: string;
  let cwd: string;
  let coodraHome: string;

  beforeEach(async () => {
    userHome = await mkdtemp(join(tmpdir(), 'coodra-devin-plugin-home-'));
    cwd = await mkdtemp(join(tmpdir(), 'coodra-devin-plugin-cwd-'));
    coodraHome = await mkdtemp(join(tmpdir(), 'coodra-devin-plugin-data-'));
  });

  function ctx(overrides: Partial<AgentContext> = {}): AgentContext {
    return {
      cwd,
      userHome,
      projectSlug: 'demo',
      bridgePort: 3101,
      localHookSecret: 'local-secret',
      mcpEntryOptions: {
        mcpServerBin: '/tmp/coodra-mcp-server.js',
        clerkSecretKey: 'sk_test',
        migrationsDir: null,
        coodraHome,
        localHookSecret: 'local-secret',
      },
      force: false,
      dryRun: false,
      ...overrides,
    };
  }

  it('writes the plugin source under ~/.coodra/devin-plugins/coodra/ — no marketplace subdirectory', async () => {
    const paths = devinPluginPaths(userHome, coodraHome);
    expect(paths.pluginRoot).toBe(join(coodraHome, 'devin-plugins', 'coodra'));
    expect(paths.manifestPath).toBe(join(paths.pluginRoot, '.devin-plugin', 'plugin.json'));
    expect(paths.mcpPath).toBe(join(paths.pluginRoot, 'mcp_config.json'));
    expect(paths.hooksPath).toBe(join(paths.pluginRoot, 'hooks.json'));

    await installDevinPlugin(ctx(), fakeCliRunner());

    const manifest = JSON.parse(await readFile(paths.manifestPath, 'utf8')) as {
      name: string;
      mcpServers: string;
      skills: string;
    };
    expect(manifest.name).toBe(DEVIN_PLUGIN_NAME);
    expect(manifest.mcpServers).toBe('./mcp_config.json');
    expect(manifest.skills).toBe('./skills/');
  });

  it('writes a native plugin bundle with Coodra and managed Graphify MCP servers, and root-level hooks.json', async () => {
    const paths = devinPluginPaths(userHome, coodraHome);
    await installDevinPlugin(ctx(), fakeCliRunner());

    const mcp = JSON.parse(await readFile(paths.mcpPath, 'utf8')) as {
      mcpServers: {
        coodra?: { command?: string; env?: Record<string, string> };
        graphify?: { command?: string; args?: string[] };
      };
    };
    expect(mcp.mcpServers.coodra?.env?.COODRA_AGENT_TYPE).toBe('devin');
    expect(mcp.mcpServers.graphify?.command).toBe(join(coodraHome, 'graphify-mcp', '.venv', 'bin', 'python'));

    const hooks = JSON.parse(await readFile(paths.hooksPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(hooks).sort()).toEqual([
      'PermissionRequest',
      'PostCompaction',
      'PostToolUse',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
    // No PreCompact/SubagentStart/SubagentStop/PermissionDenied/
    // PostToolUseFailure/StopFailure/ConfigChange — Devin has no
    // equivalent event for any of these.
    for (const absent of ['PreCompact', 'SubagentStart', 'SubagentStop', 'ConfigChange']) {
      expect(hooks).not.toHaveProperty(absent);
    }

    const hookRunner = await readFile(paths.hookRunnerPath, 'utf8');
    expect(hookRunner).toContain("agentType: 'devin'");
    expect(hookRunner).toContain("method: 'tools/call'");
    expect(hookRunner).toContain('DEVIN_PROJECT_DIR');

    expect(await readFile(join(paths.skillsRoot, 'coodra-context', 'SKILL.md'), 'utf8')).toContain(
      'name: coodra-context',
    );
    const graphifySkill = await readFile(join(paths.skillsRoot, 'coodra-graphify', 'SKILL.md'), 'utf8');
    expect(graphifySkill).toContain('Do not inspect or print environment variables');
  });

  it("preToolUse/postToolUse/permissionRequest matcher reaches third-party MCP tools while excluding Coodra's own two managed servers (mcp__ prefix shape, same as Claude/Codex)", async () => {
    const paths = devinPluginPaths(userHome, coodraHome);
    await installDevinPlugin(ctx(), fakeCliRunner());
    const hooks = JSON.parse(await readFile(paths.hooksPath, 'utf8')) as Record<string, Array<{ matcher?: string }>>;
    const matcher = hooks.PreToolUse?.[0]?.matcher;
    expect(matcher).toBeDefined();
    expect(hooks.PostToolUse?.[0]?.matcher).toBe(matcher);
    expect(hooks.PermissionRequest?.[0]?.matcher).toBe(matcher);
    if (matcher === undefined) return;
    const re = new RegExp(matcher);
    expect(re.test('write')).toBe(true);
    expect(re.test('exec')).toBe(true);
    expect(re.test('read')).toBe(false);
    expect(re.test('grep')).toBe(false);
    expect(re.test('mcp__github__create_issue')).toBe(true);
    expect(re.test('mcp__coodra__get_run_id')).toBe(false);
    expect(re.test('mcp__graphify__query_graph')).toBe(false);
  });

  it('installDevinPlugin attempts the real install unconditionally — never pre-gates on authStatus', async () => {
    let installCalled = false;
    let authStatusCalled = false;
    const runner = fakeCliRunner({
      authStatus: async () => {
        authStatusCalled = true;
        return false;
      },
      installPlugin: async () => {
        installCalled = true;
        return { ok: true };
      },
    });
    const result = await installDevinPlugin(ctx(), runner);
    expect(installCalled).toBe(true);
    expect(authStatusCalled).toBe(false);
    expect(result.outcomes.some((o) => o.notes?.includes("installed via 'devin plugins install'"))).toBe(true);
  });

  it('installDevinPlugin surfaces the real CLI failure reason (e.g. a not-logged-in error) rather than guessing', async () => {
    const runner = fakeCliRunner({
      installPlugin: async () => ({ ok: false, reason: 'You must be logged in to manage Devin CLI plugins.' }),
    });
    const result = await installDevinPlugin(ctx(), runner);
    const outcome = result.outcomes.find((o) => o.notes?.includes('devin plugins install'));
    expect(outcome?.action).toBe('unchanged');
    expect(outcome?.notes).toContain('You must be logged in to manage Devin CLI plugins.');
    expect(outcome?.notes).toContain('devin auth login');
  });

  it('installDevinPlugin reports a clear message when the CLI is not found at all', async () => {
    const result = await installDevinPlugin(ctx(), noDevinCli());
    const outcome = result.outcomes.find((o) => o.notes?.includes('devin CLI not found'));
    expect(outcome).toBeDefined();
    expect(outcome?.notes).toContain('coodra agent add devin');
  });

  it('removeDevinPlugin: CLI unregister succeeds → source directory is removed', async () => {
    const paths = devinPluginPaths(userHome, coodraHome);
    const runner = fakeCliRunner();
    await installDevinPlugin(ctx(), runner);
    expect(existsSync(paths.pluginRoot)).toBe(true);

    const removeCtx: AgentRemoveContext = { cwd, userHome, coodraHome, bridgePort: 3101, dryRun: false };
    const result = await removeDevinPlugin(removeCtx, runner);
    expect(existsSync(paths.pluginRoot)).toBe(false);
    expect(result.outcomes[0]?.action).toBe('merged');
  });

  it('removeDevinPlugin: CLI unregister fails (e.g. an auth error) → source directory is preserved, failure reported', async () => {
    const paths = devinPluginPaths(userHome, coodraHome);
    const installRunner = fakeCliRunner();
    await installDevinPlugin(ctx(), installRunner);
    expect(existsSync(paths.pluginRoot)).toBe(true);

    const removeRunner = fakeCliRunner({
      removePlugin: async () => ({ ok: false, reason: 'You must be logged in to manage Devin CLI plugins.' }),
    });
    const removeCtx: AgentRemoveContext = { cwd, userHome, coodraHome, bridgePort: 3101, dryRun: false };
    const result = await removeDevinPlugin(removeCtx, removeRunner);
    // Source is preserved — deleting it would leave Devin's registration
    // pointing at a path that no longer exists.
    expect(existsSync(paths.pluginRoot)).toBe(true);
    expect(result.outcomes[0]?.action).toBe('unchanged');
    expect(result.outcomes[0]?.notes).toContain('You must be logged in to manage Devin CLI plugins.');
    expect(result.outcomes[0]?.notes).toContain('devin auth login');
  });

  it('removeDevinPlugin: CLI not found → source directory is preserved, failure reported', async () => {
    const paths = devinPluginPaths(userHome, coodraHome);
    await installDevinPlugin(ctx(), fakeCliRunner());
    expect(existsSync(paths.pluginRoot)).toBe(true);

    const removeCtx: AgentRemoveContext = { cwd, userHome, coodraHome, bridgePort: 3101, dryRun: false };
    const result = await removeDevinPlugin(removeCtx, noDevinCli());
    expect(existsSync(paths.pluginRoot)).toBe(true);
    expect(result.outcomes[0]?.action).toBe('unchanged');
  });

  it('removeDevinPlugin --dry-run leaves the plugin directory in place', async () => {
    const paths = devinPluginPaths(userHome, coodraHome);
    const runner = fakeCliRunner();
    await installDevinPlugin(ctx(), runner);
    const removeCtx: AgentRemoveContext = { cwd, userHome, coodraHome, bridgePort: 3101, dryRun: true };
    await removeDevinPlugin(removeCtx, runner);
    expect(existsSync(paths.pluginRoot)).toBe(true);
  });

  it('--dry-run touches nothing on disk', async () => {
    const paths = devinPluginPaths(userHome, coodraHome);
    await installDevinPlugin(ctx({ dryRun: true }), fakeCliRunner());
    expect(existsSync(paths.pluginRoot)).toBe(false);
  });

  it('force overwrites a drifted manifest; without --force it leaves local edits alone', async () => {
    const paths = devinPluginPaths(userHome, coodraHome);
    const runner = fakeCliRunner();
    await installDevinPlugin(ctx(), runner);
    await writeFile(paths.manifestPath, JSON.stringify({ name: 'drifted' }), 'utf8');

    const unforced = await installDevinPlugin(ctx(), runner);
    expect(unforced.outcomes.find((o) => o.path === paths.manifestPath)?.action).toBe('unchanged');
    expect(JSON.parse(await readFile(paths.manifestPath, 'utf8'))).toEqual({ name: 'drifted' });

    const forced = await installDevinPlugin(ctx({ force: true }), runner);
    expect(forced.outcomes.find((o) => o.path === paths.manifestPath)?.action).toBe('forced');
    expect(JSON.parse(await readFile(paths.manifestPath, 'utf8'))).toMatchObject({ name: DEVIN_PLUGIN_NAME });
  });

  it('probeDevinPlugin reports missing before install and fully wired after (registration reflects the CLI runner)', async () => {
    // probeDevinPlugin resolves paths via devinPluginPaths(ctx.userHome)
    // with NO coodraHome override (AgentPathContext carries no such
    // field) — the same default codexPluginPaths/probeCodexPlugin uses.
    // Install with a matching default so file-based probing lines up
    // with where probeDevinPlugin actually looks.
    const defaultCoodraHome = join(userHome, '.coodra');
    const installCtx = ctx({ mcpEntryOptions: { ...ctx().mcpEntryOptions, coodraHome: defaultCoodraHome } });

    const before = await probeDevinPlugin({ cwd, userHome }, noDevinCli());
    expect(before).toMatchObject({ manifest: false, mcp: false, hooks: false, skills: false, registered: false });

    await installDevinPlugin(installCtx, fakeCliRunner());
    const after = await probeDevinPlugin({ cwd, userHome }, fakeCliRunner());
    expect(after).toMatchObject({ manifest: true, mcp: true, hooks: true, skills: true, registered: true });
  });
});
