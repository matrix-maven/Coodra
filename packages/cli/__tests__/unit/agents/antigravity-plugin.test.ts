import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_PLUGIN_NAME,
  antigravityPluginPaths,
  installAntigravityPlugin,
  probeAntigravityPlugin,
  removeAntigravityPlugin,
} from '../../../src/lib/agents/antigravity-plugin.js';
import type { AgentContext, AgentRemoveContext } from '../../../src/lib/agents/types.js';

/**
 * No CLI runner, same as `cursor-plugin.test.ts` — Antigravity's plugin
 * model needs neither a CLI nor login, unlike Codex's/Devin's real CLI
 * calls.
 */
describe('Antigravity native plugin installer', () => {
  let userHome: string;
  let cwd: string;
  let coodraHome: string;

  beforeEach(async () => {
    userHome = await mkdtemp(join(tmpdir(), 'coodra-antigravity-plugin-home-'));
    cwd = await mkdtemp(join(tmpdir(), 'coodra-antigravity-plugin-cwd-'));
    coodraHome = await mkdtemp(join(tmpdir(), 'coodra-antigravity-plugin-data-'));
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

  it('writes the plugin source under ~/.gemini/config/plugins/coodra/ — plugin.json at the root, not a dotfolder', async () => {
    const paths = antigravityPluginPaths(userHome);
    expect(paths.pluginRoot).toBe(join(userHome, '.gemini', 'config', 'plugins', 'coodra'));
    expect(paths.manifestPath).toBe(join(paths.pluginRoot, 'plugin.json'));
    expect(paths.mcpPath).toBe(join(paths.pluginRoot, 'mcp_config.json'));
    expect(paths.hooksPath).toBe(join(paths.pluginRoot, 'hooks.json'));

    await installAntigravityPlugin(ctx());

    const manifest = JSON.parse(await readFile(paths.manifestPath, 'utf8')) as Record<string, unknown>;
    // Deliberately minimal — matches the bundled doc's documented schema
    // exactly, unlike the richer manifests the other four agents get.
    expect(manifest).toEqual({ name: ANTIGRAVITY_PLUGIN_NAME });
  });

  it('writes a native plugin bundle with Coodra and managed Graphify MCP servers', async () => {
    const paths = antigravityPluginPaths(userHome);
    await installAntigravityPlugin(ctx());

    const mcp = JSON.parse(await readFile(paths.mcpPath, 'utf8')) as {
      mcpServers: {
        coodra?: { command?: string; env?: Record<string, string> };
        graphify?: { command?: string; args?: string[] };
      };
    };
    expect(mcp.mcpServers.coodra?.env?.COODRA_AGENT_TYPE).toBe('antigravity');
    expect(mcp.mcpServers.graphify?.command).toBe(join(coodraHome, 'graphify-mcp', '.venv', 'bin', 'python'));

    expect(await readFile(join(paths.skillsRoot, 'coodra-context', 'SKILL.md'), 'utf8')).toContain(
      'name: coodra-context',
    );
  });

  it('hooks.json nests events under a "coodra" hook name; PreToolUse/PostToolUse use the matcher+hooks wrapper, PreInvocation/PostInvocation/Stop are flat arrays', async () => {
    const paths = antigravityPluginPaths(userHome);
    await installAntigravityPlugin(ctx());
    const hooks = JSON.parse(await readFile(paths.hooksPath, 'utf8')) as Record<
      string,
      Record<string, Array<Record<string, unknown>>>
    >;
    expect(Object.keys(hooks)).toEqual(['coodra']);
    const coodraHooks = hooks.coodra as Record<string, Array<Record<string, unknown>>>;
    expect(Object.keys(coodraHooks).sort()).toEqual([
      'PostInvocation',
      'PostToolUse',
      'PreInvocation',
      'PreToolUse',
      'Stop',
    ]);
    // Grouped shape (matcher + hooks wrapper) for tool-targeted events.
    expect(coodraHooks.PreToolUse?.[0]).toHaveProperty('matcher');
    expect(coodraHooks.PreToolUse?.[0]).toHaveProperty('hooks');
    expect(coodraHooks.PostToolUse?.[0]).toHaveProperty('matcher');
    // Flat shape (handler object directly, no matcher wrapper) for
    // turn-level events — matcher is ignored for these per Antigravity's
    // own docs.
    expect(coodraHooks.PreInvocation?.[0]).not.toHaveProperty('matcher');
    expect(coodraHooks.PreInvocation?.[0]).toHaveProperty('command');
    expect(coodraHooks.PostInvocation?.[0]).not.toHaveProperty('matcher');
    expect(coodraHooks.Stop?.[0]).not.toHaveProperty('matcher');
  });

  it('each event command carries the event name as a trailing CLI arg — Antigravity never states which event fired in its own payload', async () => {
    const paths = antigravityPluginPaths(userHome);
    await installAntigravityPlugin(ctx());
    const hooks = JSON.parse(await readFile(paths.hooksPath, 'utf8')) as {
      coodra: Record<string, Array<{ command?: string; hooks?: Array<{ command?: string }> }>>;
    };
    const preToolUseCommand = hooks.coodra.PreToolUse?.[0]?.hooks?.[0]?.command;
    const preInvocationCommand = hooks.coodra.PreInvocation?.[0]?.command;
    expect(preToolUseCommand).toContain('hook-runner.mjs');
    expect(preToolUseCommand).toMatch(/PreToolUse"?$/);
    expect(preInvocationCommand).toMatch(/PreInvocation"?$/);
    expect(preToolUseCommand).not.toEqual(preInvocationCommand);
  });

  it('hookRunner reads argv[2] for the event name and injects it as payload.hookEventName; targets agentType antigravity', async () => {
    const paths = antigravityPluginPaths(userHome);
    await installAntigravityPlugin(ctx());
    const hookRunner = await readFile(paths.hookRunnerPath, 'utf8');
    expect(hookRunner).toContain('process.argv[2]');
    expect(hookRunner).toContain('payload.hookEventName');
    expect(hookRunner).toContain("agentType: 'antigravity'");
    expect(hookRunner).toContain("method: 'tools/call'");
  });

  it('removeAntigravityPlugin removes the whole plugin directory unconditionally (no shared registry to preserve)', async () => {
    const paths = antigravityPluginPaths(userHome);
    await installAntigravityPlugin(ctx());
    expect(existsSync(paths.pluginRoot)).toBe(true);

    const removeCtx: AgentRemoveContext = { cwd, userHome, coodraHome, bridgePort: 3101, dryRun: false };
    const result = await removeAntigravityPlugin(removeCtx);
    expect(existsSync(paths.pluginRoot)).toBe(false);
    expect(result.outcomes[0]?.action).toBe('merged');
  });

  it('removeAntigravityPlugin --dry-run leaves the plugin directory in place', async () => {
    const paths = antigravityPluginPaths(userHome);
    await installAntigravityPlugin(ctx());
    const removeCtx: AgentRemoveContext = { cwd, userHome, coodraHome, bridgePort: 3101, dryRun: true };
    await removeAntigravityPlugin(removeCtx);
    expect(existsSync(paths.pluginRoot)).toBe(true);
  });

  it('--dry-run touches nothing on disk', async () => {
    const paths = antigravityPluginPaths(userHome);
    await installAntigravityPlugin(ctx({ dryRun: true }));
    expect(existsSync(paths.pluginRoot)).toBe(false);
  });

  it('force overwrites a drifted manifest; without --force it leaves local edits alone', async () => {
    const paths = antigravityPluginPaths(userHome);
    await installAntigravityPlugin(ctx());
    await writeFile(paths.manifestPath, JSON.stringify({ name: 'drifted' }), 'utf8');

    const unforced = await installAntigravityPlugin(ctx());
    expect(unforced.outcomes.find((o) => o.path === paths.manifestPath)?.action).toBe('unchanged');
    expect(JSON.parse(await readFile(paths.manifestPath, 'utf8'))).toEqual({ name: 'drifted' });

    const forced = await installAntigravityPlugin(ctx({ force: true }));
    expect(forced.outcomes.find((o) => o.path === paths.manifestPath)?.action).toBe('forced');
    expect(JSON.parse(await readFile(paths.manifestPath, 'utf8'))).toEqual({ name: ANTIGRAVITY_PLUGIN_NAME });
  });

  it('probeAntigravityPlugin reports missing before install and fully wired after', async () => {
    const before = await probeAntigravityPlugin({ cwd, userHome });
    expect(before).toMatchObject({ manifest: false, mcp: false, hooks: false, skills: false });

    await installAntigravityPlugin(ctx());
    const after = await probeAntigravityPlugin({ cwd, userHome });
    expect(after).toMatchObject({ manifest: true, mcp: true, hooks: true, skills: true });
  });
});
