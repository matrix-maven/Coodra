import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildAgentReports, runAgentsCommand } from '../../../src/commands/agents.js';
import { VERSION } from '../../../src/version.js';

/**
 * Locks the 0.2.0-beta.1 `coodra agents` read-only status surface.
 *
 * The command's job is to make the multi-agent wiring visible — what
 * is detected, what is wired, what is missing. The function operates
 * over filesystem state only (no DB, no daemon), so the tests build a
 * tmp home + tmp cwd with various combinations and assert the
 * per-agent / per-file fields come out right.
 */

describe('buildAgentReports', () => {
  let userHome: string;
  let cwd: string;

  function claudePluginRoot(): string {
    return join(userHome, '.claude', 'plugins', 'cache', 'coodra', 'coodra', VERSION);
  }

  /** COOD-11 follow-up: Coodra's own Codex marketplace source, not the shared personal marketplace. */
  function codexPluginRoot(): string {
    return join(userHome, '.coodra', 'codex-marketplaces', 'coodra', 'plugins', 'coodra');
  }

  beforeEach(async () => {
    userHome = await mkdtemp(join(tmpdir(), 'coodra-agents-home-'));
    cwd = await mkdtemp(join(tmpdir(), 'coodra-agents-cwd-'));
  });

  it('returns one report per agent (claude, codex, cursor, devin) in canonical order', async () => {
    const reports = await buildAgentReports({ cwd, userHome });
    expect(reports.map((r) => r.name)).toEqual(['claude', 'codex', 'cursor', 'devin', 'antigravity']);
  });

  it('marks an agent as not-detected when its config dir is absent', async () => {
    const reports = await buildAgentReports({ cwd, userHome });
    expect(reports.every((r) => r.detected === false)).toBe(true);
    expect(reports.every((r) => r.howToEnable !== null)).toBe(true);
  });

  it('marks an agent as detected when its config dir exists', async () => {
    await mkdir(join(userHome, '.claude'));
    await mkdir(join(userHome, '.codex'));
    const reports = await buildAgentReports({ cwd, userHome });
    const claude = reports.find((r) => r.name === 'claude');
    const codex = reports.find((r) => r.name === 'codex');
    expect(claude?.detected).toBe(true);
    expect(codex?.detected).toBe(true);
    expect(claude?.howToEnable).toBeNull();
    expect(codex?.howToEnable).toBeNull();
  });

  it('flags Claude plugin MCP as wired when it carries the coodra entry', async () => {
    await mkdir(claudePluginRoot(), { recursive: true });
    await writeFile(
      join(claudePluginRoot(), '.mcp.json'),
      JSON.stringify({ mcpServers: { coodra: { command: 'node' } } }, null, 2),
      'utf8',
    );
    const reports = await buildAgentReports({ cwd, userHome });
    const claude = reports.find((r) => r.name === 'claude');
    const mcp = claude?.files.find((f) => f.label === 'Claude plugin MCP');
    expect(mcp?.wired).toBe(true);
    expect(mcp?.exists).toBe(true);
  });

  it('flags Claude user plugin enablement when coodra@coodra is enabled', async () => {
    await mkdir(join(userHome, '.claude'), { recursive: true });
    await writeFile(
      join(userHome, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'coodra@coodra': true } }, null, 2),
      'utf8',
    );
    const reports = await buildAgentReports({ cwd, userHome });
    const claude = reports.find((r) => r.name === 'claude');
    const enablement = claude?.files.find((f) => f.label === 'Claude user plugin enablement');
    expect(enablement?.wired).toBe(true);
  });

  it('flags Claude local marketplace when the marketplace catalog is present', async () => {
    await mkdir(join(userHome, '.coodra', 'claude-marketplaces', 'coodra', '.claude-plugin'), { recursive: true });
    await writeFile(
      join(userHome, '.coodra', 'claude-marketplaces', 'coodra', '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'coodra', owner: { name: 'Coodra' }, plugins: [] }, null, 2),
      'utf8',
    );
    const reports = await buildAgentReports({ cwd, userHome });
    const claude = reports.find((r) => r.name === 'claude');
    const marketplace = claude?.files.find((f) => f.label === 'Claude local marketplace');
    expect(marketplace?.wired).toBe(true);
  });

  it('flags Claude plugin MCP as partial (exists, not wired) when coodra entry is missing', async () => {
    await mkdir(claudePluginRoot(), { recursive: true });
    await writeFile(
      join(claudePluginRoot(), '.mcp.json'),
      JSON.stringify({ mcpServers: { othersrv: { command: 'other' } } }, null, 2),
      'utf8',
    );
    const reports = await buildAgentReports({ cwd, userHome });
    const claude = reports.find((r) => r.name === 'claude');
    const mcp = claude?.files.find((f) => f.label === 'Claude plugin MCP');
    expect(mcp?.exists).toBe(true);
    expect(mcp?.wired).toBe(false);
  });

  it('flags Claude plugin hooks as wired when lifecycle hooks are present', async () => {
    await mkdir(join(claudePluginRoot(), 'hooks'), { recursive: true });
    await writeFile(
      join(claudePluginRoot(), 'hooks', 'hooks.json'),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }] }],
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    const reports = await buildAgentReports({ cwd, userHome });
    const claude = reports.find((r) => r.name === 'claude');
    const hooks = claude?.files.find((f) => f.label === 'Claude plugin hooks');
    expect(hooks?.wired).toBe(true);
  });

  it('does not report repo-level CLAUDE.md for the global Claude plugin', async () => {
    await writeFile(
      join(cwd, 'CLAUDE.md'),
      '# My rules\n\n<!-- coodra:start -->\nblock\n<!-- coodra:end -->\n',
      'utf8',
    );
    const reports = await buildAgentReports({ cwd, userHome });
    const claude = reports.find((r) => r.name === 'claude');
    expect(claude?.files.some((f) => f.label === 'CLAUDE.md')).toBe(false);
  });

  it('flags Codex plugin MCP as wired when it carries the coodra entry', async () => {
    await mkdir(codexPluginRoot(), { recursive: true });
    await writeFile(
      join(codexPluginRoot(), '.mcp.json'),
      JSON.stringify({ mcpServers: { coodra: { command: 'node' } } }, null, 2),
      'utf8',
    );
    const reports = await buildAgentReports({ cwd, userHome });
    const codex = reports.find((r) => r.name === 'codex');
    const cfg = codex?.files.find((f) => f.label === 'Codex plugin MCP');
    expect(cfg?.wired).toBe(true);
  });
});

