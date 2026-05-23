import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  mergeExternalCodexServer,
  readExternalCodexServerPresence,
  removeExternalCodexServer,
} from '../../../src/lib/init/external-codex-merge.js';
import type { ExternalMcpEntry } from '../../../src/lib/init/external-mcp-merge.js';

/**
 * Locks the Module 09 9·Core TOML writer — the generalised
 * reader/writer for a single named MCP server entry inside a
 * `.codex/config.toml`-shaped file. Unlike `codex-merge.ts` (hardcoded
 * to the `coodra` key + `<cwd>/.codex/config.toml`), this module
 * parameterises both the entry `name` and the absolute `filePath`.
 *
 *   1. Greenfield — absent file → created, with the parent dir mkdir'd.
 *   2. Idempotent — a re-run that finds an identical entry is unchanged.
 *   3. Merge-don't-clobber — sibling tables (incl. `coodra`) survive.
 *   4. Drift preserved without --force; overwritten with --force.
 *   5. Dry-run writes nothing.
 *   6. Order-insensitive equality (canonical key sort).
 *   7. The entry `name` and `filePath` are honoured verbatim.
 *   8. removeExternalCodexServer strips only the named entry.
 *   9. readExternalCodexServerPresence is a faithful read-only probe.
 */

const ENTRY: ExternalMcpEntry = {
  command: 'python3',
  args: ['-m', 'graphify.serve', 'graphify-out/graph.json'],
};

function tomlServers(raw: string): Record<string, { command?: string }> {
  return (parseToml(raw) as { mcp_servers?: Record<string, { command?: string }> }).mcp_servers ?? {};
}

describe('mergeExternalCodexServer', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'coodra-ext-codex-merge-'));
  });

  it('greenfield: creates the config file (and mkdir -p its parent dir)', async () => {
    const filePath = join(dir, '.codex', 'config.toml');
    const result = await mergeExternalCodexServer({
      filePath,
      name: 'graphify',
      entry: ENTRY,
      force: false,
      dryRun: false,
    });
    expect(result.action).toBe('wrote');
    expect(tomlServers(await readFile(filePath, 'utf8')).graphify?.command).toBe('python3');
  });

  it('is idempotent — a second identical merge is unchanged', async () => {
    const filePath = join(dir, 'config.toml');
    await mergeExternalCodexServer({ filePath, name: 'graphify', entry: ENTRY, force: false, dryRun: false });
    const second = await mergeExternalCodexServer({
      filePath,
      name: 'graphify',
      entry: ENTRY,
      force: false,
      dryRun: false,
    });
    expect(second.action).toBe('unchanged');
    expect(second.notes).toContain('already matches');
  });

  it("merge-don't-clobber: preserves sibling MCP servers, including `coodra`", async () => {
    const filePath = join(dir, 'config.toml');
    await writeFile(
      filePath,
      '[mcp_servers.coodra]\ncommand = "node"\n\n[mcp_servers.memory]\ncommand = "npx"\n',
      'utf8',
    );
    const result = await mergeExternalCodexServer({
      filePath,
      name: 'graphify',
      entry: ENTRY,
      force: false,
      dryRun: false,
    });
    expect(result.action).toBe('merged');
    const servers = tomlServers(await readFile(filePath, 'utf8'));
    expect(servers.coodra?.command).toBe('node');
    expect(servers.memory?.command).toBe('npx');
    expect(servers.graphify?.command).toBe('python3');
  });

  it('preserves any other top-level tables / keys in the config file', async () => {
    const filePath = join(dir, 'config.toml');
    await writeFile(filePath, 'model = "gpt-5"\n\n[mcp_servers.coodra]\ncommand = "node"\n', 'utf8');
    await mergeExternalCodexServer({ filePath, name: 'graphify', entry: ENTRY, force: false, dryRun: false });
    const parsed = parseToml(await readFile(filePath, 'utf8')) as { model?: string };
    expect(parsed.model).toBe('gpt-5');
  });

  it('preserves a drifted entry without --force', async () => {
    const filePath = join(dir, 'config.toml');
    await writeFile(filePath, '[mcp_servers.graphify]\ncommand = "custom"\n', 'utf8');
    const result = await mergeExternalCodexServer({
      filePath,
      name: 'graphify',
      entry: ENTRY,
      force: false,
      dryRun: false,
    });
    expect(result.action).toBe('unchanged');
    expect(result.notes).toContain('--force');
    expect(tomlServers(await readFile(filePath, 'utf8')).graphify?.command).toBe('custom');
  });

  it('--force overwrites a drifted entry', async () => {
    const filePath = join(dir, 'config.toml');
    await writeFile(filePath, '[mcp_servers.graphify]\ncommand = "custom"\n', 'utf8');
    const result = await mergeExternalCodexServer({
      filePath,
      name: 'graphify',
      entry: ENTRY,
      force: true,
      dryRun: false,
    });
    expect(result.action).toBe('forced');
    expect(tomlServers(await readFile(filePath, 'utf8')).graphify?.command).toBe('python3');
  });

  it('dry-run writes nothing to disk (greenfield)', async () => {
    const filePath = join(dir, 'config.toml');
    const result = await mergeExternalCodexServer({
      filePath,
      name: 'graphify',
      entry: ENTRY,
      force: false,
      dryRun: true,
    });
    expect(result.action).toBe('wrote');
    await expect(readFile(filePath, 'utf8')).rejects.toThrow();
  });

  it('dry-run writes nothing to disk (merge into existing)', async () => {
    const filePath = join(dir, 'config.toml');
    await writeFile(filePath, '[mcp_servers.coodra]\ncommand = "node"\n', 'utf8');
    const result = await mergeExternalCodexServer({
      filePath,
      name: 'graphify',
      entry: ENTRY,
      force: false,
      dryRun: true,
    });
    expect(result.action).toBe('merged');
    expect(tomlServers(await readFile(filePath, 'utf8')).graphify).toBeUndefined();
  });

  it('entry equality is order-insensitive (canonical key sort)', async () => {
    const filePath = join(dir, 'config.toml');
    const envEntry: ExternalMcpEntry = { command: 'python3', env: { B: '2', A: '1' } };
    await writeFile(
      filePath,
      '[mcp_servers.graphify]\ncommand = "python3"\n\n[mcp_servers.graphify.env]\nA = "1"\nB = "2"\n',
      'utf8',
    );
    const result = await mergeExternalCodexServer({
      filePath,
      name: 'graphify',
      entry: envEntry,
      force: false,
      dryRun: false,
    });
    expect(result.action).toBe('unchanged');
    expect(result.notes).toContain('already matches');
  });

  it('honours an arbitrary entry name (not hardcoded to `coodra`/`graphify`)', async () => {
    const filePath = join(dir, 'config.toml');
    await mergeExternalCodexServer({ filePath, name: 'atlassian', entry: ENTRY, force: false, dryRun: false });
    expect(tomlServers(await readFile(filePath, 'utf8')).atlassian?.command).toBe('python3');
  });

  it('throws a structured error when the existing file is not valid TOML', async () => {
    const filePath = join(dir, 'config.toml');
    await writeFile(filePath, '[unclosed table header\n', 'utf8');
    await expect(
      mergeExternalCodexServer({ filePath, name: 'graphify', entry: ENTRY, force: false, dryRun: false }),
    ).rejects.toThrow(/Cannot parse/);
  });
});

