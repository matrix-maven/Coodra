import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { WriteOutcome } from './types.js';

/**
 * `lib/init/claude-settings-merge.ts` — writes the Coodra hook
 * entries into `~/.claude/settings.json` so Claude Code POSTs
 * SessionStart, PreToolUse, PostToolUse, Stop, and SessionEnd events
 * to the local hooks-bridge.
 *
 * History:
 *
 * - **dec_83ba10c1 (2026-05-02 — Phase 3)**: introduced the merger.
 *   Pre-decision, init wrote `.mcp.json` (the MCP server registration)
 *   but never touched `settings.json` (the hooks registration), so the
 *   bridge had nothing to ingest. With this writer, init wires hooks
 *   AND mcp in one invocation; the user restarts Claude Code once and
 *   gets autonomous Feature Pack injection at SessionStart, real
 *   policy enforcement on PreToolUse, audit on PostToolUse, and
 *   Context Pack auto-save on Stop.
 *
 * - **Phase 4 Fix F (2026-05-02 — caught during demo rehearsal)**:
 *   Phase 3 wrote `matcher: '__coodra__'` for every event entry.
 *   Per Claude Code's hook spec, `matcher` on PreToolUse/PostToolUse
 *   is a regex tested against the TOOL NAME — `'__coodra__'`
 *   doesn't match any real tool, so the hook would never fire for
 *   Claude Code (it kept firing for Cursor / Windsurf because their
 *   adapters POST directly without going through the matcher). Two
 *   things change in Fix F:
 *
 *     1. Per-event matchers. PreToolUse / PostToolUse get the regex
 *        `Write|Edit|MultiEdit|NotebookEdit|Bash` so every tool the
 *        default policy governs reaches the bridge. SessionStart /
 *        Stop omit `matcher` entirely (Claude Code defaults to
 *        "fire for all" — and matcher is documented for tool events
 *        only).
 *
 *     2. URL-based ownership detection. Pre-Fix-F the merger
 *        identified Coodra-owned entries by `matcher === '__coodra__'`.
 *        With per-event matchers carrying real tool-name regexes, that
 *        sentinel is gone. Instead, an entry is "Coodra-owned" iff
 *        any hook in `entry.hooks[]` has a URL starting with the
 *        configured bridge endpoint. Robust against future matcher
 *        changes; user entries (which never POST to our bridge URL)
 *        stay preserved.
 *
 *     3. Legacy migration. An existing entry with `matcher === '__coodra__'`
 *        AND a hook URL matching the bridge is recognised as a
 *        pre-Fix-F Coodra entry and replaced with the new shape on
 *        next merge. The original is backed up first.
 *
 * Hook shape after Fix F + Fix G:
 *
 *   {
 *     "hooks": {
 *       "SessionStart": [{
 *         "hooks": [{ "type": "http", "url": "...", "headers": {...}, ... }]
 *       }],
 *       "PreToolUse": [{
 *         "matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash",
 *         "hooks": [{ "type": "http", "url": "...", "headers": {...}, ... }]
 *       }],
 *       "PostToolUse": [{
 *         "matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash",
 *         "hooks": [{ "type": "http", "url": "...", "headers": {...}, ... }]
 *       }],
 *       "Stop": [{
 *         "hooks": [{ "type": "http", "url": "...", "headers": {...}, ... }]
 *       }],
 *       "SessionEnd": [{
 *         "hooks": [{ "type": "http", "url": "...", "headers": {...}, ... }]
 *       }]
 *     }
 *   }
 *
 * Backup: on the FIRST write to a non-empty existing file we copy
 * the original to `<settings.json>.coodra-backup-<timestamp>` so
 * the user can recover if something goes wrong.
 */

/**
 * Phase 4 Fix F matcher for tool events. Covers every tool the
 * default policy from `@coodra/db::ensureDefaultPolicy` governs:
 * Write/Edit/MultiEdit/NotebookEdit (deny dangerous paths) + Bash
 * (ask). When new tool names need governance, expand this regex AND
 * the rule list in `ensure-default-policy.ts` together.
 */
const TOOL_EVENT_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash' as const;

/**
 * Pre-Fix-F sentinel matcher value. Used only for legacy detection
 * during merge — new writes never use it. Keep this constant for the
 * lifetime of one or two minor releases so users upgrading from
 * pre-Fix-F installs get their entries migrated automatically.
 */
const LEGACY_COODRA_MATCHER = '__coodra__' as const;

