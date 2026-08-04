import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_PLUGIN_KEY,
  type CodexCliRunner,
  codexPluginPaths,
  installCodexPlugin,
  probeCodexPlugin,
  removeCodexPlugin,
} from '../../../src/lib/agents/codex-plugin.js';
import type { AgentContext } from '../../../src/lib/agents/types.js';

/**
 * Tests must never let `installCodexPlugin`/`removeCodexPlugin`/
 * `probeCodexPlugin` fall through to the REAL `defaultCodexCliRunner` —
 * its `detect()` shells out to the actual `which codex` (and known bundle
 * paths) on the test machine, unscoped by any tmpdir fixture here. Every
 * call below is pinned to an explicit fake runner.
 */
function noCliRunner(): CodexCliRunner {
  return {
    detect: async () => null,
    installMarketplaceAndPlugin: async () => {
      throw new Error('unexpected: codex CLI should not be invoked in this test');
    },
    uninstallPlugin: async () => {
      throw new Error('unexpected: codex CLI should not be invoked in this test');
    },
    isInstalled: async () => {
      throw new Error('unexpected: codex CLI should not be invoked in this test');
    },
  };
}

function fakeCliRunner(overrides: Partial<CodexCliRunner> = {}): CodexCliRunner {
  return {
    detect: async () => ({ path: '/usr/local/bin/codex', viaPath: true }),
    installMarketplaceAndPlugin: async () => ({ ok: true }),
    uninstallPlugin: async () => ({ ok: true }),
    isInstalled: async () => true,
    ...overrides,
  };
}

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

  it('writes the marketplace source under ~/.coodra/codex-marketplaces/coodra/ — not the shared personal marketplace', async () => {
    const paths = codexPluginPaths(userHome, coodraHome);
    expect(paths.marketplaceRoot).toBe(join(coodraHome, 'codex-marketplaces', 'coodra'));
    expect(paths.marketplacePath).toBe(join(paths.marketplaceRoot, '.agents', 'plugins', 'marketplace.json'));

    await installCodexPlugin(ctx(), noCliRunner());

    const marketplace = JSON.parse(await readFile(paths.marketplacePath, 'utf8')) as {
      name: string;
      plugins: Array<{ name: string; source: { path: string } }>;
    };
    expect(marketplace.name).toBe('coodra');
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: 'coodra', source: { source: 'local', path: './plugins/coodra' } }),
    ]);
    // Never touches the user's own shared personal marketplace.
    expect(existsSync(join(userHome, '.agents', 'plugins', 'marketplace.json'))).toBe(false);
  });

  it('writes a native plugin bundle with Coodra and managed Graphify MCP servers', async () => {
    const paths = codexPluginPaths(userHome, coodraHome);
    const result = await installCodexPlugin(ctx(), fakeCliRunner());

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
    // COOD-11 follow-up: `deep-wiki-author` was retired as a redundant second
    // wiki skill — `coodra-wiki` is now the only bundled wiki skill.
    expect(wikiSkill).toContain('there is no separate "deep wiki author" skill');
    await expect(readFile(join(paths.skillsRoot, 'deep-wiki-author', 'SKILL.md'), 'utf8')).rejects.toThrow();

    // Codex hook coverage expansion — 5 new events + the TOOL_MATCHER fix.
    const hooksJson = JSON.parse(await readFile(paths.hooksPath, 'utf8')) as { hooks: Record<string, unknown> };
    for (const event of ['PermissionRequest', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop']) {
      expect(hooksJson.hooks).toHaveProperty(event);
    }
    // PreToolUse/PostToolUse/PermissionRequest all watch the same mcp__*
    // set, EXCLUDING Coodra's own two managed servers — calling Coodra's
    // own tools must never trigger a self-policing round-trip.
    for (const event of ['PreToolUse', 'PostToolUse', 'PermissionRequest']) {
      const matcherJson = JSON.stringify((hooksJson.hooks as Record<string, unknown>)[event]);
      expect(matcherJson).toContain('Bash|apply_patch|Edit|Write|mcp__(?!coodra__|graphify__).*');
    }
    // PreCompact/PostCompact/SubagentStart/SubagentStop fire on every
    // trigger/agent type — no matcher narrows them.
    for (const event of ['PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop']) {
      const entry = (hooksJson.hooks as Record<string, unknown>)[event] as Array<Record<string, unknown>>;
      expect(entry[0]).not.toHaveProperty('matcher');
    }
  });

  it('calls `codex plugin marketplace add` + `codex plugin add` with the resolved CLI path', async () => {
    const installMarketplaceAndPlugin = vi.fn(async () => ({ ok: true }) as const);
    const paths = codexPluginPaths(userHome, coodraHome);
    await installCodexPlugin(ctx(), fakeCliRunner({ installMarketplaceAndPlugin }));

    expect(installMarketplaceAndPlugin).toHaveBeenCalledWith('/usr/local/bin/codex', paths.marketplaceRoot);
  });

  it('reports a clear failure — no hand-write fallback — when codex CLI cannot be found anywhere', async () => {
    const result = await installCodexPlugin(ctx(), noCliRunner());
    const outcome = result.outcomes.find((o) => o.notes?.includes('codex CLI not found'));
    expect(outcome).toBeDefined();
    expect(outcome?.action).toBe('unchanged');
  });

  it('surfaces a symlink suggestion when the CLI was found via a bundle path, not PATH', async () => {
    const result = await installCodexPlugin(
      ctx(),
      fakeCliRunner({
        detect: async () => ({ path: '/Applications/ChatGPT.app/Contents/Resources/codex', viaPath: false }),
      }),
    );
    const outcome = result.outcomes.find((o) => o.notes?.includes('sudo ln -sf'));
    expect(outcome).toBeDefined();
    expect(outcome?.notes).toContain('/Applications/ChatGPT.app/Contents/Resources/codex');
  });

  it('does not surface a symlink suggestion when the CLI was already found on PATH', async () => {
    const result = await installCodexPlugin(ctx(), fakeCliRunner());
    expect(result.outcomes.some((o) => o.notes?.includes('sudo ln -sf'))).toBe(false);
  });

  it('reports the CLI failure reason when `codex plugin add` fails', async () => {
    const result = await installCodexPlugin(
      ctx(),
      fakeCliRunner({ installMarketplaceAndPlugin: async () => ({ ok: false, reason: 'boom' }) }),
    );
    const outcome = result.outcomes.find((o) => o.notes?.includes('boom'));
    expect(outcome).toBeDefined();
  });

  it('--dry-run never calls the CLI and writes nothing beyond the source bundle check', async () => {
    const installMarketplaceAndPlugin = vi.fn();
    await installCodexPlugin(ctx({ dryRun: true }), fakeCliRunner({ installMarketplaceAndPlugin }));
    expect(installMarketplaceAndPlugin).not.toHaveBeenCalled();
  });

  it('removeCodexPlugin calls the CLI and always removes Coodra-owned marketplace source', async () => {
    const paths = codexPluginPaths(userHome, coodraHome);
    await installCodexPlugin(ctx(), fakeCliRunner());
    expect(existsSync(paths.marketplaceRoot)).toBe(true);

    const uninstallPlugin = vi.fn(async () => ({ ok: true }) as const);
    const result = await removeCodexPlugin(
      { cwd, userHome, coodraHome, bridgePort: 3101, dryRun: false },
      fakeCliRunner({ uninstallPlugin }),
    );

    expect(uninstallPlugin).toHaveBeenCalledWith('/usr/local/bin/codex');
    expect(result.outcomes.some((o) => o.path === paths.marketplaceRoot && o.action === 'merged')).toBe(true);
    expect(existsSync(paths.marketplaceRoot)).toBe(false);
  });

  it('removeCodexPlugin still removes Coodra-owned marketplace source when the CLI is unavailable', async () => {
    const paths = codexPluginPaths(userHome, coodraHome);
    await installCodexPlugin(ctx(), fakeCliRunner());
    expect(existsSync(paths.marketplaceRoot)).toBe(true);

    const result = await removeCodexPlugin(
      { cwd, userHome, coodraHome, bridgePort: 3101, dryRun: false },
      noCliRunner(),
    );

    expect(result.outcomes.some((o) => o.notes?.includes('codex CLI not found'))).toBe(true);
    expect(existsSync(paths.marketplaceRoot)).toBe(false);
  });

  it('removeCodexPlugin --dry-run touches nothing', async () => {
    const paths = codexPluginPaths(userHome, coodraHome);
    await installCodexPlugin(ctx(), fakeCliRunner());

    const uninstallPlugin = vi.fn();
    await removeCodexPlugin(
      { cwd, userHome, coodraHome, bridgePort: 3101, dryRun: true },
      fakeCliRunner({ uninstallPlugin }),
    );

    expect(uninstallPlugin).not.toHaveBeenCalled();
    expect(existsSync(paths.marketplaceRoot)).toBe(true);
  });

  it('removeCodexPlugin reports the combined failure reason when both CLI steps fail', async () => {
    const result = await removeCodexPlugin(
      { cwd, userHome, coodraHome, bridgePort: 3101, dryRun: false },
      fakeCliRunner({
        uninstallPlugin: async () => ({ ok: false, reason: 'plugin remove: boom; marketplace remove: bang' }),
      }),
    );
    const outcome = result.outcomes.find((o) => o.notes?.includes('boom'));
    expect(outcome?.notes).toContain('bang');
  });

  it('probeCodexPlugin reports fully wired when the CLI reports the plugin installed', async () => {
    const result = await probeCodexPlugin({ cwd, userHome }, fakeCliRunner({ isInstalled: async () => true }));
    expect(result).toMatchObject({ manifest: true, marketplace: true, mcp: true, hooks: true, skills: true });
  });

  it('probeCodexPlugin falls back to file checks when the CLI is unavailable', async () => {
    await installCodexPlugin(ctx(), fakeCliRunner());
    const result = await probeCodexPlugin({ cwd, userHome }, noCliRunner());
    // File-based probe reads codexPluginPaths(userHome) with the DEFAULT
    // coodraHome (~/.coodra under userHome), not the test's separate
    // coodraHome fixture — so it correctly reports not-wired here, proving
    // the fallback path actually runs rather than silently short-circuiting.
    expect(result.manifest).toBe(false);
  });

  it('probeCodexPlugin file-fallback finds Coodra state when userHome/coodraHome default alignment matches', async () => {
    const homeWithDefaultCoodraHome = await mkdtemp(join(tmpdir(), 'coodra-codex-plugin-defaulthome-'));
    await installCodexPlugin(
      ctx({
        userHome: homeWithDefaultCoodraHome,
        mcpEntryOptions: {
          mcpServerBin: '/tmp/coodra-mcp-server.js',
          clerkSecretKey: 'sk_test',
          migrationsDir: null,
          coodraHome: join(homeWithDefaultCoodraHome, '.coodra'),
          localHookSecret: 'local-secret',
        },
      }),
      fakeCliRunner(),
    );
    const result = await probeCodexPlugin({ cwd, userHome: homeWithDefaultCoodraHome }, noCliRunner());
    expect(result).toMatchObject({ manifest: true, marketplace: true, mcp: true, hooks: true, skills: true });
  });

  it('CODEX_PLUGIN_KEY is coodra@coodra — plugin name and marketplace name are both Coodra-owned', () => {
    expect(CODEX_PLUGIN_KEY).toBe('coodra@coodra');
  });
});
