import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadHomeEnv } from '../../src/lib/load-home-env.js';

/**
 * Closes Finding A from the 2026-04-28 functionality test:
 *   `coodra init` writes `.env` to `<cwd>/.env`, but commit 34faa0e's
 *   loader read `<COODRA_HOME>/.env` only. Different files. Init's
 *   .env was therefore decorative end-to-end, team-mode setups silently
 *   fell back to solo, and doctor check 20 (`LOCAL_HOOK_SECRET` present)
 *   was YELLOW for this exact reason.
 *
 * The fix: `loadHomeEnv` now reads BOTH paths and returns a merged dict.
 * On conflict, `<cwd>/.env` wins because it's the more specific scope.
 * Either file may be missing — that's a no-op. These tests pin all five
 * shapes the call site can encounter.
 */

describe('loadHomeEnv — layered <COODRA_HOME>/.env + <cwd>/.env', () => {
  let homeDir: string;
  let cwdDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'load-home-env-home-'));
    cwdDir = mkdtempSync(join(tmpdir(), 'load-home-env-cwd-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(cwdDir, { recursive: true, force: true });
  });

  it('case 1 — both files exist, no overlap → all vars from both present', () => {
    writeFileSync(
      join(homeDir, '.env'),
      ['COODRA_GRAPHIFY_ROOT=/var/graphify', 'CLERK_PUBLISHABLE_KEY=pk_test_replace_me'].join('\n'),
      'utf8',
    );
    writeFileSync(join(cwdDir, '.env'), [`LOCAL_HOOK_SECRET=${'a'.repeat(40)}`, 'COODRA_MODE=solo'].join('\n'), 'utf8');

    const merged = loadHomeEnv(homeDir, cwdDir);

    expect(merged.COODRA_GRAPHIFY_ROOT).toBe('/var/graphify');
    expect(merged.CLERK_PUBLISHABLE_KEY).toBe('pk_test_replace_me');
    expect(merged.LOCAL_HOOK_SECRET).toBe('a'.repeat(40));
    expect(merged.COODRA_MODE).toBe('solo');
  });

  it('case 2 — both files exist with overlap → home wins for machine-level keys, cwd wins for everything else', () => {
    // The precedence is dual, not one-direction. See
    // packages/cli/src/lib/load-home-env.ts::MACHINE_LEVEL_KEYS for the
    // canonical list. Two policy fixes drove the carve-out:
    //   - M04 Phase 4 (2026-05-11): a stale project .env carrying
    //     COODRA_MODE=solo silently demoted a team developer back to
    //     solo — sync-daemon never spawned, runs never pushed. Home
    //     `.env` now wins for COODRA_MODE / DATABASE_URL /
    //     LOCAL_HOOK_SECRET / COODRA_TEAM_*.
    //   - Phase H.6 (2026-05-13): CLERK_SECRET_KEY + CLERK_PUBLISHABLE_KEY
    //     joined the same set. `coodra init` writes the solo-bypass
    //     sentinels into every project .env; without this carve-out
    //     they overrode the real team-mode Clerk keys from ~/.coodra/.env
    //     and feature-db.ts fell back to the legacy (forgeable) path.
    writeFileSync(
      join(homeDir, '.env'),
      ['COODRA_MODE=team', 'CLERK_SECRET_KEY=sk_test_from_home', 'COODRA_GRAPHIFY_ROOT=/var/graphify-home'].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(cwdDir, '.env'),
      ['COODRA_MODE=solo', 'CLERK_SECRET_KEY=sk_test_from_project', 'COODRA_GRAPHIFY_ROOT=/var/graphify-project'].join(
        '\n',
      ),
      'utf8',
    );

    const merged = loadHomeEnv(homeDir, cwdDir);

    // Machine-level: home wins (overrides whatever the project says).
    expect(merged.COODRA_MODE).toBe('team');
    expect(merged.CLERK_SECRET_KEY).toBe('sk_test_from_home');
    // Non-machine-level: cwd wins (per-project override).
    expect(merged.COODRA_GRAPHIFY_ROOT).toBe('/var/graphify-project');
  });

  it('case 3 — only <COODRA_HOME>/.env exists → its vars loaded', () => {
    writeFileSync(
      join(homeDir, '.env'),
      ['COODRA_MODE=solo', 'CLERK_SECRET_KEY=sk_test_replace_me'].join('\n'),
      'utf8',
    );
    // No file at cwdDir/.env.

    const merged = loadHomeEnv(homeDir, cwdDir);

    expect(merged.COODRA_MODE).toBe('solo');
    expect(merged.CLERK_SECRET_KEY).toBe('sk_test_replace_me');
  });

  it('case 4 — only <cwd>/.env exists → its vars loaded (this is the post-init shape)', () => {
    // This is exactly the state `coodra init` leaves behind: it wrote
    // .env to <cwd>, no <COODRA_HOME>/.env exists yet. Pre-fix, the
    // loader returned {} here and `start` saw nothing.
    writeFileSync(
      join(cwdDir, '.env'),
      [
        'COODRA_MODE=solo',
        'CLERK_SECRET_KEY=sk_test_replace_me',
        'CLERK_PUBLISHABLE_KEY=pk_test_replace_me',
        `LOCAL_HOOK_SECRET=${'b'.repeat(40)}`,
      ].join('\n'),
      'utf8',
    );

    const merged = loadHomeEnv(homeDir, cwdDir);

    expect(merged.COODRA_MODE).toBe('solo');
    expect(merged.CLERK_SECRET_KEY).toBe('sk_test_replace_me');
    expect(merged.CLERK_PUBLISHABLE_KEY).toBe('pk_test_replace_me');
    expect(merged.LOCAL_HOOK_SECRET).toBe('b'.repeat(40));
  });

  it('case 5 — neither file exists → no error, empty dict', () => {
    // Both tmp dirs created in beforeEach but neither has a .env.
    const merged = loadHomeEnv(homeDir, cwdDir);
    expect(merged).toEqual({});
  });

  it('back-compat — projectCwd omitted, behaves as the original home-only loader', () => {
    writeFileSync(join(homeDir, '.env'), 'COODRA_MODE=solo\n', 'utf8');
    writeFileSync(join(cwdDir, '.env'), 'COODRA_MODE=team\n', 'utf8');

    // Don't pass the second arg — old call sites that only know about the
    // home layer must keep working unchanged.
    const merged = loadHomeEnv(homeDir);

    expect(merged.COODRA_MODE).toBe('solo');
  });
});