/**
 * Phase 4 Fix G (Slice 2 — 2026-05-03 audit): SessionEnd added to the hook
 * registration list. Pre-Fix-G init wrote 4 entries (SessionStart, PreToolUse,
 * PostToolUse, Stop). The bridge dispatcher correctly routes `'session_end'`
 * → status flip + auto-Context-Pack save (per `apps/hooks-bridge/src/lib/dispatch.ts`),
 * but `~/.claude/settings.json` had no SessionEnd entry, so Claude Code
 * never POSTed SessionEnd events for real sessions. Result: real `runs`
 * rows accumulated as `status='in_progress'` indefinitely; auto-Context-Pack
 * saves never fired for real sessions. Adding SessionEnd here closes that
 * gap with no other code changes — the bridge already handles the event.
 *
 * SessionEnd is NOT a tool event (Claude Code's hook spec documents the
 * `matcher` regex as applying only to PreToolUse / PostToolUse). It stays
 * out of `TOOL_EVENTS` below — the writer omits `matcher` for non-tool
 * events the same way it does for SessionStart and Stop.
 */
const CLAUDE_HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'] as const;
type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

const TOOL_EVENTS: ReadonlySet<ClaudeHookEvent> = new Set(['PreToolUse', 'PostToolUse']);

export interface ClaudeSettingsMergeOptions {
  /** Override `~/.claude/settings.json` location for tests. */
  readonly settingsPath?: string;
  /** Hooks-bridge port. Default 3101 per system-architecture §3.5. */
  readonly bridgePort: number;
  /** Bridge bind host. Default `127.0.0.1`. */
  readonly bridgeHost?: string;
  /** Per-request timeout in seconds. Default 10. */
  readonly timeoutSec?: number;
  /** Pass `--force` through from init: overwrites any drift even when no coodra-owned entry exists. */
  readonly force: boolean;
  /** When true, compute the merge but do not write to disk. */
  readonly dryRun: boolean;
  /**
   * Phase F.6+ (2026-05-12) — literal LOCAL_HOOK_SECRET to inline into
   * the `X-Local-Hook-Secret` header. Pre-Phase-F.6+ init wrote
   * `"$LOCAL_HOOK_SECRET"` and relied on Claude Code substituting the
   * value from its process env at hook-fire time. That mechanism only
   * works if the user has the var exported in their shell — which
   * shells don't auto-load from .env files. The default user flow
   * (`cd ~/proj && claude`) leaves the var unset → header sends empty
   * string → bridge 401s on every hook event.
   *
   * Solution: bake the literal secret into settings.json so the
   * dependency on shell env disappears. Tradeoff: secret lives in
   * ~/.claude/settings.json (already a sensitive file) instead of
   * being deferred to env. Net: same risk surface, working flow.
   *
   * When omitted, the legacy `$LOCAL_HOOK_SECRET` template is written
   * (back-compat for callers that haven't been updated).
   */
  readonly localHookSecret?: string;
}

interface ClaudeHttpHookSpec {
  readonly type: 'http';
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly allowedEnvVars: string[];
  readonly timeout: number;
}

interface ClaudeHookEntry {
  readonly matcher?: string;
  readonly hooks: ClaudeHttpHookSpec[];
}

