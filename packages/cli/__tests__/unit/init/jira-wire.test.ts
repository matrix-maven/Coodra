import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ATLASSIAN_URL_HOST,
  buildJiraEntry,
  CODEX_REMOTE_TOPLEVEL,
  findForeignAtlassianServer,
  JIRA_SERVER_NAME,
  jiraConfigPath,
  ROVO_MCP_URL,
  readJiraPresence,
  unwireJira,
  wireJira,
} from '../../../src/lib/init/jira-wire.js';

/**
 * Locks Module 09 Track 9A (Jira = Direct, ADR-016). `jira-wire.ts` wires
 * Atlassian's own remote MCP server ("Rovo") into each agent config —
 * NATIVE remote entries only, no `mcp-remote` shim (decision 2026-05-31):
 *
 *   - Claude Code → `{ type: 'http', url }` in `<cwd>/.mcp.json`
 *   - Cursor      → `{ url }`            in `<cwd>/.cursor/mcp.json`
 *   - Windsurf    → `{ serverUrl }`      in `<home>/.codeium/windsurf/mcp_config.json`
 *   - Codex       → `[mcp_servers.atlassian] url = …` in `<cwd>/.codex/config.toml`
 *                   PLUS the top-level `experimental_use_rmcp_client = true` flag
 *
 * Same idempotent / never-clobber guarantees as the Graphify writer, on
 * the same 9·Core substrate.
 */

describe('buildJiraEntry — native remote shape per client', () => {
  it('Claude Code → { type: "http", url }', () => {
    expect(buildJiraEntry('claude')).toEqual({ type: 'http', url: ROVO_MCP_URL });
  });
  it('Cursor → bare { url }', () => {
    expect(buildJiraEntry('cursor')).toEqual({ url: ROVO_MCP_URL });
  });
  it('Windsurf → { serverUrl }', () => {
    expect(buildJiraEntry('windsurf')).toEqual({ serverUrl: ROVO_MCP_URL });
  });
  it('Codex → bare { url } (the rmcp flag is top-level, set by wireJira)', () => {
    expect(buildJiraEntry('codex')).toEqual({ url: ROVO_MCP_URL });
  });
  it('the endpoint is the Streamable HTTP authv2 URL, never the deprecated /sse', () => {
    expect(ROVO_MCP_URL).toBe('https://mcp.atlassian.com/v1/mcp/authv2');
    expect(ROVO_MCP_URL).not.toContain('/sse');
  });
});

describe('jiraConfigPath', () => {
  it('resolves each agent config path (project-scoped except Windsurf)', () => {
    expect(jiraConfigPath('claude', '/repo', '/home/u')).toBe('/repo/.mcp.json');
    expect(jiraConfigPath('cursor', '/repo', '/home/u')).toBe('/repo/.cursor/mcp.json');
    expect(jiraConfigPath('windsurf', '/repo', '/home/u')).toBe('/home/u/.codeium/windsurf/mcp_config.json');
    expect(jiraConfigPath('codex', '/repo', '/home/u')).toBe('/repo/.codex/config.toml');
  });
});

