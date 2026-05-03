import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContextosHookSpec, mergeClaudeSettings } from '../../src/lib/init/claude-settings-merge.js';

/**
 * Locks the hook-merger contract across Phase-3 dec_83ba10c1,
 * Phase-4 Fix F (both 2026-05-02), and Phase-4 Fix G (Slice 2,
 * 2026-05-03 audit — SessionEnd added):
 *
 *   1. Greenfield write — absent settings.json → baseline file with
 *      all five ContextOS hook entries (SessionStart, PreToolUse,
 *      PostToolUse, Stop, SessionEnd).
 *   2. Idempotent merge — twice with identical inputs is a no-op.
 *   3. User entries preserved — entries with no bridge URL survive.
 *   4. Backup on first divergent write.
 *   5. Force flag — overwrites even when entries already match.
 *   6. Dry run — no disk writes.
 *   7. **Phase 4 Fix F: per-event matchers** — PreToolUse and
 *      PostToolUse get `Write|Edit|MultiEdit|NotebookEdit|Bash`;
 *      SessionStart and Stop omit `matcher` entirely.
 *   8. **Phase 4 Fix F: URL-based ownership** — entries are
 *      identified by hook URL pointing at the bridge, not by the
 *      old `matcher === '__contextos__'` sentinel. User entries
 *      with `matcher: 'Write'` or any other tool-name regex are
 *      preserved as long as they don't POST to the ContextOS bridge.
 *   9. **Phase 4 Fix F: legacy migration** — pre-Fix-F entries
 *      (matcher='__contextos__' + bridge URL) are recognised and
 *      replaced with the new shape on next merge.
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

  it('Phase 4 Fix F + Fix G greenfield: tool events get the file-mutating-tool regex; non-tool events (SessionStart/Stop/SessionEnd) omit matcher', async () => {
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
    // Phase 4 Fix G (Slice 2 — 2026-05-03 audit). Without SessionEnd
    // here, real Claude Code never POSTs SessionEnd → bridge's
    // status-flip + auto-pack-save never fires for real sessions →
    // runs accumulate as `in_progress` forever. Bridge dispatcher was
    // already correct; only this list was missing the entry.
    expect(body.hooks.SessionEnd).toHaveLength(1);

    // Tool events: matcher is the tool-name regex covering every tool the
    // default policy governs. Without this Claude Code's hook would never
    // fire for Write / Edit / MultiEdit / NotebookEdit / Bash.
    expect(body.hooks.PreToolUse[0].matcher).toBe('Write|Edit|MultiEdit|NotebookEdit|Bash');
    expect(body.hooks.PostToolUse[0].matcher).toBe('Write|Edit|MultiEdit|NotebookEdit|Bash');

    // Non-tool events: matcher is OMITTED — Claude Code's hook spec
    // doesn't use matcher for SessionStart/Stop/SessionEnd, and the
    // legacy `__contextos__` sentinel value made tool events
    // functionally inert. SessionEnd follows the same shape.
    expect(body.hooks.SessionStart[0].matcher).toBeUndefined();
    expect(body.hooks.Stop[0].matcher).toBeUndefined();
    expect(body.hooks.SessionEnd[0].matcher).toBeUndefined();

    // Hook spec shape unchanged across all five events.
    for (const eventName of ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'] as const) {
      const entry = body.hooks[eventName][0];
      expect(entry.hooks).toHaveLength(1);
      const spec = entry.hooks[0];
      expect(spec.type).toBe('http');
      expect(spec.url).toBe('http://127.0.0.1:3101/v1/hooks/claude-code');
      expect(spec.headers).toEqual({ 'X-Local-Hook-Secret': '$LOCAL_HOOK_SECRET' });
      expect(spec.allowedEnvVars).toEqual(['LOCAL_HOOK_SECRET']);
      expect(spec.timeout).toBe(10);
    }
  });

  it('idempotent re-run is unchanged', async () => {
    const settingsPath = join(home, 'settings.json');
    await mergeClaudeSettings({ settingsPath, bridgePort: 3101, force: false, dryRun: false });

    const second = await mergeClaudeSettings({ settingsPath, bridgePort: 3101, force: false, dryRun: false });
    expect(second.outcome.action).toBe('unchanged');
  });

  it('Phase 4 Fix F: preserves user-authored hook entries identified by NOT having the bridge URL', async () => {
    const settingsPath = join(home, 'settings.json');
    const userOwned = {
      hooks: {
        PreToolUse: [
          {
            // User entry happens to use the SAME tool-name regex Fix F
            // emits — that's fine because it's identified by the
            // command-not-bridge-URL property below, not by matcher.
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
    // The user's PreToolUse + SessionStart entries survived alongside the
    // newly-appended ContextOS entry.
    expect(body.hooks.PreToolUse).toHaveLength(2);
    expect(body.hooks.SessionStart).toHaveLength(2);
    const userPreToolUse = (
      body.hooks.PreToolUse as Array<{ matcher?: string; hooks: Array<{ type: string; url?: string }> }>
    ).find((e) => e.hooks?.[0]?.type === 'command');
    expect(userPreToolUse).toBeDefined();
    expect(userPreToolUse?.matcher).toBe('Write');
    // ContextOS entry is the one with the bridge URL.
    const ctxPreToolUse = (body.hooks.PreToolUse as Array<{ matcher?: string; hooks: Array<{ url?: string }> }>).find(
      (e) => e.hooks?.[0]?.url?.includes('/v1/hooks/claude-code'),
    );
    expect(ctxPreToolUse?.matcher).toBe('Write|Edit|MultiEdit|NotebookEdit|Bash');
  });

  it('Phase 4 Fix F: legacy entry (matcher=__contextos__ + bridge URL) is migrated to the new shape', async () => {
    const settingsPath = join(home, 'settings.json');
    // Pre-Fix-F shape: matcher='__contextos__' on every event, including
    // PreToolUse where the literal sentinel never matched any tool.
    const legacy = {
      hooks: {
        SessionStart: [
          {
            matcher: '__contextos__',
            hooks: [
              {
                type: 'http',
                url: 'http://127.0.0.1:3101/v1/hooks/claude-code',
                headers: { 'X-Local-Hook-Secret': '$LOCAL_HOOK_SECRET' },
                allowedEnvVars: ['LOCAL_HOOK_SECRET'],
                timeout: 10,
              },
            ],
          },
        ],
        PreToolUse: [
          {
            matcher: '__contextos__',
            hooks: [
              {
                type: 'http',
                url: 'http://127.0.0.1:3101/v1/hooks/claude-code',
                headers: { 'X-Local-Hook-Secret': '$LOCAL_HOOK_SECRET' },
                allowedEnvVars: ['LOCAL_HOOK_SECRET'],
                timeout: 10,
              },
            ],
          },
        ],
      },
    };
    await writeFile(settingsPath, JSON.stringify(legacy, null, 2), 'utf8');

    const result = await mergeClaudeSettings({
      settingsPath,
      bridgePort: 3101,
      force: false,
      dryRun: false,
    });
    expect(result.outcome.action).toBe('merged');

    const body = JSON.parse(await readFile(settingsPath, 'utf8'));
    // Exactly one ContextOS entry per event after migration — the legacy
    // entry was identified by URL and replaced, not duplicated.
    expect(body.hooks.SessionStart).toHaveLength(1);
    expect(body.hooks.PreToolUse).toHaveLength(1);
    // The PreToolUse matcher is now the real tool-name regex.
    expect(body.hooks.PreToolUse[0].matcher).toBe('Write|Edit|MultiEdit|NotebookEdit|Bash');
    // The SessionStart matcher is now omitted entirely.
    expect(body.hooks.SessionStart[0].matcher).toBeUndefined();
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

  it('force flag overwrites a custom-URL entry that is NOT contextos-owned (different URL → user-owned, only --force replaces it)', async () => {
    const settingsPath = join(home, 'settings.json');
    // A user has a custom HTTP hook pointing at THEIR server (NOT the
    // bridge). Without --force, it's preserved as a user entry. With
    // --force, baseline is re-asserted (the user entry stays — it's
    // user-owned by URL — and a contextos entry is added).
    const custom = {
      hooks: {
        SessionStart: [
          {
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
    // The user's non-bridge URL entry is preserved (URL-based ownership
    // means anything not pointing at the bridge is "theirs").
    expect(body.hooks.SessionStart).toHaveLength(2);
    const userEntry = (body.hooks.SessionStart as Array<{ hooks: Array<{ url: string }> }>).find(
      (e) => e.hooks[0]?.url === 'http://9.9.9.9:9999/wrong',
    );
    expect(userEntry).toBeDefined();
    // The ContextOS entry is the bridge-URL one.
    const ctxEntry = (body.hooks.SessionStart as Array<{ hooks: Array<{ url: string }> }>).find((e) =>
      e.hooks[0]?.url.includes('/v1/hooks/claude-code'),
    );
    expect(ctxEntry).toBeDefined();
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
