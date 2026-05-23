import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type ExternalMcpEntry,
  mergeExternalMcpServer,
  readExternalMcpServerPresence,
  removeExternalMcpServer,
} from '../../../src/lib/init/external-mcp-merge.js';

/**
 * Locks the Module 09 9·Core MCP-config writer — the generalised
 * reader/writer for a single named MCP server entry inside any
 * `.mcp.json`-shaped config file. Unlike `mcp-merge.ts` (hardcoded to
 * the `coodra` key + `<cwd>/.mcp.json`), this module parameterises both
 * the entry `name` and the absolute `filePath`, so any external MCP
 * server (Graphify today, the Atlassian Rovo MCP next) can be wired in.
 *
 *   1. Greenfield — absent file → created, with the parent dir mkdir'd.
 *   2. Idempotent — a re-run that finds an identical entry is unchanged.
 *   3. Merge-don't-clobber — sibling entries (incl. `coodra`) survive.
 *   4. Drift preserved without --force; overwritten with --force.
 *   5. Dry-run writes nothing.
 *   6. Order-insensitive equality (canonical key sort).
 *   7. The entry `name` and `filePath` are honoured verbatim.
 *   8. removeExternalMcpServer strips only the named entry.
 *   9. readExternalMcpServerPresence is a faithful read-only probe.
 */

const ENTRY: ExternalMcpEntry = {
  command: 'python3',
  args: ['-m', 'graphify.serve', 'graphify-out/graph.json'],
};

describe('mergeExternalMcpServer', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'coodra-ext-mcp-merge-'));
  });

  it('greenfield: creates the config file (and mkdir -p its parent dir)', async () => {
    // Nested path the parent of which does not exist — exercises the mkdir.
    const filePath = join(dir, '.cursor', 'mcp.json');
    const result = await mergeExternalMcpServer({
      filePath,
      name: 'graphify',
      entry: ENTRY,
      force: false,
      dryRun: false,
    });
    expect(result.action).toBe('wrote');
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    expect(parsed.mcpServers.graphify.command).toBe('python3');
  });

  it('is idempotent — a second identical merge is unchanged', async () => {
    const filePath = join(dir, '.mcp.json');
    await mergeExternalMcpServer({ filePath, name: 'graphify', entry: ENTRY, force: false, dryRun: false });
    const second = await mergeExternalMcpServer({
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
    const filePath = join(dir, '.mcp.json');
    await writeFile(
      filePath,
      JSON.stringify({ mcpServers: { coodra: { command: 'node' }, memory: { command: 'npx' } } }, null, 2),
      'utf8',
    );
    const result = await mergeExternalMcpServer({
      filePath,
      name: 'graphify',
      entry: ENTRY,
      force: false,
      dryRun: false,
    });
    expect(result.action).toBe('merged');
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    expect(parsed.mcpServers.coodra.command).toBe('node');
    expect(parsed.mcpServers.memory.command).toBe('npx');
    expect(parsed.mcpServers.graphify.command).toBe('python3');
  });

  it('preserves any other top-level keys in the config file', async () => {
    const filePath = join(dir, '.mcp.json');
    await writeFile(filePath, JSON.stringify({ schemaVersion: 2, mcpServers: {} }, null, 2), 'utf8');
    await mergeExternalMcpServer({ filePath, name: 'graphify', entry: ENTRY, force: false, dryRun: false });
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    expect(parsed.schemaVersion).toBe(2);
  });

  it('preserves a drifted entry without --force', async () => {
    const filePath = join(dir, '.mcp.json');
    await writeFile(filePath, JSON.stringify({ mcpServers: { graphify: { command: 'custom' } } }, null, 2), 'utf8');
    const result = await mergeExternalMcpServer({
      filePath,
      name: 'graphify',
      entry: ENTRY,
      force: false,
      dryRun: false,
    });
    expect(result.action).toBe('unchanged');
    expect(result.notes).toContain('--force');
    expect(JSON.parse(await readFile(filePath, 'utf8')).mcpServers.graphify.command).toBe('custom');
  });

  it('--force overwrites a drifted entry', async () => {
    const filePath = join(dir, '.mcp.json');
    await writeFile(filePath, JSON.stringify({ mcpServers: { graphify: { command: 'custom' } } }, null, 2), 'utf8');
    const result = await mergeExternalMcpServer({
      filePath,
      name: 'graphify',
      entry: ENTRY,
      force: true,
      dryRun: false,
    });
    expect(result.action).toBe('forced');
    expect(JSON.parse(await readFile(filePath, 'utf8')).mcpServers.graphify.command).toBe('python3');
  });

  it('dry-run writes nothing to disk (greenfield)', async () => {
    const filePath = join(dir, '.mcp.json');
    const result = await mergeExternalMcpServer({
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
    const filePath = join(dir, '.mcp.json');
    await writeFile(filePath, JSON.stringify({ mcpServers: { coodra: { command: 'node' } } }, null, 2), 'utf8');
    const result = await mergeExternalMcpServer({
      filePath,
      name: 'graphify',
      entry: ENTRY,
      force: false,
      dryRun: true,
    });
    expect(result.action).toBe('merged');
    expect(JSON.parse(await readFile(filePath, 'utf8')).mcpServers.graphify).toBeUndefined();
  });

  it('entry equality is order-insensitive (canonical key sort)', async () => {
    const filePath = join(dir, '.mcp.json');
    const envEntry: ExternalMcpEntry = { command: 'python3', env: { B: '2', A: '1' } };
    // Persisted with env keys in a different order than the comparison entry.
    await writeFile(
      filePath,
      JSON.stringify({ mcpServers: { graphify: { env: { A: '1', B: '2' }, command: 'python3' } } }, null, 2),
      'utf8',
    );
    const result = await mergeExternalMcpServer({
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
    const filePath = join(dir, '.mcp.json');
    await mergeExternalMcpServer({ filePath, name: 'atlassian', entry: ENTRY, force: false, dryRun: false });
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    expect(parsed.mcpServers.atlassian.command).toBe('python3');
  });

  it('throws a structured error when the existing file is not valid JSON', async () => {
    const filePath = join(dir, '.mcp.json');
    await writeFile(filePath, '{ not json', 'utf8');
    await expect(
      mergeExternalMcpServer({ filePath, name: 'graphify', entry: ENTRY, force: false, dryRun: false }),
    ).rejects.toThrow(/Cannot parse/);
  });

  it('throws when the existing file is a JSON array, not an object', async () => {
    const filePath = join(dir, '.mcp.json');
    await writeFile(filePath, '[]', 'utf8');
    await expect(
      mergeExternalMcpServer({ filePath, name: 'graphify', entry: ENTRY, force: false, dryRun: false }),
    ).rejects.toThrow(/must be a JSON object/);
  });
});

describe('removeExternalMcpServer', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'coodra-ext-mcp-remove-'));
  });

  it('strips only the named entry; siblings survive', async () => {
    const filePath = join(dir, '.mcp.json');
    await writeFile(
      filePath,
      JSON.stringify({ mcpServers: { coodra: { command: 'node' }, graphify: { command: 'python3' } } }, null, 2),
      'utf8',
    );
    const result = await removeExternalMcpServer({ filePath, name: 'graphify', dryRun: false });
    expect(result.action).toBe('merged');
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    expect(parsed.mcpServers.graphify).toBeUndefined();
    expect(parsed.mcpServers.coodra.command).toBe('node');
  });

  it('is a no-op when the file is absent', async () => {
    const result = await removeExternalMcpServer({ filePath: join(dir, '.mcp.json'), name: 'graphify', dryRun: false });
    expect(result.action).toBe('unchanged');
  });

  it('is a no-op when the named entry is absent', async () => {
    const filePath = join(dir, '.mcp.json');
    await writeFile(filePath, JSON.stringify({ mcpServers: { coodra: { command: 'node' } } }, null, 2), 'utf8');
    const result = await removeExternalMcpServer({ filePath, name: 'graphify', dryRun: false });
    expect(result.action).toBe('unchanged');
  });

  it('dry-run writes nothing to disk', async () => {
    const filePath = join(dir, '.mcp.json');
    await writeFile(filePath, JSON.stringify({ mcpServers: { graphify: { command: 'python3' } } }, null, 2), 'utf8');
    const result = await removeExternalMcpServer({ filePath, name: 'graphify', dryRun: true });
    expect(result.action).toBe('merged');
    expect(JSON.parse(await readFile(filePath, 'utf8')).mcpServers.graphify.command).toBe('python3');
  });
});