describe('wireJira — JSON agents (Claude Code / Cursor / Windsurf)', () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-jira-cwd-'));
    home = await mkdtemp(join(tmpdir(), 'coodra-jira-home-'));
  });

  it('Claude Code: greenfield writes a native http remote entry', async () => {
    const result = await wireJira({ ide: 'claude', cwd, userHome: home, force: false, dryRun: false });
    expect(result.action).toBe('wrote');
    const parsed = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'));
    expect(parsed.mcpServers.atlassian).toEqual({ type: 'http', url: ROVO_MCP_URL });
  });

  it('Cursor: writes a bare { url } entry under .cursor/mcp.json', async () => {
    await wireJira({ ide: 'cursor', cwd, userHome: home, force: false, dryRun: false });
    const parsed = JSON.parse(await readFile(join(cwd, '.cursor', 'mcp.json'), 'utf8'));
    expect(parsed.mcpServers.atlassian).toEqual({ url: ROVO_MCP_URL });
  });

  it('Windsurf: writes { serverUrl } into the global mcp_config.json under userHome', async () => {
    await wireJira({ ide: 'windsurf', cwd, userHome: home, force: false, dryRun: false });
    const parsed = JSON.parse(await readFile(join(home, '.codeium', 'windsurf', 'mcp_config.json'), 'utf8'));
    expect(parsed.mcpServers.atlassian).toEqual({ serverUrl: ROVO_MCP_URL });
  });

  it('is idempotent — a second wire is unchanged', async () => {
    await wireJira({ ide: 'claude', cwd, userHome: home, force: false, dryRun: false });
    const second = await wireJira({ ide: 'claude', cwd, userHome: home, force: false, dryRun: false });
    expect(second.action).toBe('unchanged');
    expect(second.notes).toContain('already matches');
  });

  it("preserves a sibling `coodra` entry (merge-don't-clobber)", async () => {
    const filePath = join(cwd, '.mcp.json');
    await writeFile(
      filePath,
      `${JSON.stringify({ mcpServers: { coodra: { command: 'node', args: ['/abs/mcp-server.js'] } } }, null, 2)}\n`,
      'utf8',
    );
    const result = await wireJira({ ide: 'claude', cwd, userHome: home, force: false, dryRun: false });
    expect(result.action).toBe('merged');
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    expect(parsed.mcpServers.coodra).toEqual({ command: 'node', args: ['/abs/mcp-server.js'] });
    expect(parsed.mcpServers.atlassian).toEqual({ type: 'http', url: ROVO_MCP_URL });
  });

  it('drift is preserved without --force, overwritten with --force', async () => {
    const filePath = join(cwd, '.mcp.json');
    await writeFile(
      filePath,
      `${JSON.stringify({ mcpServers: { atlassian: { url: 'https://example.test/custom' } } }, null, 2)}\n`,
      'utf8',
    );
    const held = await wireJira({ ide: 'claude', cwd, userHome: home, force: false, dryRun: false });
    expect(held.action).toBe('unchanged');
    expect(held.notes).toContain('--force');
    expect(JSON.parse(await readFile(filePath, 'utf8')).mcpServers.atlassian).toEqual({
      url: 'https://example.test/custom',
    });

    const forced = await wireJira({ ide: 'claude', cwd, userHome: home, force: true, dryRun: false });
    expect(forced.action).toBe('forced');
    expect(JSON.parse(await readFile(filePath, 'utf8')).mcpServers.atlassian).toEqual({
      type: 'http',
      url: ROVO_MCP_URL,
    });
  });

  it('dry-run writes nothing', async () => {
    const result = await wireJira({ ide: 'claude', cwd, userHome: home, force: false, dryRun: true });
    expect(result.action).toBe('wrote');
    await expect(readFile(join(cwd, '.mcp.json'), 'utf8')).rejects.toThrow();
  });
});

