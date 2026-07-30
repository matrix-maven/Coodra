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
import { mergeCodexConfig } from '../../src/lib/init/codex-merge.js';
import { mergeInstructionFile } from '../../src/lib/init/instruction-files.js';

/**
 * End-to-end coverage for `coodra agent add/status/remove/repair` against real
 * temp filesystems (no host config touched). Exercises the AgentAdapter
 * registry through the command layer: legacy per-agent surfaces, native
 * plugin surfaces, the project-level .mcp.json for project-scoped agents,
 * the devin→windsurf alias, force/repair, removal, dry-run, and the
 * unknown-agent error path.
 */

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
  return { cwd, userHome, coodraHome: home, env: {}, settingsPath, json: true, ...extra };
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'coodra-agent-cwd-'));
  home = await mkdtemp(join(tmpdir(), 'coodra-agent-home-'));
  userHome = await mkdtemp(join(tmpdir(), 'coodra-agent-userhome-'));
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
} {
  return JSON.parse(cap.stdout.join(''));
}

describe('coodra agent add', () => {
  it('add cursor — writes .cursor/mcp.json + .cursorrules + the project .mcp.json', async () => {
    const { io, cap } = makeIO();
    const code = await run(() => runAgentAddCommand('cursor', baseOptions(), io));
    expect(code).toBe(EXIT_OK);

    // The project-level MCP registration.
    const mcpJson = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'));
    expect(mcpJson.mcpServers.coodra).toBeDefined();
    // Cursor's per-agent surfaces.
    const cursorMcp = JSON.parse(await readFile(join(cwd, '.cursor', 'mcp.json'), 'utf8'));
    expect(cursorMcp.mcpServers.coodra).toBeDefined();
    expect(cursorMcp.mcpServers.coodra.env.COODRA_AGENT_TYPE).toBe('cursor');
    const cursorrules = await readFile(join(cwd, '.cursorrules'), 'utf8');
    expect(cursorrules).toContain('coodra:start');

    const payload = parse(cap);
    expect(payload.ok).toBe(true);
    expect(payload.agents[0]?.id).toBe('cursor');

    // Phase 2: agent add writes .coodra/config.json + records the manifest.
    const config = JSON.parse(await readFile(join(cwd, '.coodra', 'config.json'), 'utf8'));
    expect(config).toMatchObject({ version: 1, projectSlug: 'sample-app' });
    const manifest = JSON.parse(await readFile(join(cwd, '.coodra', 'manifest.json'), 'utf8'));
    const paths = manifest.entries.map((e: { path: string }) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining(['.mcp.json', '.cursor/mcp.json', '.cursorrules', '.coodra/config.json']),
    );
    const cursorEntry = manifest.entries.find((e: { path: string }) => e.path === '.cursor/mcp.json');
    expect(cursorEntry).toMatchObject({ owner: 'agent:cursor', cleanup: 'ask' });
  });

  it('add codex — installs the global native Codex plugin and does not write project agent files', async () => {
    const { io } = makeIO();
    await run(() => runAgentAddCommand('codex', baseOptions(), io));
    expect(existsSync(join(cwd, '.mcp.json'))).toBe(false);
    expect(existsSync(join(cwd, '.codex', 'config.toml'))).toBe(false);
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);

    const pluginRoot = join(userHome, '.codex', 'plugins', 'coodra');
    const marketplace = JSON.parse(await readFile(join(userHome, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    expect(marketplace.plugins.some((p: { name?: string }) => p.name === 'coodra')).toBe(true);
    expect(marketplace.plugins.find((p: { name?: string }) => p.name === 'coodra')?.source.path).toBe(
      './.codex/plugins/coodra',
    );
    const manifest = JSON.parse(await readFile(join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'coodra', skills: './skills/', mcpServers: './.mcp.json' });
    expect(manifest.hooks).toBeUndefined();
    const mcp = JSON.parse(await readFile(join(pluginRoot, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.coodra.env.COODRA_AGENT_TYPE).toBe('codex');
    const hooks = JSON.parse(await readFile(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
    expect(Object.keys(hooks.hooks).sort()).toEqual([
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

    const cacheRoot = join(userHome, '.claude', 'plugins', 'cache', 'coodra', 'coodra', '0.2.0-beta.28');
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
  });

  it('add devin — resolves to the windsurf adapter (label "Devin"), writes windsurf surfaces', async () => {
    const { io, cap } = makeIO();
    // windsurf writes a GLOBAL config under userHome/.codeium/windsurf/.
    await run(() => runAgentAddCommand('devin', baseOptions(), io));
    const windsurfMcp = JSON.parse(await readFile(join(userHome, '.codeium', 'windsurf', 'mcp_config.json'), 'utf8'));
    expect(windsurfMcp.mcpServers.coodra).toBeDefined();
    expect(windsurfMcp.mcpServers.coodra.env.COODRA_AGENT_TYPE).toBe('windsurf');
    expect(await readFile(join(cwd, '.windsurfrules'), 'utf8')).toContain('coodra:start');

    const payload = parse(cap);
    expect(payload.agents[0]?.id).toBe('windsurf');
    expect(payload.agents[0]?.label).toBe('Devin');
  });

  it('add all — wires every agent in one pass', async () => {
    const { io, cap } = makeIO();
    await run(() => runAgentAddCommand('all', baseOptions(), io));
    const payload = parse(cap);
    expect(payload.agents.map((a) => a.id).sort()).toEqual(['claude', 'codex', 'cursor', 'windsurf']);
    expect(existsSync(join(cwd, '.cursor', 'mcp.json'))).toBe(true);
    expect(existsSync(join(cwd, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(userHome, '.codex', 'plugins', 'coodra', '.codex-plugin', 'plugin.json'))).toBe(true);
    expect(
      existsSync(join(home, 'claude-marketplaces', 'coodra', 'plugins', 'coodra', '.claude-plugin', 'plugin.json')),
    ).toBe(true);
    expect(existsSync(join(userHome, '.claude', 'plugins', 'cache', 'coodra', 'coodra', '0.2.0-beta.28'))).toBe(true);
  });

  it('--dry-run touches nothing on disk', async () => {
    const { io } = makeIO();
    await run(() => runAgentAddCommand('cursor', baseOptions({ dryRun: true }), io));
    expect(existsSync(join(cwd, '.cursor', 'mcp.json'))).toBe(false);
    expect(existsSync(join(cwd, '.cursorrules'))).toBe(false);
    expect(existsSync(join(cwd, '.mcp.json'))).toBe(false);
  });

  it('unknown agent — exits 1 with a helpful error', async () => {
    const { io, cap } = makeIO();
    const code = await run(() => runAgentAddCommand('bogus', baseOptions(), io));
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    expect(parse(cap).error).toContain("Unknown agent 'bogus'");
  });
});

describe('coodra agent repair', () => {
  it('force re-wires an already-wired agent (idempotent, exits 0)', async () => {
    const { io: io1 } = makeIO();
    await run(() => runAgentAddCommand('cursor', baseOptions(), io1));
    // Corrupt the cursor entry so repair has something to overwrite.
    await writeFile(join(cwd, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { coodra: { command: 'stale' } } }));

    const { io: io2, cap } = makeIO();
    const code = await run(() => runAgentRepairCommand('cursor', baseOptions(), io2));
    expect(code).toBe(EXIT_OK);
    // Repair (force) restored the canonical entry.
    const cursorMcp = JSON.parse(await readFile(join(cwd, '.cursor', 'mcp.json'), 'utf8'));
    expect(cursorMcp.mcpServers.coodra.command).toBe('node');
    expect(parse(cap).agents[0]?.outcomes.some((o) => o.action === 'forced')).toBe(true);
  });
});

describe('coodra agent remove', () => {
  it('removes Codex native plugin state and legacy repo-level Codex surfaces', async () => {
    const { io: io1 } = makeIO();
    await run(() => runAgentAddCommand('codex', baseOptions(), io1));

    const marketplacePath = join(userHome, '.agents', 'plugins', 'marketplace.json');
    const marketplace = JSON.parse(await readFile(marketplacePath, 'utf8'));
    marketplace.plugins.push({
      name: 'other',
      source: { source: 'local', path: './.codex/plugins/other' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    });
    await writeFile(marketplacePath, JSON.stringify(marketplace));
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

    const nextMarketplace = JSON.parse(await readFile(marketplacePath, 'utf8'));
    expect(nextMarketplace.plugins.some((p: { name?: string }) => p.name === 'coodra')).toBe(false);
    expect(nextMarketplace.plugins.some((p: { name?: string }) => p.name === 'other')).toBe(true);
    expect(existsSync(join(userHome, '.codex', 'plugins', 'coodra'))).toBe(false);
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
    expect(existsSync(join(userHome, '.claude', 'plugins', 'cache', 'coodra', 'coodra', '0.2.0-beta.28'))).toBe(false);
    expect(existsSync(join(userHome, '.claude', 'plugins', 'installed_plugins.json'))).toBe(false);
    expect(existsSync(join(cwd, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(cwd, '.mcp.json'))).toBe(false);
  });

  it('strips only the agent surfaces, preserving the project .mcp.json + other MCP servers', async () => {
    const { io: io1 } = makeIO();
    await run(() => runAgentAddCommand('cursor', baseOptions(), io1));
    // Add a user-owned server to .cursor/mcp.json to prove it survives.
    const cursorPath = join(cwd, '.cursor', 'mcp.json');
    const withUser = JSON.parse(await readFile(cursorPath, 'utf8'));
    withUser.mcpServers.other = { command: 'npx', args: ['x'] };
    await writeFile(cursorPath, JSON.stringify(withUser));

    const { io: io2 } = makeIO();
    const code = await run(() => runAgentRemoveCommand('cursor', baseOptions(), io2));
    expect(code).toBe(EXIT_OK);

    const cursorMcp = JSON.parse(await readFile(cursorPath, 'utf8'));
    expect(cursorMcp.mcpServers.coodra).toBeUndefined();
    expect(cursorMcp.mcpServers.other).toBeDefined();
    // .cursorrules coodra block gone.
    expect(existsSync(join(cwd, '.cursorrules'))).toBe(false);
    // The project .mcp.json (project-level registration) is left for `coodra uninstall`.
    expect(JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8')).mcpServers.coodra).toBeDefined();
  });
});

describe('coodra agent status', () => {
  it('reports wired state after add and missing for un-wired agents', async () => {
    const { io: io1 } = makeIO();
    await run(() => runAgentAddCommand('cursor', baseOptions(), io1));

    const { io: io2, cap } = makeIO();
    const code = await run(() => runAgentStatusCommand(baseOptions(), io2));
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(cap.stdout.join('')) as {
      agents: Array<{ id: string; fullyWired: boolean; files: Array<{ label: string; state: string }> }>;
    };
    const cursor = payload.agents.find((a) => a.id === 'cursor');
    expect(cursor?.fullyWired).toBe(true);
    const codex = payload.agents.find((a) => a.id === 'codex');
    expect(codex?.fullyWired).toBe(false);
    expect(codex?.files.every((f) => f.state === 'missing')).toBe(true);
  });
});