interface ClaudeSettings {
  hooks?: Partial<Record<ClaudeHookEvent, ClaudeHookEntry[]>> & Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Resolves the path to Claude Code's settings file.
 *
 * Override precedence:
 *   1. `CLAUDE_SETTINGS_PATH` env var (added M08b S8.5, 2026-05-03 —
 *      gives sandbox-runners and CI scripts a way to redirect the
 *      uninstall + init writes away from the operator's real
 *      `~/.claude/settings.json`).
 *   2. `<home>/.claude/settings.json` per Claude Code's documented
 *      default.
 *
 * The `home` parameter overrides `os.homedir()` for tests; production
 * callers omit it.
 */
export function defaultClaudeSettingsPath(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_SETTINGS_PATH;
  if (typeof override === 'string' && override.length > 0) {
    return override;
  }
  return join(home, '.claude', 'settings.json');
}

export function buildCoodraHookSpec(options: ClaudeSettingsMergeOptions): ClaudeHttpHookSpec {
  const host = options.bridgeHost ?? '127.0.0.1';
  // Phase F.6+ — prefer literal secret over $LOCAL_HOOK_SECRET env
  // template. See ClaudeSettingsMergeOptions.localHookSecret docblock
  // for why.
  const secretValue =
    typeof options.localHookSecret === 'string' && options.localHookSecret.length > 0
      ? options.localHookSecret
      : '$LOCAL_HOOK_SECRET';
  return {
    type: 'http',
    url: `http://${host}:${options.bridgePort}/v1/hooks/claude-code`,
    headers: { 'X-Local-Hook-Secret': secretValue },
    allowedEnvVars: ['LOCAL_HOOK_SECRET'],
    timeout: options.timeoutSec ?? 10,
  };
}

/**
 * Build the desired entry for one event. Tool events get the Phase-4-Fix-F
 * tool-name regex; non-tool events omit `matcher` entirely (Claude Code
 * defaults to "fire for all" when matcher is absent, and matcher is only
 * documented for PreToolUse/PostToolUse anyway).
 */
export function buildCoodraEntryForEvent(eventName: ClaudeHookEvent, spec: ClaudeHttpHookSpec): ClaudeHookEntry {
  if (TOOL_EVENTS.has(eventName)) {
    return { matcher: TOOL_EVENT_MATCHER, hooks: [spec] };
  }
  return { hooks: [spec] };
}

/**
 * Backwards-compat alias. The Phase 3 surface used this to build a
 * single entry shape for all events; Fix F replaces it with the
 * per-event factory above. Kept for any external import that might
 * reference it.
 *
 * @deprecated Use `buildCoodraEntryForEvent` so the matcher matches
 *             the per-event Claude Code spec.
 */
export function buildCoodraEntry(spec: ClaudeHttpHookSpec): ClaudeHookEntry {
  return { matcher: TOOL_EVENT_MATCHER, hooks: [spec] };
}

/**
 * URL-based ownership detection (Phase 4 Fix F). An entry is
 * "Coodra-owned" iff any of its hooks has a URL pointing at the
 * configured bridge endpoint. Replaces the pre-Fix-F matcher-sentinel
 * check.
 *
 * The match is a path-prefix on the URL (host+port+`/v1/hooks/claude-code`)
 * so any hook spec we ever shipped — pre-Fix-F or post-Fix-F, with
 * or without query strings, with or without trailing path segments —
 * is recognised.
 */
function isCoodraOwnedEntry(entry: ClaudeHookEntry, bridgeUrlPrefix: string): boolean {
  if (!Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(
    (h) => h && typeof h === 'object' && typeof h.url === 'string' && h.url.startsWith(bridgeUrlPrefix),
  );
}

/**
 * Returns true when `entry` exactly matches the desired Fix-F shape
 * for this event — meaning: matcher value is correct (regex for tool
 * events, absent for non-tool events) AND the single hook spec is
 * byte-equal to `desired`.
 */
function entryMatchesBaseline(
  entry: ClaudeHookEntry,
  eventName: ClaudeHookEvent,
  desired: ClaudeHttpHookSpec,
): boolean {
  if (TOOL_EVENTS.has(eventName)) {
    if (entry.matcher !== TOOL_EVENT_MATCHER) return false;
  } else {
    // For non-tool events the desired entry has no matcher field. An
    // existing entry with any matcher (including the legacy sentinel)
    // does not match baseline — re-write it.
    if (entry.matcher !== undefined) return false;
  }
  if (!Array.isArray(entry.hooks) || entry.hooks.length !== 1) return false;
  const got = entry.hooks[0];
  if (got === undefined) return false;
  return JSON.stringify(canonicalize(got)) === JSON.stringify(canonicalize(desired));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Merge per-event: replace any Coodra-owned entries (URL match)
 * with `desired`; append `desired` if no coodra-owned entry was
 * found. Preserves user entries (which never carry the bridge URL).
 *
 * Returns `{ entries, changed }` — `changed` is true when the result
 * differs from `existing` under canonical-JSON comparison.
 */
function mergeEventEntries(
  eventName: ClaudeHookEvent,
  existing: ClaudeHookEntry[] | undefined,
  desiredSpec: ClaudeHttpHookSpec,
  bridgeUrlPrefix: string,
): { entries: ClaudeHookEntry[]; changed: boolean } {
  const desired = buildCoodraEntryForEvent(eventName, desiredSpec);
  const existingArr: ClaudeHookEntry[] = Array.isArray(existing) ? existing.slice() : [];

  // Locate every coodra-owned entry (URL match) — there should
  // normally be exactly one, but legacy installs and force-write
  // accidents can leave duplicates. Drop them all and re-insert one.
  const ownedIndices: number[] = [];
  for (let i = 0; i < existingArr.length; i++) {
    const e = existingArr[i];
    if (e !== undefined && isCoodraOwnedEntry(e, bridgeUrlPrefix)) ownedIndices.push(i);
  }

  if (ownedIndices.length === 0) {
    return { entries: [...existingArr, desired], changed: true };
  }

  // Single owned entry already present and matches baseline → no-op.
  if (ownedIndices.length === 1) {
    const idx0 = ownedIndices[0];
    if (idx0 !== undefined) {
      const before = existingArr[idx0];
      if (before !== undefined && entryMatchesBaseline(before, eventName, desiredSpec)) {
        return { entries: existingArr, changed: false };
      }
    }
  }

  // Either there are duplicates OR the single owned entry diverges from
  // baseline. Strip every owned entry, append the canonical one.
  const ownedSet = new Set(ownedIndices);
  const next: ClaudeHookEntry[] = [];
  for (let i = 0; i < existingArr.length; i++) {
    if (!ownedSet.has(i)) {
      const item = existingArr[i];
      if (item !== undefined) next.push(item);
    }
  }
  next.push(desired);
  return { entries: next, changed: true };
}

export interface MergeClaudeSettingsResult {
  /** Resolved `~/.claude/settings.json` path. */
  readonly path: string;
  /** Outcome describing what changed (or didn't). */
  readonly outcome: WriteOutcome;
}

/**
 * Idempotent merge of Coodra's hook entries into
 * `~/.claude/settings.json`. Creates the parent directory + file if
 * absent. Backs up the original on first divergent write.
 */
export async function mergeClaudeSettings(options: ClaudeSettingsMergeOptions): Promise<MergeClaudeSettingsResult> {
  const path = options.settingsPath ?? defaultClaudeSettingsPath();
  const desiredSpec = buildCoodraHookSpec(options);
  const host = options.bridgeHost ?? '127.0.0.1';
  const bridgeUrlPrefix = `http://${host}:${options.bridgePort}/v1/hooks/claude-code`;

  let raw: string | null = null;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw err;
    }
  }

  let settings: ClaudeSettings = {};
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error(`${path} is not a JSON object`);
      }
      settings = parsed as ClaudeSettings;
    } catch (err) {
      throw new Error(`Cannot parse ${path}: ${(err as Error).message}`);
    }
  }

  const hooksBlock: NonNullable<ClaudeSettings['hooks']> = (settings.hooks as ClaudeSettings['hooks']) ?? {};
  let anyChanged = false;
  const updates: Partial<Record<ClaudeHookEvent, ClaudeHookEntry[]>> = {};
  for (const eventName of CLAUDE_HOOK_EVENTS) {
    const merged = mergeEventEntries(
      eventName,
      hooksBlock[eventName] as ClaudeHookEntry[] | undefined,
      desiredSpec,
      bridgeUrlPrefix,
    );
    updates[eventName] = merged.entries;
    if (merged.changed) anyChanged = true;
  }

  if (!anyChanged && !options.force) {
    return {
      path,
      outcome: { path, action: 'unchanged', notes: 'all Coodra hook entries already match Phase 4 Fix F baseline' },
    };
  }

  // When --force is set on an already-current install, regenerate
  // every entry to canonical baseline (drops any duplicate owned
  // entries, restores matchers if locally edited).
  if (!anyChanged && options.force) {
    for (const eventName of CLAUDE_HOOK_EVENTS) {
      const desired = buildCoodraEntryForEvent(eventName, desiredSpec);
      updates[eventName] = [
        ...((hooksBlock[eventName] as ClaudeHookEntry[] | undefined) ?? []).filter(
          (e) => !isCoodraOwnedEntry(e, bridgeUrlPrefix),
        ),
        desired,
      ];
    }
  }

  const next: ClaudeSettings = {
    ...settings,
    hooks: { ...hooksBlock, ...updates },
  };
  const nextRaw = `${JSON.stringify(next, null, 2)}\n`;

  if (options.dryRun) {
    return {
      path,
      outcome: {
        path,
        action: anyChanged ? (raw === null ? 'wrote' : 'merged') : 'forced',
        notes: 'dry-run: no write performed',
      },
    };
  }

  // Phase 3 Fix B (2026-05-02): create `~/.claude/` with mode 0700
  // if it doesn't exist. Pre-Phase-3 init gated the entire merge on
  // the dir's prior existence; on a fresh machine with no Claude Code
  // launches yet, Coodra shipped without any hooks wired. The
  // 0700 mode matches what other Coodra dirs use (see init.ts
  // logs/pids creation) — restrictive on multi-user systems so a
  // less-trusted account can't read another user's local hook
  // secrets.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  // Backup the original on the first divergent write so the user
  // can recover.
  if (raw !== null) {
    const backupPath = `${path}.coodra-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      await writeFile(backupPath, raw, 'utf8');
    } catch {
      // Backup is best-effort; failures must not block the install.
    }
  }

  // Atomic write: temp + rename.
  const tmpPath = `${path}.coodra.tmp`;
  await writeFile(tmpPath, nextRaw, 'utf8');
  await rename(tmpPath, path);

  return {
    path,
    outcome: {
      path,
      action: raw === null ? 'wrote' : options.force ? 'forced' : 'merged',
      notes:
        raw === null
          ? 'created baseline ~/.claude/settings.json with Coodra hook entries (Phase 4 Fix F matcher)'
          : options.force
            ? 'overwrote Coodra hook entries with Phase 4 Fix F baseline'
            : 'updated Coodra hook entries (existing user hooks preserved; legacy __coodra__ matcher migrated)',
    },
  };
}

// Internal exports for tests.
export { LEGACY_COODRA_MATCHER, TOOL_EVENT_MATCHER };

/**
 * Module 08b S8 — `coodra uninstall` reverse for `~/.claude/settings.json`.
 *
 * Removes every Coodra-owned hook entry (URL-prefix detection per
 * Phase 4 Fix F) AND every legacy `matcher === '__coodra__'`
 * sentinel entry. User entries (which never carry the bridge URL)
 * stay untouched. Idempotent: re-running on a file with no owned
 * entries is a no-op.
 *
 * The `hooks` block keeps its overall shape — only the coodra
 * entries inside per-event arrays are stripped. Empty per-event
 * arrays are removed so the file shrinks rather than carrying empty
 * scaffolding.
 */
export interface RemoveClaudeSettingsOptions {
  readonly settingsPath?: string;
  readonly bridgePort: number;
  readonly bridgeHost?: string;
  readonly dryRun: boolean;
}

export async function removeClaudeSettings(options: RemoveClaudeSettingsOptions): Promise<MergeClaudeSettingsResult> {
  const path = options.settingsPath ?? defaultClaudeSettingsPath();
  const host = options.bridgeHost ?? '127.0.0.1';
  const bridgeUrlPrefix = `http://${host}:${options.bridgePort}/v1/hooks/claude-code`;

  let raw: string | null = null;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        path,
        outcome: { path, action: 'unchanged', notes: 'no ~/.claude/settings.json exists; nothing to remove' },
      };
    }
    throw err;
  }

  let settings: ClaudeSettings;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`${path} is not a JSON object`);
    }
    settings = parsed as ClaudeSettings;
  } catch (err) {
    throw new Error(`Cannot parse ${path}: ${(err as Error).message}`);
  }

  const hooksBlock: NonNullable<ClaudeSettings['hooks']> = (settings.hooks as ClaudeSettings['hooks']) ?? {};
  let anyChanged = false;
  const updates: Record<string, ClaudeHookEntry[]> = {};
  for (const [eventName, entries] of Object.entries(hooksBlock)) {
    if (!Array.isArray(entries)) {
      // Preserve unknown shape verbatim.
      updates[eventName] = entries as ClaudeHookEntry[];
      continue;
    }
    const filtered = entries.filter((e) => {
      if (e === undefined || e === null || typeof e !== 'object') return true;
      // Drop both: URL-prefix-owned (post-Fix-F) AND legacy sentinel-matcher entries.
      if (isCoodraOwnedEntry(e, bridgeUrlPrefix)) return false;
      if (e.matcher === LEGACY_COODRA_MATCHER) return false;
      return true;
    });
    if (filtered.length !== entries.length) anyChanged = true;
    if (filtered.length > 0) {
      updates[eventName] = filtered;
    }
    // If filtered is empty, omit the per-event key entirely so the file shrinks.
  }

  if (!anyChanged) {
    return {
      path,
      outcome: { path, action: 'unchanged', notes: 'no coodra-owned hook entries found; nothing to remove' },
    };
  }

  const next: ClaudeSettings = { ...settings, hooks: updates };
  const nextRaw = `${JSON.stringify(next, null, 2)}\n`;

  if (options.dryRun) {
    return {
      path,
      outcome: { path, action: 'merged', notes: 'dry-run: coodra hook entries would be removed' },
    };
  }

  // Backup the original on the first divergent write.
  const backupPath = `${path}.coodra-uninstall-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    await writeFile(backupPath, raw, 'utf8');
  } catch {
    // best-effort
  }

  const tmpPath = `${path}.coodra.tmp`;
  await writeFile(tmpPath, nextRaw, 'utf8');
  await rename(tmpPath, path);

  return {
    path,
    outcome: { path, action: 'merged', notes: 'removed coodra hook entries' },
  };
}
