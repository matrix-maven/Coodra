import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CURSOR_PLUGIN_NAME,
  cursorPluginPaths,
  installCursorPlugin,
  probeCursorPlugin,
  removeCursorPlugin,
} from '../../../src/lib/agents/cursor-plugin.js';
import type { AgentContext, AgentRemoveContext } from '../../../src/lib/agents/types.js';

describe('Cursor native plugin installer', () => {
  let userHome: string;
  let cwd: string;
  let coodraHome: string;

  beforeEach(async () => {
    userHome = await mkdtemp(join(tmpdir(), 'coodra-cursor-plugin-home-'));
    cwd = await mkdtemp(join(tmpdir(), 'coodra-cursor-plugin-cwd-'));
    coodraHome = await mkdtemp(join(tmpdir(), 'coodra-cursor-plugin-data-'));
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

  it('writes the plugin under ~/.cursor/plugins/local/coodra/ — a plain local plugin directory, no marketplace', async () => {
    const paths = cursorPluginPaths(userHome);
    expect(paths.pluginRoot).toBe(join(userHome, '.cursor', 'plugins', 'local', 'coodra'));
    expect(paths.manifestPath).toBe(join(paths.pluginRoot, '.cursor-plugin', 'plugin.json'));

    await installCursorPlugin(ctx());

    const manifest = JSON.parse(await readFile(paths.manifestPath, 'utf8')) as {
      name: string;
      mcpServers: string;
      skills: string;
    };
    expect(manifest.name).toBe(CURSOR_PLUGIN_NAME);
    expect(manifest.mcpServers).toBe('./mcp.json');
    expect(manifest.skills).toBe('./skills/');
  });

  it('writes a native plugin bundle with Coodra and managed Graphify MCP servers', async () => {
    const paths = cursorPluginPaths(userHome);
    await installCursorPlugin(ctx());

    const mcp = JSON.parse(await readFile(paths.mcpPath, 'utf8')) as {
      mcpServers: {
        coodra?: { command?: string; env?: Record<string, string> };
        graphify?: { command?: string; args?: string[] };
      };
    };
    expect(mcp.mcpServers.coodra?.env?.COODRA_AGENT_TYPE).toBe('cursor');
    expect(mcp.mcpServers.graphify?.command).toBe(join(coodraHome, 'graphify-mcp', '.venv', 'bin', 'python'));

    const hooks = JSON.parse(await readFile(paths.hooksPath, 'utf8')) as {
      version: number;
      hooks: Record<string, unknown>;
    };
    expect(hooks.version).toBe(1);
    expect(Object.keys(hooks.hooks).sort()).toEqual([
      'beforeSubmitPrompt',
      'postToolUse',
      'postToolUseFailure',
      'preCompact',
      'preToolUse',
      'sessionEnd',
      'sessionStart',
      'stop',
      'subagentStart',
      'subagentStop',
    ]);
    // Cursor hook coverage expansion — postToolUseFailure/subagentStart/
    // subagentStop are deliberately unmatched (full visibility);
    // preCompact isn't in Cursor's documented matcher list at all.
    for (const event of ['postToolUseFailure', 'subagentStart', 'subagentStop', 'preCompact']) {
      const entry = (hooks.hooks as Record<string, unknown>)[event] as Array<Record<string, unknown>>;
      expect(entry[0]).not.toHaveProperty('matcher');
    }

    const hookRunner = await readFile(paths.hookRunnerPath, 'utf8');
    expect(hookRunner).toContain("agentType: 'cursor'");
    expect(hookRunner).toContain("method: 'tools/call'");
    expect(hookRunner).toContain('LOCAL_HOOK_SECRET');
    expect(hookRunner).toContain('mcp-http-session.json');
    expect(hookRunner).toContain('HTTP_SESSION_END_TIMEOUT_MS');
    expect(hookRunner).not.toContain('fireAndForgetAck');

    expect(await readFile(join(paths.skillsRoot, 'coodra-context', 'SKILL.md'), 'utf8')).toContain(
      'name: coodra-context',
    );
    const graphifySkill = await readFile(join(paths.skillsRoot, 'coodra-graphify', 'SKILL.md'), 'utf8');
    expect(graphifySkill).toContain('Do not inspect or print environment variables');
  });

  it("preToolUse/postToolUse matcher reaches every MCP tool call, including Coodra's own (2026-08-08 broadening, no client-side exclusion)", async () => {
    // Cursor's matcher is a real regex over the bare tool name
    // (`MCP:<tool_name>`, confirmed against Cursor's own hooks docs),
    // unlike Claude Code's/Codex's server-prefixed `mcp__<server>__<tool>`
    // shape. Broadened (2026-08-08, same defensive posture as the
    // CONFIRMED Codex look-around bug) to match every MCP tool call
    // unconditionally — Coodra's own two managed servers are now excluded
    // server-side only, via `isCoodraOwnMcpTool` in the mcp-server's
    // `lifecycle_event` handler, not by the matcher regex itself.
    const paths = cursorPluginPaths(userHome);
    await installCursorPlugin(ctx());
    const hooks = JSON.parse(await readFile(paths.hooksPath, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string }>>;
    };
    const preMatcher = hooks.hooks.preToolUse?.[0]?.matcher;
    const postMatcher = hooks.hooks.postToolUse?.[0]?.matcher;
    expect(preMatcher).toBeDefined();
    expect(postMatcher).toBe(preMatcher);
    if (preMatcher === undefined) return;
    expect(preMatcher).not.toContain('(?!');
    const re = new RegExp(preMatcher);
    // Original shared-core coverage is unaffected.
    expect(re.test('Shell')).toBe(true);
    expect(re.test('Write')).toBe(true);
    expect(re.test('Read')).toBe(false);
    // Every MCP tool call now matches at the regex level, including
    // Coodra's own — the exclusion moved entirely server-side.
    expect(re.test('MCP:browser_navigate')).toBe(true);
    expect(re.test('MCP:get_run_id')).toBe(true);
    expect(re.test('MCP:query_graph')).toBe(true);
  });

  it('never shells out to anything — install/remove/probe are pure filesystem operations', async () => {
    // No CLI runner exists for Cursor (unlike Claude/Codex) — there is
    // nothing to inject a fake for, which is itself the thing worth
    // asserting: these calls only ever touch the filesystem.
    await installCursorPlugin(ctx());
    const paths = cursorPluginPaths(userHome);
    expect(existsSync(paths.pluginRoot)).toBe(true);
    const probe = await probeCursorPlugin({ cwd, userHome });
    expect(probe.manifest).toBe(true);
    const removeCtx: AgentRemoveContext = { cwd, userHome, coodraHome, bridgePort: 3101, dryRun: false };
    await removeCursorPlugin(removeCtx);
    expect(existsSync(paths.pluginRoot)).toBe(false);
  });

  it('--dry-run touches nothing on disk', async () => {
    const paths = cursorPluginPaths(userHome);
    await installCursorPlugin(ctx({ dryRun: true }));
    expect(existsSync(paths.pluginRoot)).toBe(false);
  });

  it('force overwrites a drifted manifest; without --force it leaves local edits alone', async () => {
    const paths = cursorPluginPaths(userHome);
    await installCursorPlugin(ctx());
    await writeFile(paths.manifestPath, JSON.stringify({ name: 'drifted' }), 'utf8');

    const unforced = await installCursorPlugin(ctx());
    expect(unforced.outcomes.find((o) => o.path === paths.manifestPath)?.action).toBe('unchanged');
    expect(JSON.parse(await readFile(paths.manifestPath, 'utf8'))).toEqual({ name: 'drifted' });

    const forced = await installCursorPlugin(ctx({ force: true }));
    expect(forced.outcomes.find((o) => o.path === paths.manifestPath)?.action).toBe('forced');
    expect(JSON.parse(await readFile(paths.manifestPath, 'utf8'))).toMatchObject({ name: CURSOR_PLUGIN_NAME });
  });

  it('removeCursorPlugin deletes the whole plugin directory and is idempotent when nothing exists', async () => {
    const paths = cursorPluginPaths(userHome);
    await installCursorPlugin(ctx());
    expect(existsSync(paths.pluginRoot)).toBe(true);

    const removeCtx: AgentRemoveContext = { cwd, userHome, coodraHome, bridgePort: 3101, dryRun: false };
    const first = await removeCursorPlugin(removeCtx);
    expect(existsSync(paths.pluginRoot)).toBe(false);
    expect(first.outcomes[0]?.action).toBe('merged');

    const second = await removeCursorPlugin(removeCtx);
    expect(second.outcomes[0]?.action).toBe('unchanged');
  });

  it('removeCursorPlugin --dry-run leaves the plugin directory in place', async () => {
    const paths = cursorPluginPaths(userHome);
    await installCursorPlugin(ctx());
    const removeCtx: AgentRemoveContext = { cwd, userHome, coodraHome, bridgePort: 3101, dryRun: true };
    await removeCursorPlugin(removeCtx);
    expect(existsSync(paths.pluginRoot)).toBe(true);
  });

  it('probeCursorPlugin reports missing before install and fully wired after', async () => {
    const before = await probeCursorPlugin({ cwd, userHome });
    expect(before).toMatchObject({ manifest: false, mcp: false, hooks: false, skills: false });

    await installCursorPlugin(ctx());
    const after = await probeCursorPlugin({ cwd, userHome });
    expect(after).toMatchObject({ manifest: true, mcp: true, hooks: true, skills: true });
  });
});
