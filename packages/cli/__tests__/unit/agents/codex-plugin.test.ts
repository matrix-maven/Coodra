import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  codexPluginPaths,
  installCodexPlugin,
  probeCodexPlugin,
  removeCodexPlugin,
} from '../../../src/lib/agents/codex-plugin.js';
import type { AgentContext } from '../../../src/lib/agents/types.js';

describe('Codex native plugin installer', () => {
  let userHome: string;
  let cwd: string;
  let coodraHome: string;

  beforeEach(async () => {
    userHome = await mkdtemp(join(tmpdir(), 'coodra-codex-plugin-home-'));
    cwd = await mkdtemp(join(tmpdir(), 'coodra-codex-plugin-cwd-'));
    coodraHome = await mkdtemp(join(tmpdir(), 'coodra-codex-plugin-data-'));
  });

  function ctx(overrides: Partial<AgentContext> = {}): AgentContext {
    return {
      cwd,
      userHome,
      projectSlug: 'demo',
      bridgePort: 3101,
      localHookSecret: 'local-secret',
      mcpEntryOptions: {
        mcpServerBin: '/tmp/coodra-mcp-server.js',
        clerkSecretKey: 'sk_test',
        migrationsDir: null,
        coodraHome,
        localHookSecret: 'local-secret',
      },
      force: false,
      dryRun: false,
      ...overrides,
    };
  }

  it('writes a native plugin bundle with Coodra and managed Graphify MCP servers', async () => {
    const paths = codexPluginPaths(userHome);
    const result = await installCodexPlugin(ctx());

    expect(result.outcomes.map((o) => o.path)).toContain(paths.mcpPath);

    const mcp = JSON.parse(await readFile(paths.mcpPath, 'utf8')) as {
      mcpServers?: {
        coodra?: { env?: Record<string, string> };
        graphify?: { command?: string; args?: string[] };
      };
    };
    expect(mcp.mcpServers?.coodra?.env?.COODRA_AGENT_TYPE).toBe('codex');
    expect(mcp.mcpServers?.graphify).toEqual({
      command: join(coodraHome, 'graphify-mcp', '.venv', 'bin', 'python'),
      args: ['-m', 'graphify.serve', '.coodra/graphify/out/graph.json'],
    });
    const wikiSkill = await readFile(join(paths.skillsRoot, 'coodra-wiki', 'SKILL.md'), 'utf8');
    expect(wikiSkill).toContain('wiki_save_structure');
    expect(wikiSkill).toContain('run `coodra wiki build` first');
    expect(wikiSkill).toContain('.coodra/wiki/job.md');
    expect(wikiSkill).toContain('Treat the Graphify section as the first structural map');
    expect(wikiSkill).toContain('do not start by recursively scanning the whole repo');
    expect(wikiSkill).toContain('.coodra/wiki/<slug>/structure.json');
    expect(wikiSkill).toContain('rather than a fixed template');
    // COOD-11 follow-up: `deep-wiki-author` was retired as a redundant second
    // wiki skill — `coodra-wiki` is now the only bundled wiki skill.
    expect(wikiSkill).toContain('there is no separate "deep wiki author" skill');
    await expect(readFile(join(paths.skillsRoot, 'deep-wiki-author', 'SKILL.md'), 'utf8')).rejects.toThrow();

    expect(await probeCodexPlugin({ cwd, userHome })).toMatchObject({
      manifest: true,
      marketplace: true,
      mcp: true,
      hooks: true,
      skills: true,
    });
  });

  it('removes marketplace entry, plugin bundle, and the cache mirror Codex itself creates', async () => {
    const paths = codexPluginPaths(userHome);
    await installCodexPlugin(ctx());

    // Codex's own runtime — not this file's install code — mirrors the
    // installed plugin into cache/<marketplace>/<plugin>/<version>/ once it
    // actually loads it (found live at ~/.codex/plugins/cache/personal/coodra/
    // on a real machine, 2026-08-02, surviving a full uninstall untouched).
    // Simulate that here so removeCodexPlugin's cleanup is exercised.
    await mkdir(join(paths.cachePluginRoot, '0.4.0', 'skills', 'deep-wiki-author'), { recursive: true });
    await writeFile(join(paths.cachePluginRoot, '0.4.0', '.mcp.json'), '{}', 'utf8');

    const result = await removeCodexPlugin({
      cwd,
      userHome,
      coodraHome,
      bridgePort: 3101,
      dryRun: false,
    });

    expect(result.outcomes.some((o) => o.path === paths.marketplacePath && o.action === 'merged')).toBe(true);
    expect(result.outcomes.some((o) => o.path === paths.pluginRoot && o.action === 'merged')).toBe(true);
    expect(result.outcomes.some((o) => o.path === paths.cachePluginRoot && o.action === 'merged')).toBe(true);
    expect(existsSync(paths.pluginRoot)).toBe(false);
    expect(existsSync(paths.cachePluginRoot)).toBe(false);
    expect(await probeCodexPlugin({ cwd, userHome })).toMatchObject({
      manifest: false,
      marketplace: false,
      mcp: false,
      hooks: false,
      skills: false,
    });
  });

  it('--dry-run leaves the cache mirror untouched', async () => {
    const paths = codexPluginPaths(userHome);
    await installCodexPlugin(ctx());
    await mkdir(paths.cachePluginRoot, { recursive: true });
    await writeFile(join(paths.cachePluginRoot, 'marker.json'), '{}', 'utf8');

    await removeCodexPlugin({ cwd, userHome, coodraHome, bridgePort: 3101, dryRun: true });

    expect(existsSync(paths.pluginRoot)).toBe(true);
    expect(existsSync(paths.cachePluginRoot)).toBe(true);
  });

  it('preserves unrelated personal marketplace plugins', async () => {
    const paths = codexPluginPaths(userHome);
    await installCodexPlugin(ctx());
    const marketplace = JSON.parse(await readFile(paths.marketplacePath, 'utf8'));
    marketplace.plugins.push({
      name: 'other',
      source: { source: 'local', path: './.codex/plugins/other' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    });
    await writeFile(paths.marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8');

    await removeCodexPlugin({
      cwd,
      userHome,
      coodraHome,
      bridgePort: 3101,
      dryRun: false,
    });

    const next = JSON.parse(await readFile(paths.marketplacePath, 'utf8')) as {
      plugins?: Array<{ name?: string }>;
    };
    expect(next.plugins?.some((plugin) => plugin.name === 'coodra')).toBe(false);
    expect(next.plugins?.some((plugin) => plugin.name === 'other')).toBe(true);
  });
});
