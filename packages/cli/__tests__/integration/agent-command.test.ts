import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentCommandOptions,
  type AgentIO,
  runAgentAddCommand,
  runAgentRemoveCommand,
  runAgentRepairCommand,
  runAgentStatusCommand,
} from '../../src/commands/agent.js';
import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../../src/exit-codes.js';
import type { CodexCliRunner } from '../../src/lib/agents/codex-plugin.js';
import { mergeCodexConfig } from '../../src/lib/init/codex-merge.js';
import { mergeInstructionFile } from '../../src/lib/init/instruction-files.js';
import { VERSION } from '../../src/version.js';

/**
 * End-to-end coverage for `coodra agent add/status/remove/repair` against real
 * temp filesystems (no host config touched). Exercises the AgentAdapter
 * registry through the command layer: per-agent config surfaces, native
 * plugin surfaces, user-owned repo-root .mcp.json boundaries,
 * force/repair, removal, dry-run, and the unknown-agent error path.
 *
 * Every `baseOptions()` call below injects `codexCliRunner: noCodexCli()`.
 * Without it, on any machine that has `codex` on PATH — found live,
 * 2026-08-02, TWICE while writing this fix: the first attempt used
 * `vi.mock('codex-plugin.js', ...)` to override the exported
 * `defaultCodexCliRunner`, which does NOT work — `installCodexPlugin`'s
 * default parameter closes over the REAL module's own internal binding at
 * definition time, not the mocked export object, so it silently kept
 * calling the real CLI. Both attempts registered a REAL `"coodra"`
 * marketplace on the developer's actual `~/.codex/config.toml`, requiring
 * manual `codex plugin remove`/`marketplace remove` cleanup on the real
 * machine. The only reliable fix is passing an explicit fake runner through
 * `AgentContext`/`AgentRemoveContext`/`AgentPathContext`.
 */
function noCodexCli(): CodexCliRunner {
  return {
    detect: async () => null,
    installMarketplaceAndPlugin: async () => {
      throw new Error('unexpected: codex CLI should not be invoked in this test');
    },
    uninstallPlugin: async () => {
      throw new Error('unexpected: codex CLI should not be invoked in this test');
    },
    isInstalled: async () => {
      throw new Error('unexpected: codex CLI should not be invoked in this test');
    },
  };
}

interface Cap {
  stdout: string[];
  stderr: string[];
  exit: number | null;
}

function makeIO(): { io: AgentIO; cap: Cap } {
  const cap: Cap = { stdout: [], stderr: [], exit: null };
  const io: AgentIO = {
    writeStdout: (c) => cap.stdout.push(c),
    writeStderr: (c) => cap.stderr.push(c),
    exit: (code) => {
      cap.exit = code;
      throw new Error(`__exit__:${code}`);
    },
  };
  return { io, cap };
}

async function run(p: () => Promise<unknown>): Promise<number> {
  try {
    await p();
    throw new Error('did not exit');
  } catch (err) {
    const m = (err as Error).message.match(/^__exit__:(\d+)$/);
    if (!m) throw err;
    return Number(m[1]);
  }
}

let cwd: string;
let home: string;
let userHome: string;
let settingsPath: string;

function baseOptions(extra: Partial<AgentCommandOptions> = {}): AgentCommandOptions {
  return {
    cwd,
    userHome,
    coodraHome: home,
    env: {},
    settingsPath,
    json: true,
    codexCliRunner: noCodexCli(),
    ...extra,
  };
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'coodra-agent-cwd-'));
  userHome = await mkdtemp(join(tmpdir(), 'coodra-agent-userhome-'));
  // Default coodraHome (~/.coodra) — kept nested under userHome, matching
  // production default, so `probeCodexPlugin`'s file-based fallback (which
  // always resolves paths off `codexPluginPaths(ctx.userHome)`, i.e. the
  // DEFAULT coodraHome, since `AgentPathContext` has no coodraHome field)
  // agrees with where `installCodexPlugin` actually wrote the source files.
  home = join(userHome, '.coodra');
  await mkdir(home, { recursive: true });
  settingsPath = join(userHome, '.claude', 'settings.json');
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'sample-app' }));
  await mkdir(join(cwd, '.coodra'), { recursive: true });
  await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ version: 1, projectSlug: 'sample-app' }));
});

afterEach(() => {
  /* tmp cleaned by OS */
});