describe('readExternalMcpServerPresence', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'coodra-ext-mcp-presence-'));
  });

  it('reports an absent file', async () => {
    const presence = await readExternalMcpServerPresence({ filePath: join(dir, '.mcp.json'), name: 'graphify' });
    expect(presence).toEqual({ exists: false, wired: false, unreadable: false });
  });

  it('reports a present, wired file', async () => {
    const filePath = join(dir, '.mcp.json');
    await writeFile(filePath, JSON.stringify({ mcpServers: { graphify: { command: 'python3' } } }, null, 2), 'utf8');
    const presence = await readExternalMcpServerPresence({ filePath, name: 'graphify' });
    expect(presence).toEqual({ exists: true, wired: true, unreadable: false });
  });

  it('reports a present file with no named entry', async () => {
    const filePath = join(dir, '.mcp.json');
    await writeFile(filePath, JSON.stringify({ mcpServers: { coodra: { command: 'node' } } }, null, 2), 'utf8');
    const presence = await readExternalMcpServerPresence({ filePath, name: 'graphify' });
    expect(presence).toEqual({ exists: true, wired: false, unreadable: false });
  });

  it('reports an unreadable (invalid JSON) file', async () => {
    const filePath = join(dir, '.mcp.json');
    await writeFile(filePath, '{ not json', 'utf8');
    const presence = await readExternalMcpServerPresence({ filePath, name: 'graphify' });
    expect(presence).toEqual({ exists: true, wired: false, unreadable: true });
  });
});
