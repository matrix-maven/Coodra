import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeHookRegistrationCheck } from '../../../src/doctor/checks/28-claude-hook-registration.js';
import { staleRunsCheck } from '../../../src/doctor/checks/30-stale-runs.js';
import { codexHookRegistrationCheck } from '../../../src/doctor/checks/39-codex-hook-registration.js';
import { buildCheckContext } from '../../../src/doctor/context.js';
import { type ClaudeCliRunner, claudePluginPaths, installClaudePlugin } from '../../../src/lib/agents/claude-plugin.js';
import {
  type CodexCliRunner,
  codexPluginPaths,
  installCodexPlugin,
  LEGACY_CODEX_PERSONAL_PLUGIN_KEY,
} from '../../../src/lib/agents/codex-plugin.js';
import type { AgentContext } from '../../../src/lib/agents/types.js';
import { openLocalDb } from '../../../src/lib/open-local-db.js';

/**
 * `codexHookRegistrationCheck.run()` constructs its own real, short-timeout
 * `createCodexCliRunner` internally (same "deliberate, read-only exception"
 * as check 28's `createClaudeCliRunner` — see that check's doc comment) —
 * there's no injection point through `Check.run(ctx)`'s fixed signature.
 * Unlike `claude`, a real `codex` binary with `coodra@coodra` genuinely
 * installed+enabled is common on a Coodra contributor's own dev machine
 * (Codex Desktop ships it, unprompted, at `/usr/local/bin/codex` or the
 * ChatGPT.app bundle path) — so leaving this real would make the
 * NOT-installed/missing-hooks/missing-skills cases below flip green
 * whenever run on such a machine, contaminated by host state the fixture
 * never controls. Force `createCodexCliRunner`'s CLI fast-path off for
 * every test in this file so the check exercises its own file-based probe
 * logic deterministically, regardless of what's on the host's PATH.
 */
vi.mock('../../../src/lib/agents/codex-plugin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/agents/codex-plugin.js')>();
  return {
    ...actual,
    createCodexCliRunner: () => ({
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
    }),
  };
});

/**
 * Slice 5 (2026-05-03 audit §14.1) — unit tests for the three new
 * doctor lifecycle checks. The synthetic-PreToolUse-loop check (29)
 * lives in integration because it depends on a running bridge; this
 * file covers the read-only checks (28 + 30) against tmpdir-backed
 * fixtures.
 */

