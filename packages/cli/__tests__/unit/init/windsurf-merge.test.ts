import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoodraMcpEntry } from '../../../src/lib/init/mcp-merge.js';
import {
  defaultWindsurfMcpConfigPath,
  mergeWindsurfMcpConfig,
  removeWindsurfMcpConfig,
} from '../../../src/lib/init/windsurf-merge.js';

/**
 * Locks the beta.95 Windsurf MCP-config writer contract. Windsurf's
 * mcp_config.json is GLOBAL (~/.codeium/windsurf/) — the merge-don't-
 * clobber discipline is load-bearing because the file is shared.
 *   1. Greenfield — absent file → created (with the .codeium/windsurf mkdir).
 *   2. Idempotent.
 *   3. Merge-don't-clobber — other mcpServers entries survive.
 *   4. Drift preserved without --force; overwritten with --force.
 *   5. Dry-run writes nothing.
 *   6. removeWindsurfMcpConfig strips only the coodra entry.
 */

const ENTRY: CoodraMcpEntry = {
  command: 'node',
  args: ['/abs/path/runtime/mcp-server/index.js', '--transport', 'stdio'],
  env: { COODRA_LOG_DESTINATION: 'stderr' },
};

describe('mergeWindsurfMcpConfig — ~/.codeium/windsurf/mcp_config.json writer', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'coodra-windsurf-merge-'));
  });
  afterEach(() => {
    /* tmp cleaned by OS */
  });

  it('greenfield: creates mcp_config.json (mkdir -p the .codeium/windsurf dir)', async () => {
    const result = await mergeWindsurfMcpConfig({ entry: ENTRY, force: false, dryRun: false, userHome: home });
    expect(result.action).toBe('wrote');
    const parsed = JSON.parse(await readFile(defaultWindsurfMcpConfigPath(home), 'utf8'));
    expect(parsed.mcpServers.coodra.command).toBe('node');
  });

  it('is idempotent — a second identical merge is unchanged', async () => {
    await mergeWindsurfMcpConfig({ entry: ENTRY, force: false, dryRun: false, userHome: home });
    const second = await mergeWindsurfMcpConfig({ entry: ENTRY, force: false, dryRun: false, userHome: home });
    expect(second.action).toBe('unchanged');
  });

  it("merge-don't-clobber: preserves the user's other MCP servers", async () => {
    const path = defaultWindsurfMcpConfigPath(home);
    await mkdir(join(home, '.codeium', 'windsurf'), { recursive: true });
    await writeFile(path, JSON.stringify({ mcpServers: { memory: { command: 'npx' } } }, null, 2), 'utf8');
    const result = await mergeWindsurfMcpConfig({ entry: ENTRY, force: false, dryRun: false, userHome: home });
    expect(result.action).toBe('merged');
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    expect(parsed.mcpServers.memory.command).toBe('npx');
    expect(parsed.mcpServers.coodra.command).toBe('node');
  });

  it('preserves a drifted coodra entry without --force', async () => {
    const path = defaultWindsurfMcpConfigPath(home);
    await mkdir(join(home, '.codeium', 'windsurf'), { recursive: true });
    await writeFile(path, JSON.stringify({ mcpServers: { coodra: { command: 'custom' } } }, null, 2), 'utf8');
    const result = await mergeWindsurfMcpConfig({ entry: ENTRY, force: false, dryRun: false, userHome: home });
    expect(result.action).toBe('unchanged');
    expect(JSON.parse(await readFile(path, 'utf8')).mcpServers.coodra.command).toBe('custom');
  });

  it('--force overwrites a drifted coodra entry', async () => {
    const path = defaultWindsurfMcpConfigPath(home);
    await mkdir(join(home, '.codeium', 'windsurf'), { recursive: true });
    await writeFile(path, JSON.stringify({ mcpServers: { coodra: { command: 'custom' } } }, null, 2), 'utf8');
    const result = await mergeWindsurfMcpConfig({ entry: ENTRY, force: true, dryRun: false, userHome: home });
    expect(result.action).toBe('forced');
    expect(JSON.parse(await readFile(path, 'utf8')).mcpServers.coodra.command).toBe('node');
  });

  it('dry-run writes nothing to disk', async () => {
    const result = await mergeWindsurfMcpConfig({ entry: ENTRY, force: false, dryRun: true, userHome: home });
    expect(result.action).toBe('wrote');
    await expect(readFile(defaultWindsurfMcpConfigPath(home), 'utf8')).rejects.toThrow();
  });

  it('removeWindsurfMcpConfig strips only the coodra entry', async () => {
    const path = defaultWindsurfMcpConfigPath(home);
    await mkdir(join(home, '.codeium', 'windsurf'), { recursive: true });
    await writeFile(path, JSON.stringify({ mcpServers: { memory: { command: 'npx' } } }, null, 2), 'utf8');
    await mergeWindsurfMcpConfig({ entry: ENTRY, force: false, dryRun: false, userHome: home });
    const result = await removeWindsurfMcpConfig({ dryRun: false, userHome: home });
    expect(result.action).toBe('merged');
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    expect(parsed.mcpServers.coodra).toBeUndefined();
    expect(parsed.mcpServers.memory.command).toBe('npx');
  });

  it('removeWindsurfMcpConfig is a no-op when the file is absent', async () => {
    const result = await removeWindsurfMcpConfig({ dryRun: false, userHome: home });
    expect(result.action).toBe('unchanged');
  });
});
