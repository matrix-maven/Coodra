import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ClaudeCliRunner,
  claudePluginPaths,
  installClaudePlugin,
  probeClaudePlugin,
  removeClaudePlugin,
} from '../../../src/lib/agents/claude-plugin.js';
import type { AgentContext } from '../../../src/lib/agents/types.js';

/**
 * Tests must never let `installClaudePlugin`/`removeClaudePlugin`/
 * `probeClaudePlugin` fall through to the REAL `defaultClaudeCliRunner` —
 * its `detect()` shells out to the actual `which claude` on the test
 * machine, unscoped by any tmpdir fixture here. On a machine that happens
 * to have `claude` on PATH, that would spawn the real CLI against the
 * developer's/CI runner's actual `~/.claude/settings.json`, not the test's
 * fake `userHome`. Every call below is pinned to an explicit fake runner.
 */
function noCliRunner(): ClaudeCliRunner {
  return {
    detect: async () => null,
    installMarketplaceAndPlugin: async () => {
      throw new Error('unexpected: claude CLI should not be invoked in this test');
    },
    uninstallPlugin: async () => {
      throw new Error('unexpected: claude CLI should not be invoked in this test');
    },
    isInstalled: async () => {
      throw new Error('unexpected: claude CLI should not be invoked in this test');
    },
  };
}

