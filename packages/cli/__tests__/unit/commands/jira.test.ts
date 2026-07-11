import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type JiraIO,
  runJiraDisableCommand,
  runJiraEnableCommand,
  runJiraStatusCommand,
} from '../../../src/commands/jira.js';

/**
 * Locks the Module 09 Track 9A `coodra jira {enable,disable,status}`
 * command surface (Jira = Direct, ADR-016). The handlers operate over
 * filesystem state only (no DB, no daemon), wiring Atlassian's own remote
 * MCP server ("Rovo") into each agent config via the 9·Core substrate —
 * NATIVE remote entries only, no `mcp-remote` shim.
 *
 *   - enable writes an `atlassian` entry; preserves `coodra` + siblings.
 *   - Claude Code → `{ type: 'http', url }`; Cursor → `{ url }`;
 *     Windsurf → `{ serverUrl }`; Codex → `url` table + top-level
 *     `experimental_use_rmcp_client = true`.
 *   - disable strips only the `atlassian` entry (Codex flag stays).
 *   - status is a read-only probe across all four agents.
 *   - bad / empty IDE selection exits user-recoverable (1).
 */

const ROVO = 'https://mcp.atlassian.com/v1/mcp/authv2';

interface Captured {
  readonly io: JiraIO;
  stdout(): string;
  stderr(): string;
  readonly exitCode: () => number | null;
}

