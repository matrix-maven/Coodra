import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

/**
 * End-to-end coverage for `coodra agent add/status/remove/repair` against real
 * temp filesystems (no host config touched). Exercises the AgentAdapter
 * registry through the command layer: per-agent surfaces, the project-level
 * .mcp.json, the devin→windsurf alias, force/repair, removal (which preserves
 * .mcp.json), dry-run, and the unknown-agent error path.
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
  await writeFile(join(cwd, '.coodra.json'), JSON.stringify({ projectSlug: 'sample-app' }));
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

  it('add codex — writes .codex/config.toml + AGENTS.md with the codex agent stamp', async () => {
    const { io } = makeIO();
    await run(() => runAgentAddCommand('codex', baseOptions(), io));
    const toml = await readFile(join(cwd, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('[mcp_servers.coodra]');
    expect(toml).toContain('COODRA_AGENT_TYPE = "codex"');
    expect(await readFile(join(cwd, 'AGENTS.md'), 'utf8')).toContain('coodra:start');
  });

  it('add claude — writes ~/.claude/settings.json hooks + CLAUDE.md', async () => {
    const { io } = makeIO();
    await run(() => runAgentAddCommand('claude', baseOptions(), io));
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    expect(JSON.stringify(settings.hooks)).toContain('/v1/hooks/claude-code');
    expect(await readFile(join(cwd, 'CLAUDE.md'), 'utf8')).toContain('coodra:start');
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
    expect(existsSync(join(cwd, '.codex', 'config.toml'))).toBe(true);
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