describe('wireJira — Codex (TOML, remote needs the top-level rmcp flag)', () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-jira-codex-cwd-'));
    home = await mkdtemp(join(tmpdir(), 'coodra-jira-codex-home-'));
  });

  it('greenfield: writes the url table AND experimental_use_rmcp_client = true', async () => {
    const result = await wireJira({ ide: 'codex', cwd, userHome: home, force: false, dryRun: false });
    expect(result.action).toBe('wrote');
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as Record<string, unknown>;
    expect((parsed.mcp_servers as Record<string, unknown>).atlassian).toEqual({ url: ROVO_MCP_URL });
    expect(parsed.experimental_use_rmcp_client).toBe(true);
  });

  it('the CODEX_REMOTE_TOPLEVEL constant is the rmcp flag', () => {
    expect(CODEX_REMOTE_TOPLEVEL).toEqual({ experimental_use_rmcp_client: true });
  });

  it('is idempotent once the entry + flag are both present', async () => {
    await wireJira({ ide: 'codex', cwd, userHome: home, force: false, dryRun: false });
    const second = await wireJira({ ide: 'codex', cwd, userHome: home, force: false, dryRun: false });
    expect(second.action).toBe('unchanged');
  });

  it('entry present but flag missing → re-wire SETS the flag (action merged)', async () => {
    // A user/older config with the atlassian table but no rmcp flag — the
    // remote server would be inert. wireJira must repair it.
    const filePath = join(cwd, '.codex', 'config.toml');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(cwd, '.codex'), { recursive: true });
    await writeFile(filePath, `${stringifyToml({ mcp_servers: { atlassian: { url: ROVO_MCP_URL } } })}\n`, 'utf8');

    const result = await wireJira({ ide: 'codex', cwd, userHome: home, force: false, dryRun: false });
    expect(result.action).toBe('merged');
    const parsed = parseToml(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    expect(parsed.experimental_use_rmcp_client).toBe(true);
  });

  it('preserves a sibling coodra table + a pre-existing unrelated top-level key', async () => {
    const filePath = join(cwd, '.codex', 'config.toml');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(cwd, '.codex'), { recursive: true });
    await writeFile(
      filePath,
      `${stringifyToml({ model: 'gpt-5', mcp_servers: { coodra: { command: 'node', args: ['/abs/s.js'] } } })}\n`,
      'utf8',
    );
    await wireJira({ ide: 'codex', cwd, userHome: home, force: false, dryRun: false });
    const parsed = parseToml(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    expect(parsed.model).toBe('gpt-5');
    expect((parsed.mcp_servers as Record<string, unknown>).coodra).toEqual({ command: 'node', args: ['/abs/s.js'] });
    expect((parsed.mcp_servers as Record<string, unknown>).atlassian).toEqual({ url: ROVO_MCP_URL });
    expect(parsed.experimental_use_rmcp_client).toBe(true);
  });
});

describe('unwireJira', () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-jira-unwire-cwd-'));
    home = await mkdtemp(join(tmpdir(), 'coodra-jira-unwire-home-'));
  });

  it('removes the atlassian entry, leaving coodra (Claude Code)', async () => {
    const filePath = join(cwd, '.mcp.json');
    await writeFile(
      filePath,
      `${JSON.stringify({ mcpServers: { coodra: { command: 'node' }, atlassian: { type: 'http', url: ROVO_MCP_URL } } }, null, 2)}\n`,
      'utf8',
    );
    const result = await unwireJira({ ide: 'claude', cwd, userHome: home, dryRun: false });
    expect(result.action).toBe('merged');
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    expect(parsed.mcpServers.atlassian).toBeUndefined();
    expect(parsed.mcpServers.coodra).toEqual({ command: 'node' });
  });

  it('missing file / missing entry is a no-op', async () => {
    const result = await unwireJira({ ide: 'claude', cwd, userHome: home, dryRun: false });
    expect(result.action).toBe('unchanged');
  });

  it('Codex: removes the atlassian table but LEAVES the global rmcp flag', async () => {
    // The flag is global — another remote server may still need it.
    await wireJira({ ide: 'codex', cwd, userHome: home, force: false, dryRun: false });
    const result = await unwireJira({ ide: 'codex', cwd, userHome: home, dryRun: false });
    expect(result.action).toBe('merged');
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as Record<string, unknown>;
    expect((parsed.mcp_servers as Record<string, unknown>).atlassian).toBeUndefined();
    expect(parsed.experimental_use_rmcp_client).toBe(true);
  });
});