function makeIO(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  let code: number | null = null;
  const io: JiraIO = {
    writeStdout: (c) => {
      out.push(c);
    },
    writeStderr: (c) => {
      err.push(c);
    },
    exit: ((c: number) => {
      code = c;
      throw new Error(`__exit__:${c}`);
    }) as never,
  };
  return {
    io,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    exitCode: () => code,
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI for assertion.
const ANSI = /\x1b\[[0-9;]*m/g;

describe('runJiraEnableCommand', () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-jira-enable-cwd-'));
    home = await mkdtemp(join(tmpdir(), 'coodra-jira-enable-home-'));
  });

  it('wires a native http `atlassian` entry into <cwd>/.mcp.json for --ide claude', async () => {
    const c = makeIO();
    await expect(runJiraEnableCommand({ ide: 'claude', cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(0);
    const parsed = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'));
    expect(parsed.mcpServers.atlassian).toEqual({ type: 'http', url: ROVO });
  });

  it('Cursor gets a bare { url } entry', async () => {
    const c = makeIO();
    await expect(runJiraEnableCommand({ ide: 'cursor', cwd, userHome: home }, c.io)).rejects.toThrow();
    const parsed = JSON.parse(await readFile(join(cwd, '.cursor', 'mcp.json'), 'utf8'));
    expect(parsed.mcpServers.atlassian).toEqual({ url: ROVO });
  });

  it('Windsurf gets a { serverUrl } entry in the global config', async () => {
    const c = makeIO();
    await expect(runJiraEnableCommand({ ide: 'windsurf', cwd, userHome: home }, c.io)).rejects.toThrow();
    const parsed = JSON.parse(await readFile(join(home, '.codeium', 'windsurf', 'mcp_config.json'), 'utf8'));
    expect(parsed.mcpServers.atlassian).toEqual({ serverUrl: ROVO });
  });

  it('writes a real [mcp_servers.atlassian] table + the rmcp flag for --ide codex', async () => {
    const c = makeIO();
    await expect(runJiraEnableCommand({ ide: 'codex', cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(0);
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as {
      mcp_servers: { atlassian: { url: string } };
      experimental_use_rmcp_client?: boolean;
    };
    expect(parsed.mcp_servers.atlassian).toEqual({ url: ROVO });
    expect(parsed.experimental_use_rmcp_client).toBe(true);
  });

  it('preserves the `coodra` entry and any sibling MCP servers', async () => {
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { coodra: { command: 'node' }, memory: { command: 'npx' } } }, null, 2),
      'utf8',
    );
    const c = makeIO();
    await expect(runJiraEnableCommand({ ide: 'claude', cwd, userHome: home }, c.io)).rejects.toThrow();
    const parsed = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'));
    expect(parsed.mcpServers.coodra.command).toBe('node');
    expect(parsed.mcpServers.memory.command).toBe('npx');
    expect(parsed.mcpServers.atlassian).toEqual({ type: 'http', url: ROVO });
  });

  it('is idempotent — a second enable is a no-op', async () => {
    const first = makeIO();
    await expect(runJiraEnableCommand({ ide: 'claude', json: true, cwd, userHome: home }, first.io)).rejects.toThrow();
    expect(JSON.parse(first.stdout()).results[0].action).toBe('wrote');
    const second = makeIO();
    await expect(runJiraEnableCommand({ ide: 'claude', json: true, cwd, userHome: home }, second.io)).rejects.toThrow();
    expect(JSON.parse(second.stdout()).results[0].action).toBe('unchanged');
  });

  it('leaves a drifted entry untouched without --force; --force overwrites', async () => {
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { atlassian: { url: 'https://example.test/custom' } } }, null, 2),
      'utf8',
    );
    const held = makeIO();
    await expect(runJiraEnableCommand({ ide: 'claude', cwd, userHome: home }, held.io)).rejects.toThrow();
    expect(JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8')).mcpServers.atlassian).toEqual({
      url: 'https://example.test/custom',
    });
    const forced = makeIO();
    await expect(
      runJiraEnableCommand({ ide: 'claude', force: true, cwd, userHome: home }, forced.io),
    ).rejects.toThrow();
    expect(JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8')).mcpServers.atlassian).toEqual({
      type: 'http',
      url: ROVO,
    });
  });

  it('--dry-run writes nothing to disk', async () => {
    const c = makeIO();
    await expect(runJiraEnableCommand({ ide: 'claude', dryRun: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    await expect(readFile(join(cwd, '.mcp.json'), 'utf8')).rejects.toThrow();
  });

  it('--ide all wires all four agents, Codex (with the rmcp flag) included', async () => {
    const c = makeIO();
    await expect(runJiraEnableCommand({ ide: 'all', json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const report = JSON.parse(c.stdout());
    expect(report.ok).toBe(true);
    expect(report.url).toBe(ROVO);
    const byIde = Object.fromEntries(report.results.map((r: { ide: string; action: string }) => [r.ide, r.action]));
    expect(byIde).toEqual({ claude: 'wrote', cursor: 'wrote', windsurf: 'wrote', codex: 'wrote' });
    const codexCfg = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as {
      experimental_use_rmcp_client?: boolean;
    };
    expect(codexCfg.experimental_use_rmcp_client).toBe(true);
  });

  it('autodetects installed agents when --ide is omitted', async () => {
    await mkdir(join(home, '.claude'));
    const c = makeIO();
    await expect(runJiraEnableCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(JSON.parse(c.stdout()).results.map((r: { ide: string }) => r.ide)).toEqual(['claude']);
  });

  it('exits user-recoverable (1) when no IDE is detected and none is named', async () => {
    const c = makeIO();
    await expect(runJiraEnableCommand({ cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(1);
    expect(c.stderr()).toContain('No supported IDE detected');
  });

  it('exits user-recoverable (1) on an unknown --ide value', async () => {
    const c = makeIO();
    await expect(runJiraEnableCommand({ ide: 'intellij', cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(1);
  });

  it('emits the OAuth-completion prerequisite + endpoint + Rovo tool names in human output', async () => {
    const c = makeIO();
    await expect(runJiraEnableCommand({ ide: 'claude', cwd, userHome: home }, c.io)).rejects.toThrow();
    const out = c.stdout().replace(ANSI, '');
    // The one prerequisite: complete OAuth via /mcp.
    expect(out).toContain('/mcp');
    // The endpoint is shown (Streamable HTTP, never /sse).
    expect(out).toContain(ROVO);
    // Tools are framed as Atlassian's, not Coodra's.
    expect(out).toContain('getJiraIssue');
    expect(out).toContain("Atlassian's tools, not Coodra's");
  });
});

// Field fix 2026-07-12: enable used to key only on the literal `atlassian`
// name and blindly added a second Atlassian server next to a user's
// pre-existing entry (e.g. `atlassian-mcp-server`). Now it detects any
// foreign Atlassian entry by content, asks interactively, skips
// non-interactively, and only `--force` proceeds without scanning.
describe('runJiraEnableCommand — pre-existing Atlassian MCP server detection', () => {
  let cwd: string;
  let home: string;

  const FOREIGN_CONFIG = JSON.stringify(
    {
      mcpServers: {
        coodra: { command: 'node' },
        'atlassian-mcp-server': { serverUrl: 'https://mcp.atlassian.com/v1/mcp', disabled: true },
      },
    },
    null,
    2,
  );

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-jira-foreign-cwd-'));
    home = await mkdtemp(join(tmpdir(), 'coodra-jira-foreign-home-'));
    await writeFile(join(cwd, '.mcp.json'), FOREIGN_CONFIG, 'utf8');
  });

  it('non-interactive (--json): skips with action unchanged, notes naming the key and --force', async () => {
    const c = makeIO();
    await expect(runJiraEnableCommand({ ide: 'claude', json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(0);
    const result = JSON.parse(c.stdout()).results[0] as { action: string; notes: string };
    expect(result.action).toBe('unchanged');
    expect(result.notes).toContain('atlassian-mcp-server');
    expect(result.notes).toContain('--force');
    // The file is untouched — no second Atlassian entry.
    const parsed = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'));
    expect(parsed.mcpServers.atlassian).toBeUndefined();
    expect(parsed.mcpServers['atlassian-mcp-server']).toEqual({
      serverUrl: 'https://mcp.atlassian.com/v1/mcp',
      disabled: true,
    });
  });

  it("interactive: readPrompt answering 'y' wires Coodra's entry anyway", async () => {
    const readPrompt = vi.fn(async (_question: string) => 'y');
    const c = makeIO();
    await expect(runJiraEnableCommand({ ide: 'claude', cwd, userHome: home, readPrompt }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(0);
    expect(readPrompt).toHaveBeenCalledTimes(1);
    const question = (readPrompt.mock.calls[0]?.[0] ?? '').replace(ANSI, '');
    expect(question).toContain("Add Coodra's 'atlassian' entry anyway?");
    expect(c.stdout().replace(ANSI, '')).toContain("key 'atlassian-mcp-server'");
    const parsed = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'));
    expect(parsed.mcpServers.atlassian).toEqual({ type: 'http', url: ROVO });
    expect(parsed.mcpServers['atlassian-mcp-server']).toEqual({
      serverUrl: 'https://mcp.atlassian.com/v1/mcp',
      disabled: true,
    });
  });

  it("interactive: readPrompt answering 'n' skips — the file is unchanged", async () => {
    const readPrompt = vi.fn(async (_question: string) => 'n');
    const c = makeIO();
    await expect(runJiraEnableCommand({ ide: 'claude', cwd, userHome: home, readPrompt }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(0);
    expect(readPrompt).toHaveBeenCalledTimes(1);
    expect(await readFile(join(cwd, '.mcp.json'), 'utf8')).toBe(FOREIGN_CONFIG);
    const out = c.stdout().replace(ANSI, '');
    expect(out).toContain("existing Atlassian MCP server (key 'atlassian-mcp-server')");
    expect(out).toContain('--force');
  });

  it('--force wires without scanning — the prompt is never called', async () => {
    const readPrompt = vi.fn(async (_question: string) => 'n');
    const c = makeIO();
    await expect(
      runJiraEnableCommand({ ide: 'claude', force: true, cwd, userHome: home, readPrompt }, c.io),
    ).rejects.toThrow();
    expect(c.exitCode()).toBe(0);
    expect(readPrompt).not.toHaveBeenCalled();
    const parsed = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'));
    expect(parsed.mcpServers.atlassian).toEqual({ type: 'http', url: ROVO });
  });
});

describe('runJiraDisableCommand', () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-jira-disable-cwd-'));
    home = await mkdtemp(join(tmpdir(), 'coodra-jira-disable-home-'));
  });

  it('strips the `atlassian` entry but leaves `coodra` intact', async () => {
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { coodra: { command: 'node' }, atlassian: { type: 'http', url: ROVO } } }, null, 2),
      'utf8',
    );
    const c = makeIO();
    await expect(runJiraDisableCommand({ ide: 'claude', cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(0);
    const parsed = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'));
    expect(parsed.mcpServers.atlassian).toBeUndefined();
    expect(parsed.mcpServers.coodra.command).toBe('node');
  });

  it('Codex disable strips the atlassian table but LEAVES the global rmcp flag', async () => {
    const enable = makeIO();
    await expect(runJiraEnableCommand({ ide: 'codex', cwd, userHome: home }, enable.io)).rejects.toThrow();
    const c = makeIO();
    await expect(runJiraDisableCommand({ ide: 'codex', cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(0);
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as {
      mcp_servers: { atlassian?: unknown };
      experimental_use_rmcp_client?: boolean;
    };
    expect(parsed.mcp_servers.atlassian).toBeUndefined();
    expect(parsed.experimental_use_rmcp_client).toBe(true);
  });

  it('is a no-op when no `atlassian` entry exists', async () => {
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { coodra: { command: 'node' } } }, null, 2),
      'utf8',
    );
    const c = makeIO();
    await expect(runJiraDisableCommand({ ide: 'claude', json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(JSON.parse(c.stdout()).results[0].action).toBe('unchanged');
  });

  it('exits user-recoverable (1) on an unknown --ide value', async () => {
    const c = makeIO();
    await expect(runJiraDisableCommand({ ide: 'nano', cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(1);
  });
});

describe('runJiraStatusCommand', () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-jira-status-cwd-'));
    home = await mkdtemp(join(tmpdir(), 'coodra-jira-status-home-'));
  });

  it('reports every agent as not-wired on a clean tree (--json)', async () => {
    const c = makeIO();
    await expect(runJiraStatusCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    expect(c.exitCode()).toBe(0);
    const report = JSON.parse(c.stdout());
    expect(report.server).toBe('atlassian');
    expect(report.url).toBe(ROVO);
    expect(report.ides.map((i: { ide: string }) => i.ide)).toEqual(['claude', 'cursor', 'windsurf', 'codex']);
    expect(report.ides.every((i: { wired: boolean; exists: boolean }) => i.wired === false)).toBe(true);
  });

  it('reports a wired agent after enable, and probes Codex TOML', async () => {
    const enable = makeIO();
    await expect(runJiraEnableCommand({ ide: 'all', cwd, userHome: home }, enable.io)).rejects.toThrow();
    const c = makeIO();
    await expect(runJiraStatusCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const report = JSON.parse(c.stdout());
    expect(report.ides.every((i: { wired: boolean }) => i.wired === true)).toBe(true);
  });

  it('flags an unreadable config file', async () => {
    await writeFile(join(cwd, '.mcp.json'), '{ not json', 'utf8');
    const c = makeIO();
    await expect(runJiraStatusCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const claude = JSON.parse(c.stdout()).ides.find((i: { ide: string }) => i.ide === 'claude');
    expect(claude).toMatchObject({ exists: true, wired: false, unreadable: true });
  });

  it('renders a human-readable table naming all four agents', async () => {
    const c = makeIO();
    await expect(runJiraStatusCommand({ cwd, userHome: home }, c.io)).rejects.toThrow();
    const out = c.stdout().replace(ANSI, '');
    expect(out).toContain('Claude Code');
    expect(out).toContain('Cursor');
    expect(out).toContain('Windsurf');
    expect(out).toContain('Codex');
  });

  it('surfaces a foreign Atlassian entry in the JSON status (foreignKey on ides[])', async () => {
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify(
        { mcpServers: { 'atlassian-mcp-server': { serverUrl: 'https://mcp.atlassian.com/v1/mcp', disabled: true } } },
        null,
        2,
      ),
      'utf8',
    );
    const c = makeIO();
    await expect(runJiraStatusCommand({ json: true, cwd, userHome: home }, c.io)).rejects.toThrow();
    const report = JSON.parse(c.stdout()) as {
      ides: Array<{ ide: string; wired: boolean; foreignKey: string | null }>;
    };
    const claude = report.ides.find((i) => i.ide === 'claude');
    expect(claude).toMatchObject({ wired: false, foreignKey: 'atlassian-mcp-server' });
    // Every entry carries the field — null when no foreign server exists.
    expect(report.ides.find((i) => i.ide === 'cursor')?.foreignKey).toBeNull();
  });

  it("renders a foreign entry as wired-outside-Coodra in human output ('not Coodra-managed')", async () => {
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify(
        { mcpServers: { 'atlassian-mcp-server': { serverUrl: 'https://mcp.atlassian.com/v1/mcp' } } },
        null,
        2,
      ),
      'utf8',
    );
    const c = makeIO();
    await expect(runJiraStatusCommand({ cwd, userHome: home }, c.io)).rejects.toThrow();
    const out = c.stdout().replace(ANSI, '');
    expect(out).toContain("Atlassian wired under key 'atlassian-mcp-server' (not Coodra-managed)");
    expect(out).toContain('already wired outside Coodra');
  });
});
