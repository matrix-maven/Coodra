import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

  it('removes marketplace entry and plugin bundle', async () => {
    const paths = codexPluginPaths(userHome);
    await installCodexPlugin(ctx());

    const result = await removeCodexPlugin({
      cwd,
      userHome,
      coodraHome,
      bridgePort: 3101,
      dryRun: false,
    });

    expect(result.outcomes.some((o) => o.path === paths.marketplacePath && o.action === 'merged')).toBe(true);
    expect(result.outcomes.some((o) => o.path === paths.pluginRoot && o.action === 'merged')).toBe(true);
    expect(existsSync(paths.pluginRoot)).toBe(false);
    expect(await probeCodexPlugin({ cwd, userHome })).toMatchObject({
      manifest: false,
      marketplace: false,
      mcp: false,
      hooks: false,
      skills: false,
    });
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