describe('readJiraPresence', () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-jira-presence-cwd-'));
    home = await mkdtemp(join(tmpdir(), 'coodra-jira-presence-home-'));
  });

  it('reports exists:false when there is no config', async () => {
    expect(await readJiraPresence({ ide: 'claude', cwd, userHome: home })).toEqual({
      exists: false,
      wired: false,
      unreadable: false,
      foreignKey: null,
    });
  });

  it('reports wired:true after wireJira, wired:false after unwireJira (JSON)', async () => {
    await wireJira({ ide: 'cursor', cwd, userHome: home, force: false, dryRun: false });
    expect(await readJiraPresence({ ide: 'cursor', cwd, userHome: home })).toMatchObject({ exists: true, wired: true });
    await unwireJira({ ide: 'cursor', cwd, userHome: home, dryRun: false });
    expect(await readJiraPresence({ ide: 'cursor', cwd, userHome: home })).toMatchObject({
      exists: true,
      wired: false,
    });
  });

  it('reports wired:true for a Codex TOML entry', async () => {
    await wireJira({ ide: 'codex', cwd, userHome: home, force: false, dryRun: false });
    expect(await readJiraPresence({ ide: 'codex', cwd, userHome: home })).toMatchObject({ exists: true, wired: true });
  });

  it('reports unreadable:true on a corrupt JSON config', async () => {
    await writeFile(join(cwd, '.mcp.json'), '{ not json', 'utf8');
    expect(await readJiraPresence({ ide: 'claude', cwd, userHome: home })).toMatchObject({
      exists: true,
      unreadable: true,
    });
  });

  it('the server key is the canonical "atlassian"', () => {
    expect(JIRA_SERVER_NAME).toBe('atlassian');
  });

  it('sets foreignKey when a foreign Atlassian entry exists alongside wired:false', async () => {
    await writeFile(
      join(cwd, '.mcp.json'),
      `${JSON.stringify(
        { mcpServers: { 'atlassian-mcp-server': { serverUrl: 'https://mcp.atlassian.com/v1/mcp', disabled: true } } },
        null,
        2,
      )}\n`,
      'utf8',
    );
    expect(await readJiraPresence({ ide: 'claude', cwd, userHome: home })).toEqual({
      exists: true,
      wired: false,
      unreadable: false,
      foreignKey: 'atlassian-mcp-server',
    });
  });

  it('foreignKey stays null when only the coodra-managed `atlassian` entry exists (wired:true)', async () => {
    await wireJira({ ide: 'claude', cwd, userHome: home, force: false, dryRun: false });
    expect(await readJiraPresence({ ide: 'claude', cwd, userHome: home })).toEqual({
      exists: true,
      wired: true,
      unreadable: false,
      foreignKey: null,
    });
  });
});

// Field bug 2026-07-12: `coodra jira enable` keyed only on the literal
// `atlassian` name, so a user whose IDE already carried an Atlassian MCP
// server under a different key (e.g. `atlassian-mcp-server`) ended up
// with TWO Atlassian servers. `findForeignAtlassianServer` is the
// content-based detector callers use to ask/skip instead.
describe('findForeignAtlassianServer', () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-jira-foreign-cwd-'));
    home = await mkdtemp(join(tmpdir(), 'coodra-jira-foreign-home-'));
  });

  it('the needle host covers every Rovo endpoint variant', () => {
    expect(ATLASSIAN_URL_HOST).toBe('mcp.atlassian.com');
    expect(ROVO_MCP_URL).toContain(ATLASSIAN_URL_HOST);
  });

  it('finds `atlassian-mcp-server` in the Windsurf serverUrl shape, even disabled', async () => {
    const configPath = join(home, '.codeium', 'windsurf', 'mcp_config.json');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(home, '.codeium', 'windsurf'), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify(
        { mcpServers: { 'atlassian-mcp-server': { serverUrl: 'https://mcp.atlassian.com/v1/mcp', disabled: true } } },
        null,
        2,
      )}\n`,
      'utf8',
    );
    expect(await findForeignAtlassianServer({ ide: 'windsurf', cwd, userHome: home })).toEqual({
      ide: 'windsurf',
      configPath,
      key: 'atlassian-mcp-server',
    });
  });

  it("returns null when only Coodra's own `atlassian` entry is wired", async () => {
    await wireJira({ ide: 'claude', cwd, userHome: home, force: false, dryRun: false });
    expect(await findForeignAtlassianServer({ ide: 'claude', cwd, userHome: home })).toBeNull();
  });

  it('finds a differently-keyed Atlassian table in Codex TOML', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(cwd, '.codex'), { recursive: true });
    const configPath = join(cwd, '.codex', 'config.toml');
    await writeFile(configPath, '[mcp_servers.my-jira]\nurl = "https://mcp.atlassian.com/v1/mcp"\n', 'utf8');
    expect(await findForeignAtlassianServer({ ide: 'codex', cwd, userHome: home })).toEqual({
      ide: 'codex',
      configPath,
      key: 'my-jira',
    });
  });

  it('returns null when the config file is missing', async () => {
    expect(await findForeignAtlassianServer({ ide: 'cursor', cwd, userHome: home })).toBeNull();
  });
});