function ctxWithHome(home: string, overrides: Partial<Parameters<typeof buildCheckContext>[0]> = {}) {
  return buildCheckContext({
    env: {},
    coodraHomeOverride: home,
    cwd: home,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Check 28 — claude hook registration
// ---------------------------------------------------------------------------

describe('claudeHookRegistrationCheck (28)', () => {
  let homeDir: string;
  let cwd: string;
  let coodraHome: string;
  let originalHome: string | undefined;

  /**
   * A `ClaudeCliRunner` whose `detect()` always resolves `null` — same
   * safety reasoning as `claude-plugin.test.ts`: never let a fixture-seeding
   * call fall through to the real `defaultClaudeCliRunner`, which would
   * shell out to a genuine system `claude` binary if one happens to be on
   * the test runner's PATH. `claudeHookRegistrationCheck.run()` itself
   * still uses the real (short-timeout) runner internally — that's a
   * deliberate, read-only exception (see the check's own doc comment).
   */
  function noCliRunner(): ClaudeCliRunner {
    return {
      detect: async () => null,
      installMarketplaceAndPlugin: async () => {
        throw new Error('unexpected: claude CLI should not be invoked while seeding this fixture');
      },
      uninstallPlugin: async () => {
        throw new Error('unexpected: claude CLI should not be invoked while seeding this fixture');
      },
      isInstalled: async () => {
        throw new Error('unexpected: claude CLI should not be invoked while seeding this fixture');
      },
    };
  }

  function agentCtx(overrides: Partial<AgentContext> = {}): AgentContext {
    return {
      cwd,
      userHome: homeDir,
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

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'doctor-28-home-'));
    cwd = await mkdtemp(join(tmpdir(), 'doctor-28-cwd-'));
    coodraHome = await mkdtemp(join(tmpdir(), 'doctor-28-coodra-'));
    await mkdir(join(homeDir, '.claude'), { recursive: true });
    // Override homedir() lookup by patching the env's HOME — the check
    // calls `homedir()` from node:os which honours $HOME on macOS/Linux.
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });
  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  it('GREEN when the native plugin is fully wired (enabled, marketplace, manifest, mcp, hooks, skills)', async () => {
    await installClaudePlugin(agentCtx(), noCliRunner());
    const result = await claudeHookRegistrationCheck.run(ctxWithHome(homeDir));
    expect(result.status).toBe('green');
  });

  it('YELLOW when settings.json is missing entirely — nothing installed yet', async () => {
    const result = await claudeHookRegistrationCheck.run(ctxWithHome(homeDir));
    expect(result.status).toBe('yellow');
    expect(result.detail).toMatch(/enabled in settings\.json/);
    expect(result.remediation).toMatch(/coodra agent add claude/);
  });

  it('YELLOW when the plugin is disabled in settings.json (enabledPlugins flipped false)', async () => {
    await installClaudePlugin(agentCtx(), noCliRunner());
    const paths = claudePluginPaths(homeDir, coodraHome);
    const settings = JSON.parse(await readFile(paths.settingsPath, 'utf8'));
    settings.enabledPlugins['coodra@coodra'] = false;
    await writeFile(paths.settingsPath, JSON.stringify(settings, null, 2), 'utf8');

    const result = await claudeHookRegistrationCheck.run(ctxWithHome(homeDir));
    expect(result.status).toBe('yellow');
    expect(result.detail).toMatch(/enabled in settings\.json/);
  });

  it('YELLOW when the marketplace registration is missing (known_marketplaces.json)', async () => {
    await installClaudePlugin(agentCtx(), noCliRunner());
    const paths = claudePluginPaths(homeDir, coodraHome);
    await rm(paths.knownMarketplacesPath, { force: true });

    const result = await claudeHookRegistrationCheck.run(ctxWithHome(homeDir));
    expect(result.status).toBe('yellow');
    expect(result.detail).toMatch(/marketplace registration/);
  });

  it('YELLOW when the cached hooks.json is missing — the native-plugin equivalent of the old missing-hook-events case', async () => {
    await installClaudePlugin(agentCtx(), noCliRunner());
    const paths = claudePluginPaths(homeDir, coodraHome);
    await rm(paths.cacheHooksPath, { force: true });

    const result = await claudeHookRegistrationCheck.run(ctxWithHome(homeDir));
    expect(result.status).toBe('yellow');
    expect(result.detail).toMatch(/lifecycle hooks/);
    expect(result.remediation).toMatch(/coodra agent (add|repair) claude/);
  });

  it('YELLOW when the cached skills are missing', async () => {
    await installClaudePlugin(agentCtx(), noCliRunner());
    const paths = claudePluginPaths(homeDir, coodraHome);
    await rm(join(paths.cacheSkillsRoot, 'coodra-context'), { recursive: true, force: true });

    const result = await claudeHookRegistrationCheck.run(ctxWithHome(homeDir));
    expect(result.status).toBe('yellow');
    expect(result.detail).toMatch(/bundled skills/);
  });

  it('honours CLAUDE_SETTINGS_PATH — reads the override file for enablement, not ~/.claude (F2 parity with init/uninstall)', async () => {
    await installClaudePlugin(agentCtx(), noCliRunner());
    const paths = claudePluginPaths(homeDir, coodraHome);
    const settingsContent = await readFile(paths.settingsPath, 'utf8');

    // Move enablement to a bespoke override path and remove the original —
    // so if the check ignored CLAUDE_SETTINGS_PATH (the pre-fix behaviour)
    // it would report "enabled in settings.json" as missing.
    const overridePath = join(homeDir, 'custom', 'settings.json');
    await mkdir(join(homeDir, 'custom'), { recursive: true });
    await writeFile(overridePath, settingsContent, 'utf8');
    await rm(paths.settingsPath, { force: true });

    const result = await claudeHookRegistrationCheck.run(
      ctxWithHome(homeDir, { env: { CLAUDE_SETTINGS_PATH: overridePath } }),
    );
    expect(result.status).toBe('green');
  });
});

// ---------------------------------------------------------------------------
// Check 39 — codex hook registration
// ---------------------------------------------------------------------------

describe('codexHookRegistrationCheck (39)', () => {
  let homeDir: string;
  let cwd: string;

  /**
   * Same reasoning as check 28's `noCliRunner` fixture guard: never let a
   * fixture-seeding call fall through to the real `defaultCodexCliRunner`,
   * which would shell out to a genuine system `codex` binary if one
   * happens to be on the test runner's PATH.
   */
  function noCliRunner(): CodexCliRunner {
    return {
      detect: async () => null,
      installMarketplaceAndPlugin: async () => {
        throw new Error('unexpected: codex CLI should not be invoked while seeding this fixture');
      },
      uninstallPlugin: async () => {
        throw new Error('unexpected: codex CLI should not be invoked while seeding this fixture');
      },
      isInstalled: async () => {
        throw new Error('unexpected: codex CLI should not be invoked while seeding this fixture');
      },
    };
  }

  /**
   * `probeCodexPlugin` (used internally by `codexHookRegistrationCheck`,
   * same as check 14) always resolves `~/.coodra` from `userHome` with no
   * override — it has no way to know about a separately-configured
   * `mcpEntryOptions.coodraHome` (see `codex-plugin.test.ts`'s own
   * "default coodraHome alignment" case for the same constraint). Every
   * fixture here must therefore install with `coodraHome` pinned to
   * `join(homeDir, '.coodra')` so the check's own default path resolution
   * actually finds what was seeded.
   */
  function agentCtx(overrides: Partial<AgentContext> = {}): AgentContext {
    return {
      cwd,
      userHome: homeDir,
      projectSlug: 'demo',
      bridgePort: 3101,
      localHookSecret: 'local-secret',
      mcpEntryOptions: {
        mcpServerBin: '/tmp/coodra-mcp-server.js',
        clerkSecretKey: 'sk_test',
        migrationsDir: null,
        coodraHome: join(homeDir, '.coodra'),
        localHookSecret: 'local-secret',
      },
      force: false,
      dryRun: false,
      ...overrides,
    };
  }

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'doctor-39-home-'));
    cwd = await mkdtemp(join(tmpdir(), 'doctor-39-cwd-'));
  });

  it('GREEN when the native plugin is fully wired (manifest, marketplace, mcp, hooks, skills)', async () => {
    await installCodexPlugin(agentCtx(), noCliRunner());
    const result = await codexHookRegistrationCheck.run(ctxWithHome(homeDir, { env: { HOME: homeDir } }));
    expect(result.status).toBe('green');
    expect(result.detail).toMatch(/hook-trust review/);
  });

  it('YELLOW when a legacy coodra@personal plugin entry points at a missing marketplace', async () => {
    await installCodexPlugin(agentCtx(), noCliRunner());
    await mkdir(join(homeDir, '.codex'), { recursive: true });
    await writeFile(
      join(homeDir, '.codex', 'config.toml'),
      `[plugins."${LEGACY_CODEX_PERSONAL_PLUGIN_KEY}"]\nenabled = true\n\n[plugins."coodra@coodra"]\nenabled = true\n\n[marketplaces.coodra]\nsource_type = "local"\nsource = "${join(homeDir, '.coodra', 'codex-marketplaces', 'coodra')}"\n`,
      'utf8',
    );

    const result = await codexHookRegistrationCheck.run(ctxWithHome(homeDir, { env: { HOME: homeDir } }));
    expect(result.status).toBe('yellow');
    expect(result.detail).toContain(LEGACY_CODEX_PERSONAL_PLUGIN_KEY);
    expect(result.remediation).toMatch(/coodra agent (add|repair) codex/);
  });

  it('YELLOW when nothing is installed yet', async () => {
    const result = await codexHookRegistrationCheck.run(ctxWithHome(homeDir, { env: { HOME: homeDir } }));
    expect(result.status).toBe('yellow');
    expect(result.detail).toMatch(/plugin manifest/);
    expect(result.remediation).toMatch(/coodra agent add codex/);
  });

  it('YELLOW when the hooks.json is missing', async () => {
    await installCodexPlugin(agentCtx(), noCliRunner());
    const paths = codexPluginPaths(homeDir, join(homeDir, '.coodra'));
    await rm(paths.hooksPath, { force: true });

    const result = await codexHookRegistrationCheck.run(ctxWithHome(homeDir, { env: { HOME: homeDir } }));
    expect(result.status).toBe('yellow');
    expect(result.detail).toMatch(/lifecycle hooks/);
    expect(result.remediation).toMatch(/coodra agent (add|repair) codex/);
  });

  it('YELLOW when the bundled skills are missing', async () => {
    await installCodexPlugin(agentCtx(), noCliRunner());
    const paths = codexPluginPaths(homeDir, join(homeDir, '.coodra'));
    await rm(join(paths.skillsRoot, 'coodra-context'), { recursive: true, force: true });

    const result = await codexHookRegistrationCheck.run(ctxWithHome(homeDir, { env: { HOME: homeDir } }));
    expect(result.status).toBe('yellow');
    expect(result.detail).toMatch(/bundled skills/);
  });
});