describe('Claude Code native plugin installer', () => {
  let userHome: string;
  let cwd: string;
  let coodraHome: string;

  beforeEach(async () => {
    userHome = await mkdtemp(join(tmpdir(), 'coodra-claude-plugin-home-'));
    cwd = await mkdtemp(join(tmpdir(), 'coodra-claude-plugin-cwd-'));
    coodraHome = await mkdtemp(join(tmpdir(), 'coodra-claude-plugin-data-'));
    await mkdir(join(userHome, '.claude'), { recursive: true });
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

  it('writes a local marketplace plugin with manifest, MCP, hooks, skills, and README', async () => {
    const result = await installClaudePlugin(ctx(), noCliRunner());
    const paths = claudePluginPaths(userHome, coodraHome);

    expect(result.outcomes.map((o) => o.path)).toContain(paths.marketplacePath);
    expect(result.outcomes.map((o) => o.path)).toContain(paths.knownMarketplacesPath);
    expect(result.outcomes.map((o) => o.path)).toContain(paths.manifestPath);
    expect(result.outcomes.map((o) => o.path)).toContain(paths.cacheManifestPath);
    expect(result.outcomes.map((o) => o.path)).toContain(paths.settingsPath);
    expect(result.outcomes.map((o) => o.path)).toContain(paths.mcpPath);
    expect(result.outcomes.map((o) => o.path)).toContain(paths.cacheMcpPath);
    expect(result.outcomes.map((o) => o.path)).toContain(paths.hooksPath);
    expect(result.outcomes.map((o) => o.path)).toContain(paths.cacheHooksPath);
    expect(result.outcomes.map((o) => o.path)).toContain(join(paths.skillsRoot, 'coodra-context', 'SKILL.md'));
    expect(result.outcomes.map((o) => o.path)).toContain(paths.readmePath);

    const manifest = JSON.parse(await readFile(paths.manifestPath, 'utf8')) as { name?: string };
    expect(manifest.name).toBe('coodra');

    const settings = JSON.parse(await readFile(paths.settingsPath, 'utf8')) as {
      enabledPlugins?: Record<string, boolean>;
      extraKnownMarketplaces?: Record<string, { source?: { source?: string; path?: string } }>;
    };
    expect(settings.enabledPlugins?.['coodra@coodra']).toBe(true);
    expect(settings.enabledPlugins?.['coodra@skills-dir']).toBeUndefined();
    expect(settings.extraKnownMarketplaces?.coodra?.source).toEqual({
      source: 'directory',
      path: paths.marketplaceRoot,
    });

    const marketplace = JSON.parse(await readFile(paths.marketplacePath, 'utf8')) as {
      name?: string;
      plugins?: Array<{ name?: string; source?: string }>;
    };
    expect(marketplace.name).toBe('coodra');
    expect(marketplace.plugins?.[0]).toMatchObject({ name: 'coodra', source: './plugins/coodra' });

    const known = JSON.parse(await readFile(paths.knownMarketplacesPath, 'utf8')) as {
      coodra?: { source?: { source?: string; path?: string }; installLocation?: string };
    };
    expect(known.coodra).toMatchObject({
      source: { source: 'directory', path: paths.marketplaceRoot },
      installLocation: paths.marketplaceRoot,
    });

    const mcp = JSON.parse(await readFile(paths.mcpPath, 'utf8')) as {
      mcpServers?: {
        coodra?: { env?: Record<string, string> };
        graphify?: { command?: string; args?: string[] };
      };
    };
    expect(mcp.mcpServers?.coodra?.env?.COODRA_AGENT_TYPE).toBe('claude_code');
    expect(mcp.mcpServers?.coodra?.env?.COODRA_HOME).toBe(coodraHome);
    expect(mcp.mcpServers?.graphify).toEqual({
      command: join(coodraHome, 'graphify-mcp', '.venv', 'bin', 'python'),
      args: ['-m', 'graphify.serve', '.coodra/graphify/out/graph.json'],
    });
    const cachedMcp = JSON.parse(await readFile(paths.cacheMcpPath, 'utf8')) as {
      mcpServers?: {
        coodra?: { env?: Record<string, string> };
        graphify?: { command?: string; args?: string[] };
      };
    };
    expect(cachedMcp.mcpServers?.coodra?.env?.COODRA_AGENT_TYPE).toBe('claude_code');
    expect(cachedMcp.mcpServers?.graphify).toEqual({
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
    const deepWikiSkill = await readFile(join(paths.skillsRoot, 'deep-wiki-author', 'SKILL.md'), 'utf8');
    expect(deepWikiSkill).toContain('name: deep-wiki-author');
    expect(deepWikiSkill).toContain('coodra__wiki_save_structure');
    expect(deepWikiSkill).toContain('coodra__wiki_save_page');
    expect(deepWikiSkill).toContain('Graph-first planning');
    expect(deepWikiSkill).toContain('Markdown mirror');
    const cachedDeepWikiSkill = await readFile(join(paths.cacheSkillsRoot, 'deep-wiki-author', 'SKILL.md'), 'utf8');
    expect(cachedDeepWikiSkill).toContain('coodra__wiki_status');

    const hooks = await readFile(paths.hooksPath, 'utf8');
    expect(hooks).toContain('"type": "mcp_tool"');
    expect(hooks).toContain('"server": "plugin:coodra:coodra"');
    expect(hooks).toContain('"tool": "lifecycle_event"');
    expect(hooks).toContain('"agentType": "claude_code"');
    expect(hooks).toContain('"UserPromptSubmit"');

    expect(await probeClaudePlugin({ cwd, userHome }, noCliRunner())).toMatchObject({
      enabled: true,
      manifest: true,
      mcp: true,
      hooks: true,
      skills: true,
    });
  });

  it('preserves local edits unless force is set', async () => {
    const paths = claudePluginPaths(userHome, coodraHome);
    await mkdir(join(paths.pluginRoot, '.claude-plugin'), { recursive: true });
    await writeFile(paths.manifestPath, '{"name":"custom"}\n', 'utf8');

    const result = await installClaudePlugin(ctx(), noCliRunner());
    const manifestOutcome = result.outcomes.find((o) => o.path === paths.manifestPath);
    expect(manifestOutcome?.action).toBe('unchanged');
    expect(await readFile(paths.manifestPath, 'utf8')).toContain('"custom"');

    await installClaudePlugin(ctx({ force: true }), noCliRunner());
    expect(await readFile(paths.manifestPath, 'utf8')).toContain('"coodra"');
  });

  it('preserves existing Claude settings while enabling the user-scope plugin', async () => {
    const paths = claudePluginPaths(userHome, coodraHome);
    await writeFile(
      paths.settingsPath,
      JSON.stringify({ hooks: {}, enabledPlugins: { 'other@market': true } }, null, 2),
      'utf8',
    );

    const result = await installClaudePlugin(ctx(), noCliRunner());
    const settingsOutcome = result.outcomes.find((o) => o.path === paths.settingsPath);
    expect(settingsOutcome?.action).toBe('wrote');

    const settings = JSON.parse(await readFile(paths.settingsPath, 'utf8')) as {
      hooks?: unknown;
      enabledPlugins?: Record<string, boolean>;
      extraKnownMarketplaces?: Record<string, { source?: { source?: string; path?: string } }>;
    };
    expect(settings.hooks).toEqual({});
    expect(settings.enabledPlugins?.['other@market']).toBe(true);
    expect(settings.enabledPlugins?.['coodra@coodra']).toBe(true);
    expect(settings.extraKnownMarketplaces?.coodra?.source?.source).toBe('directory');
  });

  it('does not override an explicit disabled plugin entry unless force is set', async () => {
    const paths = claudePluginPaths(userHome, coodraHome);
    await writeFile(paths.settingsPath, JSON.stringify({ enabledPlugins: { 'coodra@coodra': false } }), 'utf8');

    const result = await installClaudePlugin(ctx(), noCliRunner());
    const settingsOutcome = result.outcomes.find((o) => o.path === paths.settingsPath);
    expect(settingsOutcome?.action).toBe('unchanged');
    expect(JSON.parse(await readFile(paths.settingsPath, 'utf8')).enabledPlugins['coodra@coodra']).toBe(false);

    await installClaudePlugin(ctx({ force: true }), noCliRunner());
    expect(JSON.parse(await readFile(paths.settingsPath, 'utf8')).enabledPlugins['coodra@coodra']).toBe(true);
  });

  it('removes user-scope enablement, marketplace registration, source, and cache', async () => {
    const paths = claudePluginPaths(userHome, coodraHome);
    await installClaudePlugin(ctx(), noCliRunner());
    await writeFile(
      paths.settingsPath,
      JSON.stringify(
        {
          hooks: {},
          enabledPlugins: { 'other@market': true, 'coodra@coodra': true, 'coodra@skills-dir': true },
          extraKnownMarketplaces: { other: { source: { source: 'directory', path: '/tmp/other' } }, coodra: {} },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(
      paths.legacyInstalledPluginsPath,
      JSON.stringify(
        {
          version: 2,
          plugins: {
            'coodra@coodra': [
              {
                scope: 'user',
                installPath: paths.cachePluginRoot,
                version: '0.2.0-beta.28',
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const result = await removeClaudePlugin(
      {
        cwd,
        userHome,
        coodraHome,
        bridgePort: 3101,
        dryRun: false,
      },
      noCliRunner(),
    );
    expect(result.outcomes.some((o) => o.path === paths.marketplaceRoot && o.action === 'merged')).toBe(true);
    expect(result.outcomes.some((o) => o.path === dirname(paths.cachePluginRoot) && o.action === 'merged')).toBe(true);

    const settings = JSON.parse(await readFile(paths.settingsPath, 'utf8')) as {
      enabledPlugins?: Record<string, boolean>;
      extraKnownMarketplaces?: Record<string, unknown>;
    };
    expect(settings.enabledPlugins?.['other@market']).toBe(true);
    expect(settings.enabledPlugins?.['coodra@coodra']).toBeUndefined();
    expect(settings.enabledPlugins?.['coodra@skills-dir']).toBeUndefined();
    expect(settings.extraKnownMarketplaces?.other).toBeDefined();
    expect(settings.extraKnownMarketplaces?.coodra).toBeUndefined();

    const known = JSON.parse(await readFile(paths.knownMarketplacesPath, 'utf8')) as Record<string, unknown>;
    expect(known.coodra).toBeUndefined();
    expect(existsSync(paths.legacyInstalledPluginsPath)).toBe(false);
    expect(existsSync(paths.marketplaceRoot)).toBe(false);
    expect(existsSync(paths.cachePluginRoot)).toBe(false);
  });

  it('preserves unrelated legacy installed plugin records when removing stale Coodra state', async () => {
    const paths = claudePluginPaths(userHome, coodraHome);
    await mkdir(join(userHome, '.claude', 'plugins'), { recursive: true });
    await writeFile(
      paths.legacyInstalledPluginsPath,
      JSON.stringify(
        {
          version: 2,
          plugins: {
            'coodra@coodra': [{ scope: 'user' }],
            'other@market': [{ scope: 'user' }],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    await removeClaudePlugin(
      {
        cwd,
        userHome,
        coodraHome,
        bridgePort: 3101,
        dryRun: false,
      },
      noCliRunner(),
    );

    const legacy = JSON.parse(await readFile(paths.legacyInstalledPluginsPath, 'utf8')) as {
      plugins?: Record<string, unknown>;
    };
    expect(legacy.plugins?.['coodra@coodra']).toBeUndefined();
    expect(legacy.plugins?.['other@market']).toBeDefined();
  });

  describe('claude CLI preferred path', () => {
    it('installs via the CLI and skips the hand-written settings/cache write when it succeeds', async () => {
      const paths = claudePluginPaths(userHome, coodraHome);
      const installMarketplaceAndPlugin = vi.fn(async () => ({ ok: true as const }));
      const runner: ClaudeCliRunner = {
        detect: async () => '/usr/local/bin/claude',
        installMarketplaceAndPlugin,
        uninstallPlugin: async () => {
          throw new Error('not expected in this test');
        },
        isInstalled: async () => {
          throw new Error('not expected in this test');
        },
      };

      const result = await installClaudePlugin(ctx(), runner);

      expect(installMarketplaceAndPlugin).toHaveBeenCalledWith('/usr/local/bin/claude', paths.marketplaceRoot);
      const settingsOutcome = result.outcomes.find((o) => o.path === paths.settingsPath);
      expect(settingsOutcome?.notes).toContain('claude plugin install --scope user');
      // The hand-written cache mirror and known_marketplaces.json are only
      // written on the fallback path — the CLI owns them when it succeeds.
      expect(existsSync(paths.cacheManifestPath)).toBe(false);
      expect(existsSync(paths.knownMarketplacesPath)).toBe(false);
      // The marketplace SOURCE is still written — `claude plugin marketplace
      // add` registers an existing local marketplace, it doesn't create one.
      expect(existsSync(paths.marketplacePath)).toBe(true);
    });

    it('falls back to the hand-written settings/cache path when the CLI call fails', async () => {
      const paths = claudePluginPaths(userHome, coodraHome);
      const runner: ClaudeCliRunner = {
        detect: async () => '/usr/local/bin/claude',
        installMarketplaceAndPlugin: async () => ({ ok: false, reason: 'exit code 1' }),
        uninstallPlugin: async () => {
          throw new Error('not expected in this test');
        },
        isInstalled: async () => {
          throw new Error('not expected in this test');
        },
      };

      const result = await installClaudePlugin(ctx(), runner);

      const settingsOutcome = result.outcomes.find((o) => o.path === paths.settingsPath);
      expect(settingsOutcome?.notes).toContain('falling back to direct settings/cache write');
      expect(existsSync(paths.cacheManifestPath)).toBe(true);
      const settings = JSON.parse(await readFile(paths.settingsPath, 'utf8')) as {
        enabledPlugins?: Record<string, boolean>;
      };
      expect(settings.enabledPlugins?.['coodra@coodra']).toBe(true);
    });

    it('does not invoke the CLI on a dry run', async () => {
      const detect = vi.fn(async () => '/usr/local/bin/claude');
      const runner: ClaudeCliRunner = {
        detect,
        installMarketplaceAndPlugin: async () => {
          throw new Error('must not be called on a dry run');
        },
        uninstallPlugin: async () => {
          throw new Error('must not be called on a dry run');
        },
        isInstalled: async () => {
          throw new Error('not expected in this test');
        },
      };

      await installClaudePlugin(ctx({ dryRun: true }), runner);
      expect(detect).not.toHaveBeenCalled();
    });

    it('probe treats a CLI-visible plugin as fully wired even without the hand-written cache mirror', async () => {
      const runner: ClaudeCliRunner = {
        detect: async () => '/usr/local/bin/claude',
        installMarketplaceAndPlugin: async () => {
          throw new Error('not expected in this test');
        },
        uninstallPlugin: async () => {
          throw new Error('not expected in this test');
        },
        isInstalled: async () => true,
      };

      const probe = await probeClaudePlugin({ cwd, userHome }, runner);
      expect(probe).toMatchObject({ enabled: true, manifest: true, mcp: true, hooks: true, skills: true });
    });

    it('remove attempts claude plugin uninstall via CLI, then still runs the manual cleanup', async () => {
      const paths = claudePluginPaths(userHome, coodraHome);
      await installClaudePlugin(ctx(), noCliRunner());
      const uninstallPlugin = vi.fn(async () => ({ ok: true as const }));
      const runner: ClaudeCliRunner = {
        detect: async () => '/usr/local/bin/claude',
        installMarketplaceAndPlugin: async () => {
          throw new Error('not expected in this test');
        },
        uninstallPlugin,
        isInstalled: async () => {
          throw new Error('not expected in this test');
        },
      };

      const result = await removeClaudePlugin({ cwd, userHome, coodraHome, bridgePort: 3101, dryRun: false }, runner);

      expect(uninstallPlugin).toHaveBeenCalledWith('/usr/local/bin/claude');
      // Manual cleanup still ran (idempotent) regardless of CLI success.
      expect(existsSync(paths.marketplaceRoot)).toBe(false);
      expect(result.outcomes.some((o) => o.notes?.includes('claude plugin uninstall --scope user'))).toBe(true);
    });
  });

  describe('stale cache version cleanup', () => {
    const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;
    const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

    /** Simulates a cache dir left behind by a prior Coodra version, with a controlled mtime. */
    async function seedOldVersionDir(cachePluginRoot: string, oldVersion: string, ageMs: number): Promise<string> {
      const oldDir = join(dirname(cachePluginRoot), oldVersion);
      await mkdir(join(oldDir, '.claude-plugin'), { recursive: true });
      await writeFile(join(oldDir, '.claude-plugin', 'plugin.json'), '{"name":"coodra"}\n', 'utf8');
      const oldMtime = new Date(Date.now() - ageMs);
      await utimes(oldDir, oldMtime, oldMtime);
      return oldDir;
    }

    it('prunes a sibling cache version older than the 14-day grace window on install', async () => {
      const paths = claudePluginPaths(userHome, coodraHome);
      const oldDir = await seedOldVersionDir(paths.cachePluginRoot, '0.1.0-beta.1', FIFTEEN_DAYS_MS);

      const result = await installClaudePlugin(ctx(), noCliRunner());

      expect(existsSync(oldDir)).toBe(false);
      expect(existsSync(paths.cacheManifestPath)).toBe(true);
      expect(result.outcomes.some((o) => o.path === oldDir && o.notes?.includes('pruned stale'))).toBe(true);
    });

    it('keeps a sibling cache version within the 14-day grace window on install', async () => {
      const paths = claudePluginPaths(userHome, coodraHome);
      const oldDir = await seedOldVersionDir(paths.cachePluginRoot, '0.1.0-beta.1', TWO_DAYS_MS);

      await installClaudePlugin(ctx(), noCliRunner());

      expect(existsSync(oldDir)).toBe(true);
    });

    it('does not prune anything on a dry run', async () => {
      const paths = claudePluginPaths(userHome, coodraHome);
      const oldDir = await seedOldVersionDir(paths.cachePluginRoot, '0.1.0-beta.1', FIFTEEN_DAYS_MS);

      await installClaudePlugin(ctx({ dryRun: true }), noCliRunner());

      expect(existsSync(oldDir)).toBe(true);
    });

    it('sweeps every cached version, including ones within the grace window, on full removal', async () => {
      const paths = claudePluginPaths(userHome, coodraHome);
      await installClaudePlugin(ctx(), noCliRunner());
      const recentOldDir = await seedOldVersionDir(paths.cachePluginRoot, '0.1.0-beta.1', TWO_DAYS_MS);

      await removeClaudePlugin({ cwd, userHome, coodraHome, bridgePort: 3101, dryRun: false }, noCliRunner());

      expect(existsSync(recentOldDir)).toBe(false);
      expect(existsSync(paths.cachePluginRoot)).toBe(false);
    });
  });
});
