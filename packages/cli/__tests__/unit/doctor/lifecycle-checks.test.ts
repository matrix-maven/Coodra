import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  let claudeDir: string;
  let settingsPath: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'doctor-28-'));
    claudeDir = join(homeDir, '.claude');
    settingsPath = join(claudeDir, 'settings.json');
    await mkdir(claudeDir, { recursive: true });
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

  it('GREEN when all 5 events are registered with correct shape', async () => {
    const settings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }] }],
        PreToolUse: [
          {
            matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
            hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }],
          },
        ],
        PostToolUse: [
          {
            matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
            hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }],
          },
        ],
        Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }] }],
        SessionEnd: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }] }],
      },
    };
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    const result = await claudeHookRegistrationCheck.run(ctxWithHome(homeDir));
    expect(result.status).toBe('green');
  });

  it('YELLOW when SessionEnd is missing (pre-Fix-G state)', async () => {
    const settings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }] }],
        PreToolUse: [
          {
            matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
            hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }],
          },
        ],
        PostToolUse: [
          {
            matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
            hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }],
          },
        ],
        Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }] }],
      },
    };
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    const result = await claudeHookRegistrationCheck.run(ctxWithHome(homeDir));
    expect(result.status).toBe('yellow');
    expect(result.detail).toMatch(/SessionEnd/);
    expect(result.remediation).toMatch(/coodra init/);
  });

  it('YELLOW when PreToolUse still has the legacy `__coodra__` matcher (pre-Fix-F drift)', async () => {
    const settings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }] }],
        PreToolUse: [
          { matcher: '__coodra__', hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }] },
        ],
        PostToolUse: [
          {
            matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
            hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }],
          },
        ],
        Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }] }],
        SessionEnd: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }] }],
      },
    };
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    const result = await claudeHookRegistrationCheck.run(ctxWithHome(homeDir));
    expect(result.status).toBe('yellow');
    expect(result.detail).toMatch(/__coodra__|legacy/);
  });

  it('YELLOW when SessionStart wrongly has a matcher set (matcher only applies to tool events)', async () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: 'Some',
            hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }],
          },
        ],
        PreToolUse: [
          {
            matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
            hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }],
          },
        ],
        PostToolUse: [
          {
            matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
            hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }],
          },
        ],
        Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }] }],
        SessionEnd: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }] }],
      },
    };
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    const result = await claudeHookRegistrationCheck.run(ctxWithHome(homeDir));
    expect(result.status).toBe('yellow');
    expect(result.detail).toMatch(/SessionStart/);
  });

  it('YELLOW when settings.json is missing entirely', async () => {
    // Don't write the file.
    const result = await claudeHookRegistrationCheck.run(ctxWithHome(homeDir));
    expect(result.status).toBe('yellow');
    expect(result.detail).toMatch(/not found/);
    expect(result.remediation).toMatch(/coodra init/);
  });

  it('YELLOW when bridge URL on hooks does not match the configured bridgePort', async () => {
    const settings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:9999/wrong' }] }],
        PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'http', url: 'http://127.0.0.1:9999/wrong' }] }],
        PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'http', url: 'http://127.0.0.1:9999/wrong' }] }],
        Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:9999/wrong' }] }],
        SessionEnd: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:9999/wrong' }] }],
      },
    };
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    const result = await claudeHookRegistrationCheck.run(ctxWithHome(homeDir));
    expect(result.status).toBe('yellow');
    expect(result.detail).toMatch(/no-bridge-url|missing/);
  });

  it('honours CLAUDE_SETTINGS_PATH — reads the override file, not ~/.claude (F2 parity with init/uninstall)', async () => {
    const goodSettings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }] }],
        PreToolUse: [
          {
            matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
            hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }],
          },
        ],
        PostToolUse: [
          {
            matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
            hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }],
          },
        ],
        Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }] }],
        SessionEnd: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:3101/v1/hooks/claude-code' }] }],
      },
    };
    // Write the valid settings ONLY to a bespoke override path. Leave the
    // $HOME/.claude/settings.json absent — so if the check ignored the
    // override (the pre-fix behaviour) it would report "not found".
    const overridePath = join(homeDir, 'custom', 'settings.json');
    await mkdir(join(homeDir, 'custom'), { recursive: true });
    await writeFile(overridePath, JSON.stringify(goodSettings, null, 2), 'utf8');
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
