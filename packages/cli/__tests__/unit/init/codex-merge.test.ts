import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCodexEntryEqual, mergeCodexConfig, removeCodexConfig } from '../../../src/lib/init/codex-merge.js';
import type { CoodraMcpEntry } from '../../../src/lib/init/mcp-merge.js';

/**
 * Locks the beta.95 Codex MCP-config writer contract:
 *   1. Greenfield — absent .codex/config.toml → created with the
 *      [mcp_servers.coodra] table.
 *   2. Idempotent — second merge with the same entry is 'unchanged'.
 *   3. Merge-don't-clobber — pre-existing tables (other Codex config,
 *      other MCP servers) survive untouched.
 *   4. Drift preserved without --force; overwritten with --force.
 *   5. Dry-run writes nothing.
 *   6. removeCodexConfig strips only the coodra entry.
 */

const ENTRY: CoodraMcpEntry = {
  command: 'node',
  args: ['/abs/path/runtime/mcp-server/index.js', '--transport', 'stdio'],
  env: { COODRA_LOG_DESTINATION: 'stderr', CLERK_SECRET_KEY: 'sk_test_x' },
};

describe('mergeCodexConfig — Codex .codex/config.toml writer', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-codex-merge-'));
  });
  afterEach(() => {
    /* tmp cleaned by OS */
  });

  it('greenfield: creates .codex/config.toml with the coodra MCP entry', async () => {
    const result = await mergeCodexConfig({ cwd, entry: ENTRY, force: false, dryRun: false });
    expect(result.action).toBe('wrote');
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as Record<string, unknown>;
    const servers = parsed.mcp_servers as Record<string, unknown>;
    expect(isCodexEntryEqual(ENTRY, servers.coodra)).toBe(true);
  });

  it('is idempotent — a second identical merge is unchanged', async () => {
    await mergeCodexConfig({ cwd, entry: ENTRY, force: false, dryRun: false });
    const second = await mergeCodexConfig({ cwd, entry: ENTRY, force: false, dryRun: false });
    expect(second.action).toBe('unchanged');
  });

  it('merge-don\'t-clobber: preserves other tables + other MCP servers', async () => {
    await mkdir(join(cwd, '.codex'), { recursive: true });
    await writeFile(
      join(cwd, '.codex', 'config.toml'),
      'model = "gpt-5"\n\n[mcp_servers.othersrv]\ncommand = "other"\n',
      'utf8',
    );
    const result = await mergeCodexConfig({ cwd, entry: ENTRY, force: false, dryRun: false });
    expect(result.action).toBe('merged');
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as Record<string, unknown>;
    expect(parsed.model).toBe('gpt-5');
    const servers = parsed.mcp_servers as Record<string, Record<string, unknown> | undefined>;
    expect(servers.othersrv?.command).toBe('other');
    expect(isCodexEntryEqual(ENTRY, servers.coodra)).toBe(true);
  });

  it('preserves a drifted coodra entry without --force', async () => {
    await mkdir(join(cwd, '.codex'), { recursive: true });
    await writeFile(
      join(cwd, '.codex', 'config.toml'),
      '[mcp_servers.coodra]\ncommand = "custom-node"\n',
      'utf8',
    );
    const result = await mergeCodexConfig({ cwd, entry: ENTRY, force: false, dryRun: false });
    expect(result.action).toBe('unchanged');
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as Record<string, unknown>;
    expect((parsed.mcp_servers as Record<string, Record<string, unknown> | undefined>).coodra?.command).toBe('custom-node');
  });

  it('--force overwrites a drifted coodra entry with the baseline', async () => {
    await mkdir(join(cwd, '.codex'), { recursive: true });
    await writeFile(join(cwd, '.codex', 'config.toml'), '[mcp_servers.coodra]\ncommand = "custom"\n', 'utf8');
    const result = await mergeCodexConfig({ cwd, entry: ENTRY, force: true, dryRun: false });
    expect(result.action).toBe('forced');
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as Record<string, unknown>;
    expect(isCodexEntryEqual(ENTRY, (parsed.mcp_servers as Record<string, unknown>).coodra)).toBe(true);
  });

  it('dry-run writes nothing to disk', async () => {
    const result = await mergeCodexConfig({ cwd, entry: ENTRY, force: false, dryRun: true });
    expect(result.action).toBe('wrote');
    await expect(readFile(join(cwd, '.codex', 'config.toml'), 'utf8')).rejects.toThrow();
  });

  it('removeCodexConfig strips only the coodra entry', async () => {
    await mkdir(join(cwd, '.codex'), { recursive: true });
    await writeFile(
      join(cwd, '.codex', 'config.toml'),
      'model = "gpt-5"\n\n[mcp_servers.othersrv]\ncommand = "other"\n',
      'utf8',
    );
    await mergeCodexConfig({ cwd, entry: ENTRY, force: false, dryRun: false });
    const result = await removeCodexConfig({ cwd, dryRun: false });
    expect(result.action).toBe('merged');
    const parsed = parseToml(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')) as Record<string, unknown>;
    expect(parsed.model).toBe('gpt-5');
    const servers = parsed.mcp_servers as Record<string, unknown>;
    expect(servers.coodra).toBeUndefined();
    expect((servers.othersrv as Record<string, unknown>).command).toBe('other');
  });

  it('removeCodexConfig is a no-op when the file is absent', async () => {
    const result = await removeCodexConfig({ cwd, dryRun: false });
    expect(result.action).toBe('unchanged');
  });
});