describe('removeExternalCodexServer', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'coodra-ext-codex-remove-'));
  });

  it('strips only the named entry; siblings survive', async () => {
    const filePath = join(dir, 'config.toml');
    await writeFile(
      filePath,
      '[mcp_servers.coodra]\ncommand = "node"\n\n[mcp_servers.graphify]\ncommand = "python3"\n',
      'utf8',
    );
    const result = await removeExternalCodexServer({ filePath, name: 'graphify', dryRun: false });
    expect(result.action).toBe('merged');
    const servers = tomlServers(await readFile(filePath, 'utf8'));
    expect(servers.graphify).toBeUndefined();
    expect(servers.coodra?.command).toBe('node');
  });

  it('is a no-op when the file is absent', async () => {
    const result = await removeExternalCodexServer({
      filePath: join(dir, 'config.toml'),
      name: 'graphify',
      dryRun: false,
    });
    expect(result.action).toBe('unchanged');
  });

  it('is a no-op when the named entry is absent', async () => {
    const filePath = join(dir, 'config.toml');
    await writeFile(filePath, '[mcp_servers.coodra]\ncommand = "node"\n', 'utf8');
    const result = await removeExternalCodexServer({ filePath, name: 'graphify', dryRun: false });
    expect(result.action).toBe('unchanged');
  });

  it('dry-run writes nothing to disk', async () => {
    const filePath = join(dir, 'config.toml');
    await writeFile(filePath, '[mcp_servers.graphify]\ncommand = "python3"\n', 'utf8');
    const result = await removeExternalCodexServer({ filePath, name: 'graphify', dryRun: true });
    expect(result.action).toBe('merged');
    expect(tomlServers(await readFile(filePath, 'utf8')).graphify?.command).toBe('python3');
  });
});

describe('readExternalCodexServerPresence', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'coodra-ext-codex-presence-'));
  });

  it('reports an absent file', async () => {
    const presence = await readExternalCodexServerPresence({ filePath: join(dir, 'config.toml'), name: 'graphify' });
    expect(presence).toEqual({ exists: false, wired: false, unreadable: false });
  });

  it('reports a present, wired file', async () => {
    const filePath = join(dir, 'config.toml');
    await writeFile(filePath, '[mcp_servers.graphify]\ncommand = "python3"\n', 'utf8');
    const presence = await readExternalCodexServerPresence({ filePath, name: 'graphify' });
    expect(presence).toEqual({ exists: true, wired: true, unreadable: false });
  });

  it('reports a present file with no named entry', async () => {
    const filePath = join(dir, 'config.toml');
    await writeFile(filePath, '[mcp_servers.coodra]\ncommand = "node"\n', 'utf8');
    const presence = await readExternalCodexServerPresence({ filePath, name: 'graphify' });
    expect(presence).toEqual({ exists: true, wired: false, unreadable: false });
  });

  it('reports an unreadable (invalid TOML) file', async () => {
    const filePath = join(dir, 'config.toml');
    await writeFile(filePath, '[unclosed table header\n', 'utf8');
    const presence = await readExternalCodexServerPresence({ filePath, name: 'graphify' });
    expect(presence).toEqual({ exists: true, wired: false, unreadable: true });
  });
});