// ---------------------------------------------------------------------------
// Check 30 — stale in_progress runs
// ---------------------------------------------------------------------------

describe('staleRunsCheck (30)', () => {
  let homeDir: string;
  let dataDb: string;
  let handle: SqliteHandle;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'doctor-30-'));
    dataDb = join(homeDir, 'data.db');
    // The schema includes vec0 virtual tables (Module 02 sqlite-vec
    // integration); without loading the extension, migrateSqlite fails
    // on the CREATE VIRTUAL TABLE statement. Doctor's runtime probe of
    // this check uses the extension-less openLocalDb (it only reads
    // ordinary tables), but the test fixture has to apply migrations
    // up front, so it loads the extension once at setup.
    handle = await openLocalDb(dataDb, { loadVecExtension: true });
    migrateSqlite(handle.db);
    handle.raw
      .prepare('INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)')
      .run('proj-1', 'p1', '__solo__', 'p1');
  });
  afterEach(() => {
    handle.close();
  });

  function seedRun(id: string, startedAtSec: number, status = 'in_progress'): void {
    handle.raw
      .prepare(
        `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, 'proj-1', `sess_${id}`, 'claude_code', 'solo', status, startedAtSec);
  }

  it('GREEN when no in_progress runs are older than 24h', async () => {
    const now = new Date('2026-05-03T12:00:00Z');
    seedRun('run_recent', Math.floor(now.getTime() / 1000) - 60); // 1 minute ago — fresh
    const ctx = buildCheckContext({
      env: {},
      coodraHomeOverride: homeDir,
      cwd: homeDir,
      now: () => now,
    });
    const result = await staleRunsCheck.run(ctx);
    expect(result.status).toBe('green');
  });

  it('YELLOW when one or more in_progress runs are older than 24h', async () => {
    const now = new Date('2026-05-03T12:00:00Z');
    const oldSec = Math.floor(now.getTime() / 1000) - 25 * 3600; // 25h ago
    seedRun('run_old_a', oldSec);
    seedRun('run_old_b', oldSec);
    const ctx = buildCheckContext({
      env: {},
      coodraHomeOverride: homeDir,
      cwd: homeDir,
      now: () => now,
    });
    const result = await staleRunsCheck.run(ctx);
    expect(result.status).toBe('yellow');
    expect(result.detail).toMatch(/2 in_progress/);
    expect(result.remediation).toMatch(/SessionStart/);
  });

  it('GREEN when stale runs exist but their status is already abandoned/completed/failed', async () => {
    const now = new Date('2026-05-03T12:00:00Z');
    const oldSec = Math.floor(now.getTime() / 1000) - 25 * 3600;
    seedRun('run_abandoned', oldSec, 'abandoned');
    seedRun('run_completed', oldSec, 'completed');
    seedRun('run_failed', oldSec, 'failed');
    const ctx = buildCheckContext({
      env: {},
      coodraHomeOverride: homeDir,
      cwd: homeDir,
      now: () => now,
    });
    const result = await staleRunsCheck.run(ctx);
    expect(result.status).toBe('green');
  });
});

// vi.fn unused but kept imported as a sentinel that the test runner is wired correctly
void vi.fn;
