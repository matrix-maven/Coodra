import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  claudePluginPaths,
  installClaudePlugin,
  type ClaudeCliRunner,
} from '../../../src/lib/agents/claude-plugin.js';
import type { AgentContext } from '../../../src/lib/agents/types.js';
import { claudeHookRegistrationCheck } from '../../../src/doctor/checks/28-claude-hook-registration.js';
import { staleRunsCheck } from '../../../src/doctor/checks/30-stale-runs.js';
import { buildCheckContext } from '../../../src/doctor/context.js';
import { openLocalDb } from '../../../src/lib/open-local-db.js';

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