describe('runAgentsCommand', () => {
  let userHome: string;
  let cwd: string;
  const captured: { stdout: string[]; stderr: string[]; exit: number | null } = {
    stdout: [],
    stderr: [],
    exit: null,
  };

  beforeEach(async () => {
    userHome = await mkdtemp(join(tmpdir(), 'coodra-agents-cmd-home-'));
    cwd = await mkdtemp(join(tmpdir(), 'coodra-agents-cmd-cwd-'));
    captured.stdout = [];
    captured.stderr = [];
    captured.exit = null;
  });

  it('emits JSON when --json is passed, with the canonical report shape', async () => {
    await expect(
      runAgentsCommand(
        { json: true, cwd, userHome },
        {
          writeStdout: (c) => {
            captured.stdout.push(c);
          },
          writeStderr: (c) => {
            captured.stderr.push(c);
          },
          exit: ((code: number) => {
            captured.exit = code;
            throw new Error('exit'); // sentinel so we exit the promise
          }) as never,
        },
      ),
    ).rejects.toThrow();
    expect(captured.exit).toBe(0);
    const parsed = JSON.parse(captured.stdout.join('')) as Array<{ name: string; files: unknown[] }>;
    expect(parsed.map((r) => r.name)).toEqual(['claude', 'codex', 'cursor', 'devin', 'antigravity']);
    expect(parsed.every((r) => Array.isArray(r.files))).toBe(true);
  });

  it('renders a human-readable table with one section per agent', async () => {
    await expect(
      runAgentsCommand(
        { cwd, userHome },
        {
          writeStdout: (c) => {
            captured.stdout.push(c);
          },
          writeStderr: (c) => {
            captured.stderr.push(c);
          },
          exit: ((code: number) => {
            captured.exit = code;
            throw new Error('exit');
          }) as never,
        },
      ),
    ).rejects.toThrow();
    expect(captured.exit).toBe(0);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI for assertion.
    const out = captured.stdout.join('').replace(/\x1b\[[0-9;]*m/g, '');
    expect(out).toContain('Claude Code');
    expect(out).toContain('Codex');
    expect(out).toContain('Cursor');
    expect(out).toContain('coodra agent add');
  });
});