function parse(cap: Cap): {
  ok: boolean;
  mcpJson?: { action: string };
  agents: Array<{ id: string; label: string; outcomes: Array<{ path: string; action: string }> }>;
  error?: string;
  policyProjection?: { agents: readonly string[]; written: readonly string[]; skippedReason?: string };
} {
  return JSON.parse(cap.stdout.join(''));
}

describe('coodra agent add', () => {
  it('add codex — installs the global native Codex plugin and does not write project agent files', async () => {
    const { io } = makeIO();
    await run(() => runAgentAddCommand('codex', baseOptions(), io));
    expect(existsSync(join(cwd, '.mcp.json'))).toBe(false);
    expect(existsSync(join(cwd, '.codex', 'config.toml'))).toBe(false);
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);

    const marketplaceRoot = join(home, 'codex-marketplaces', 'coodra');
    const pluginRoot = join(marketplaceRoot, 'plugins', 'coodra');
    const marketplace = JSON.parse(
      await readFile(join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), 'utf8'),
    );
    expect(marketplace.name).toBe('coodra');
    expect(marketplace.plugins.some((p: { name?: string }) => p.name === 'coodra')).toBe(true);
    expect(marketplace.plugins.find((p: { name?: string }) => p.name === 'coodra')?.source).toEqual({
      source: 'local',
      path: './plugins/coodra',
    });
    const manifest = JSON.parse(await readFile(join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'coodra', skills: './skills/', mcpServers: './.mcp.json' });
    expect(manifest.hooks).toBeUndefined();
    const mcp = JSON.parse(await readFile(join(pluginRoot, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.coodra.env.COODRA_AGENT_TYPE).toBe('codex');
    const hooks = JSON.parse(await readFile(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
    expect(Object.keys(hooks.hooks).sort()).toEqual([
      'ConfigChange',
      'PostToolUse',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
    const hookRunner = await readFile(join(pluginRoot, 'hooks', 'hook-runner.mjs'), 'utf8');
    expect(hookRunner).toContain("params: { name: 'lifecycle_event'");
    expect(hookRunner).toContain("method: 'tools/call'");
    expect(hookRunner).not.toContain('/v1/hooks/codex');
    expect(hookRunner).not.toContain('HOOKS_BRIDGE_PORT');
    expect(hookRunner).not.toContain('LOCAL_HOOK_SECRET');
    expect(await readFile(join(pluginRoot, 'skills', 'coodra-context', 'SKILL.md'), 'utf8')).toContain(
      'name: coodra-context',
    );
    const graphifySkill = await readFile(join(pluginRoot, 'skills', 'coodra-graphify', 'SKILL.md'), 'utf8');
    expect(graphifySkill).toContain('Do not inspect or print environment variables');
    expect(graphifySkill).toContain('omit `project_path`');

    const machineManifest = JSON.parse(await readFile(join(home, 'manifest.json'), 'utf8'));
    expect(machineManifest.agents.find((a: { id: string }) => a.id === 'codex')).toMatchObject({
      status: 'installed',
      installed: true,
      pluginPath: pluginRoot,
    });
  });

  it('add claude — installs the global native Claude plugin and does not write project agent files', async () => {
    const { io } = makeIO();
    await run(() => runAgentAddCommand('claude', baseOptions(), io));
    expect(existsSync(join(cwd, '.mcp.json'))).toBe(false);
    expect(existsSync(join(cwd, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(cwd, '.coodra', 'manifest.json'))).toBe(false);

    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    expect(settings.enabledPlugins['coodra@coodra']).toBe(true);
    expect(settings.enabledPlugins['coodra@skills-dir']).toBeUndefined();
    expect(settings.extraKnownMarketplaces.coodra.source).toEqual({
      source: 'directory',
      path: join(home, 'claude-marketplaces', 'coodra'),
    });

    const marketplace = JSON.parse(
      await readFile(join(home, 'claude-marketplaces', 'coodra', '.claude-plugin', 'marketplace.json'), 'utf8'),
    );
    expect(marketplace).toMatchObject({ name: 'coodra', plugins: [{ name: 'coodra', source: './plugins/coodra' }] });

    const known = JSON.parse(await readFile(join(userHome, '.claude', 'plugins', 'known_marketplaces.json'), 'utf8'));
    expect(known.coodra).toMatchObject({
      source: { source: 'directory', path: join(home, 'claude-marketplaces', 'coodra') },
      installLocation: join(home, 'claude-marketplaces', 'coodra'),
    });

    const cacheRoot = join(userHome, '.claude', 'plugins', 'cache', 'coodra', 'coodra', VERSION);
    const pluginRoot = join(home, 'claude-marketplaces', 'coodra', 'plugins', 'coodra');
    const manifest = JSON.parse(await readFile(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'coodra', skills: './skills/', mcpServers: './.mcp.json' });
    const mcp = JSON.parse(await readFile(join(pluginRoot, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.coodra.env.COODRA_AGENT_TYPE).toBe('claude_code');
    expect(
      JSON.parse(await readFile(join(cacheRoot, '.mcp.json'), 'utf8')).mcpServers.coodra.env.COODRA_AGENT_TYPE,
    ).toBe('claude_code');
    const hooks = JSON.parse(await readFile(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
    expect(JSON.stringify(hooks)).toContain('"type":"mcp_tool"');
    expect(JSON.stringify(hooks)).toContain('"server":"plugin:coodra:coodra"');
    expect(JSON.stringify(hooks)).toContain('"tool":"lifecycle_event"');
    const graphifySkill = await readFile(join(pluginRoot, 'skills', 'coodra-graphify', 'SKILL.md'), 'utf8');
    expect(graphifySkill).toContain('Do not inspect or print environment variables');
    expect(graphifySkill).toContain('omit `project_path`');
  });

  it('add all — wires every agent in one pass', async () => {
    const { io, cap } = makeIO();
    await run(() => runAgentAddCommand('all', baseOptions(), io));
    const payload = parse(cap);
    expect(payload.agents.map((a) => a.id).sort()).toEqual(['claude', 'codex']);
    expect(existsSync(join(cwd, 'CLAUDE.md'))).toBe(false);
    expect(
      existsSync(join(home, 'codex-marketplaces', 'coodra', 'plugins', 'coodra', '.codex-plugin', 'plugin.json')),
    ).toBe(true);
    expect(
      existsSync(join(home, 'claude-marketplaces', 'coodra', 'plugins', 'coodra', '.claude-plugin', 'plugin.json')),
    ).toBe(true);
    expect(existsSync(join(userHome, '.claude', 'plugins', 'cache', 'coodra', 'coodra', VERSION))).toBe(true);
  });

  it('--dry-run touches nothing on disk', async () => {
    const { io } = makeIO();
    await run(() => runAgentAddCommand('codex', baseOptions({ dryRun: true }), io));
    expect(existsSync(join(home, 'codex-marketplaces', 'coodra'))).toBe(false);
    expect(existsSync(join(cwd, '.mcp.json'))).toBe(false);
  });

  it('unknown agent — exits 1 with a helpful error', async () => {
    const { io, cap } = makeIO();
    const code = await run(() => runAgentAddCommand('bogus', baseOptions(), io));
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    expect(parse(cap).error).toContain("Unknown agent 'bogus'");
  });

  it('policy projection skip — no project registered anywhere names coodra init, not this (often nonsensical) cwd', async () => {
    // Mirrors running `coodra agent add` from `~` right after `coodra
    // install`: the global plugin install always succeeds, but nothing is
    // registered in the DB yet, so the skip message must not just repeat
    // an arbitrary cwd back at the user as if it were an instruction.
    const { openLocalDb } = await import('../../src/lib/open-local-db.js');
    const { resolveCoodraDataDb } = await import('../../src/lib/coodra-home.js');
    const { migrateSqlite } = await import('@coodra/db');
    const handle = await openLocalDb(resolveCoodraDataDb(home), { loadVecExtension: true });
    migrateSqlite(handle.db);
    handle.close();

    const { io, cap } = makeIO();
    await run(() => runAgentAddCommand('codex', baseOptions(), io));
    const projection = parse(cap).policyProjection;
    expect(projection?.skippedReason).toContain('no Coodra project registered yet');
    expect(projection?.skippedReason).toContain('coodra init');
  });

  it('policy projection skip — other registered projects are named so the user knows where to go instead', async () => {
    const { openLocalDb } = await import('../../src/lib/open-local-db.js');
    const { resolveCoodraDataDb } = await import('../../src/lib/coodra-home.js');
    const { ensureProject, migrateSqlite } = await import('@coodra/db');
    const handle = await openLocalDb(resolveCoodraDataDb(home), { loadVecExtension: true });
    migrateSqlite(handle.db);
    try {
      await ensureProject(handle, { slug: 'other-registered-project', cwd: '/tmp/other-project' });
    } finally {
      handle.close();
    }

    const { io, cap } = makeIO();
    await run(() => runAgentAddCommand('codex', baseOptions(), io));
    const projection = parse(cap).policyProjection;
    expect(projection?.skippedReason).toContain('other-registered-project');
    expect(projection?.skippedReason).toContain(cwd);
    expect(projection?.skippedReason).not.toContain('no Coodra project registered yet');
  });
});

describe('coodra agent repair', () => {
  it('force re-wires an already-wired agent (idempotent, exits 0)', async () => {
    const { io: io1 } = makeIO();
    await run(() => runAgentAddCommand('codex', baseOptions(), io1));
    // Corrupt the plugin-scoped MCP entry so repair has something to overwrite.
    const mcpPath = join(home, 'codex-marketplaces', 'coodra', 'plugins', 'coodra', '.mcp.json');
    await writeFile(mcpPath, JSON.stringify({ mcpServers: { coodra: { command: 'stale' } } }));

    const { io: io2, cap } = makeIO();
    const code = await run(() => runAgentRepairCommand('codex', baseOptions(), io2));
    expect(code).toBe(EXIT_OK);
    // Repair (force) restored the canonical entry.
    const codexMcp = JSON.parse(await readFile(mcpPath, 'utf8'));
    expect(codexMcp.mcpServers.coodra.command).toBe('node');
    expect(parse(cap).agents[0]?.outcomes.some((o) => o.action === 'forced')).toBe(true);
  });
});

describe('coodra agent remove', () => {
  it('removes Codex native plugin state and legacy repo-level Codex surfaces', async () => {
    const { io: io1 } = makeIO();
    await run(() => runAgentAddCommand('codex', baseOptions(), io1));

    // Coodra owns this whole marketplace directory outright (COOD-11
    // follow-up) — there's no shared "personal" marketplace file to merge
    // into/out of anymore, so removal is a directory delete, not a filtered
    // rewrite of someone else's plugin list.
    const marketplaceRoot = join(home, 'codex-marketplaces', 'coodra');
    expect(existsSync(join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'))).toBe(true);

    await mergeCodexConfig({
      cwd,
      entry: {
        command: 'node',
        args: ['/tmp/coodra-mcp-server.js'],
        env: { COODRA_AGENT_TYPE: 'codex', COODRA_LOG_DESTINATION: 'stderr' },
      },
      force: false,
      dryRun: false,
    });
    await mergeInstructionFile({ cwd, filename: 'AGENTS.md', projectSlug: 'sample-app', dryRun: false });

    const { io: io2 } = makeIO();
    const code = await run(() => runAgentRemoveCommand('codex', baseOptions(), io2));
    expect(code).toBe(EXIT_OK);

    expect(existsSync(marketplaceRoot)).toBe(false);
    expect(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')).not.toContain('[mcp_servers.coodra]');
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
  });

  it('removes Claude marketplace plugin state without touching project files', async () => {
    const { io: io1 } = makeIO();
    await run(() => runAgentAddCommand('claude', baseOptions(), io1));

    const { io: io2 } = makeIO();
    const code = await run(() => runAgentRemoveCommand('claude', baseOptions(), io2));
    expect(code).toBe(EXIT_OK);

    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    expect(settings.enabledPlugins['coodra@coodra']).toBeUndefined();
    expect(settings.extraKnownMarketplaces.coodra).toBeUndefined();

    const known = JSON.parse(await readFile(join(userHome, '.claude', 'plugins', 'known_marketplaces.json'), 'utf8'));
    expect(known.coodra).toBeUndefined();
    expect(existsSync(join(home, 'claude-marketplaces', 'coodra'))).toBe(false);
    expect(existsSync(join(userHome, '.claude', 'plugins', 'cache', 'coodra', 'coodra', VERSION))).toBe(false);
    expect(existsSync(join(userHome, '.claude', 'plugins', 'installed_plugins.json'))).toBe(false);
    expect(existsSync(join(cwd, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(cwd, '.mcp.json'))).toBe(false);
  });
});

describe('coodra agent status', () => {
  it('reports wired state after add and missing for un-wired agents', async () => {
    const { io: io1 } = makeIO();
    await run(() => runAgentAddCommand('codex', baseOptions(), io1));

    const { io: io2, cap } = makeIO();
    const code = await run(() => runAgentStatusCommand(baseOptions(), io2));
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(cap.stdout.join('')) as {
      agents: Array<{ id: string; fullyWired: boolean; files: Array<{ label: string; state: string }> }>;
    };
    const codex = payload.agents.find((a) => a.id === 'codex');
    expect(codex?.fullyWired).toBe(true);
    const claude = payload.agents.find((a) => a.id === 'claude');
    expect(claude?.fullyWired).toBe(false);
    expect(claude?.files.every((f) => f.state === 'missing')).toBe(true);
  });
});
