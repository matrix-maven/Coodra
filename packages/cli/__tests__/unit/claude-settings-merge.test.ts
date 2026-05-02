import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildContextosHookSpec,
  mergeClaudeSettings,
} from '../../src/lib/init/claude-settings-merge.js';

/**
 * Locks the dec_83ba10c1 (2026-05-02) hook merger contract:
 *
 *   1. Greenfield write — when ~/.claude/settings.json is absent we
 *      create a baseline file with all four ContextOS hook entries.
 *   2. Idempotent merge — running the merger twice with identical
 *      inputs is a no-op (`action: 'unchanged'`) the second time.
 *   3. User entries preserved — pre-existing user-authored hook
 *      entries (matcher !== '__contextos__') survive every merge.
 *   4. Backup on first divergent write — when an existing settings.json
 *      already has hooks AND the merger writes new content, the
 *      original is copied to a `.contextos-backup-<ts>` file.
 *   5. Force flag — `--force` overwrites even when entries already
 *      match the baseline.
 *   6. Dry run — no disk writes happen with `dryRun: true`.
 */
describe('mergeClaudeSettings — write contract', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'contextos-claude-merge-'));
  });
  afterEach(() => {
    /* tmp cleaned by OS */
  });

  it('Phase 3 Fix B: creates a non-existent parent dir with mode 0700 before writing', async () => {
    // settingsPath sits inside a `.claude` subdir that does NOT
    // exist yet — exactly the state on a fresh machine where Claude
    // Code has never been launched. Pre-Fix-B the init wrapper
    // skipped the merger entirely in this case; the merger itself
    // already had `mkdir { recursive: true }` but was never reached.
    // Fix B drops the wrapper gate AND tightens the mkdir mode.
    const claudeDir = join(home, '.claude');
    const settingsPath = join(claudeDir, 'settings.json');

    const { stat } = await import('node:fs/promises');
    await expect(stat(claudeDir)).rejects.toMatchObject({ code: 'ENOENT' });

    const result = await mergeClaudeSettings({ settingsPath, bridgePort: 3101, force: false, dryRun: false });
    expect(result.outcome.action).toBe('wrote');

    const dirStat = await stat(claudeDir);
    expect(dirStat.isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      expect(dirStat.mode & 0o777).toBe(0o700);
    }

    const body = JSON.parse(await readFile(settingsPath, 'utf8'));
    expect(body.hooks.SessionStart).toHaveLength(1);
  });

  it('greenfield: writes a baseline ~/.claude/settings.json with all four ContextOS hook entries', async () => {
    const settingsPath = join(home, 'settings.json');
    const result = await mergeClaudeSettings({
      settingsPath,
      bridgePort: 3101,
      force: false,
      dryRun: false,
    });

    expect(result.outcome.action).toBe('wrote');
    const body = JSON.parse(await readFile(settingsPath, 'utf8'));
    expect(body.hooks.SessionStart).toHaveLength(1);
    expect(body.hooks.PreToolUse).toHaveLength(1);
    expect(body.hooks.PostToolUse).toHaveLength(1);
    expect(body.hooks.Stop).toHaveLength(1);

    const sessionStart = body.hooks.SessionStart[0];
    expect(sessionStart.matcher).toBe('__contextos__');
    expect(sessionStart.hooks).toHaveLength(1);
    const spec = sessionStart.hooks[0];
    expect(spec.type).toBe('http');
    expect(spec.url).toBe('http://127.0.0.1:3101/v1/hooks/claude-code');
    expect(spec.headers).toEqual({ 'X-Local-Hook-Secret': '$LOCAL_HOOK_SECRET' });
    expect(spec.allowedEnvVars).toEqual(['LOCAL_HOOK_SECRET']);
    expect(spec.timeout).toBe(10);
  });

  it('idempotent re-run is unchanged', async () => {
    const settingsPath = join(home, 'settings.json');
    await mergeClaudeSettings({ settingsPath, bridgePort: 3101, force: false, dryRun: false });

    const second = await mergeClaudeSettings({ settingsPath, bridgePort: 3101, force: false, dryRun: false });
    expect(second.outcome.action).toBe('unchanged');
  });

  it('preserves user-authored hook entries (matcher != __contextos__)', async () => {
    const settingsPath = join(home, 'settings.json');
    const userOwned = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo wrote-something' }],
          },
        ],
        SessionStart: [
          {
            hooks: [{ type: 'command', command: 'echo session-started' }],
          },
        ],
      },
      // Other unrelated user settings, must survive untouched.
      theme: 'dark',
    };
    await writeFile(settingsPath, JSON.stringify(userOwned, null, 2), 'utf8');

    const result = await mergeClaudeSettings({
      settingsPath,
      bridgePort: 3101,
      force: false,
      dryRun: false,
    });
    expect(result.outcome.action).toBe('merged');

    const body = JSON.parse(await readFile(settingsPath, 'utf8'));
    expect(body.theme).toBe('dark');
    // The user's PreToolUse + SessionStart entries survived.
    expect(body.hooks.PreToolUse).toHaveLength(2);
    expect(body.hooks.SessionStart).toHaveLength(2);
    const userPreToolUse = (body.hooks.PreToolUse as Array<{ matcher?: string }>).find(
      (e) => e.matcher === 'Write',
    );
    expect(userPreToolUse).toBeDefined();
  });

  it('backs up the original on first divergent write', async () => {
    const settingsPath = join(home, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ theme: 'dark' }, null, 2), 'utf8');

    await mergeClaudeSettings({ settingsPath, bridgePort: 3101, force: false, dryRun: false });

    const entries = await readdir(home);
    const backups = entries.filter((e) => e.startsWith('settings.json.contextos-backup-'));
    expect(backups.length).toBe(1);
    const backupBody = JSON.parse(await readFile(join(home, backups[0] as string), 'utf8'));
    expect(backupBody.theme).toBe('dark');
  });

  it('force flag overwrites a custom contextos-matcher entry to baseline', async () => {
    const settingsPath = join(home, 'settings.json');
    const custom = {
      hooks: {
        SessionStart: [
          {
            matcher: '__contextos__',
            hooks: [{ type: 'http', url: 'http://9.9.9.9:9999/wrong', headers: {}, allowedEnvVars: [], timeout: 1 }],
          },
        ],
      },
    };
    await writeFile(settingsPath, JSON.stringify(custom, null, 2), 'utf8');

    const result = await mergeClaudeSettings({
      settingsPath,
      bridgePort: 3101,
      force: true,
      dryRun: false,
    });
    expect(result.outcome.action).toBe('forced');

    const body = JSON.parse(await readFile(settingsPath, 'utf8'));
    const ours = body.hooks.SessionStart[0];
    expect(ours.hooks[0].url).toBe('http://127.0.0.1:3101/v1/hooks/claude-code');
  });

  it('dry-run does not write to disk', async () => {
    const settingsPath = join(home, 'settings.json');
    const result = await mergeClaudeSettings({ settingsPath, bridgePort: 3101, force: false, dryRun: true });
    expect(result.outcome.notes).toContain('dry-run');
    await expect(readFile(settingsPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('buildContextosHookSpec', () => {
  it('honours custom bridgeHost + timeout', () => {
    const spec = buildContextosHookSpec({
      bridgePort: 5555,
      bridgeHost: 'localhost',
      timeoutSec: 30,
      force: false,
      dryRun: false,
    });
    expect(spec.url).toBe('http://localhost:5555/v1/hooks/claude-code');
    expect(spec.timeout).toBe(30);
  });
});
