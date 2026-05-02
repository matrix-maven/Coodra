import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { WriteOutcome } from './types.js';

/**
 * `lib/init/claude-settings-merge.ts` — writes the four ContextOS
 * hook entries into `~/.claude/settings.json` so Claude Code POSTs
 * SessionStart, PreToolUse, PostToolUse, and Stop events to the
 * local hooks-bridge.
 *
 * Decision dec_83ba10c1 (2026-05-02). Pre-decision, init wrote
 * `.mcp.json` at the project root (the MCP server registration) but
 * never touched `settings.json` (the hooks registration). Result:
 * the bridge had nothing to ingest because Claude Code did not know
 * to call it. With this writer, init wires hooks AND mcp in one
 * invocation; the user restarts Claude Code once and gets autonomous
 * Feature Pack injection at SessionStart, real policy enforcement on
 * PreToolUse, audit on PostToolUse, and Context Pack auto-save on
 * Stop — all without touching any other config.
 *
 * Hook shape (per Claude Code's settings.json schema):
 *
 *   {
 *     "hooks": {
 *       "SessionStart": [
 *         {
 *           "matcher": "__contextos__",
 *           "hooks": [
 *             {
 *               "type": "http",
 *               "url": "http://127.0.0.1:<bridge-port>/v1/hooks/claude-code",
 *               "headers": { "X-Local-Hook-Secret": "$LOCAL_HOOK_SECRET" },
 *               "allowedEnvVars": ["LOCAL_HOOK_SECRET"],
 *               "timeout": 10
 *             }
 *           ]
 *         }
 *       ],
 *       "PreToolUse": [...same shape...],
 *       "PostToolUse": [...],
 *       "Stop": [...]
 *     }
 *   }
 *
 * Idempotency: every ContextOS entry uses the matcher
 * `__contextos__`. The merger finds entries whose matcher matches
 * that sentinel and replaces them, leaving every other user-authored
 * entry untouched. Re-running `contextos init` is a true no-op when
 * the existing entries already match the baseline.
 *
 * Backup: on the FIRST write to a non-empty existing file we copy
 * the original to `<settings.json>.contextos-backup-<timestamp>` so
 * the user can recover if something goes wrong.
 */

const CONTEXTOS_MATCHER = '__contextos__' as const;
const CLAUDE_HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'] as const;
type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

export interface ClaudeSettingsMergeOptions {
  /** Override `~/.claude/settings.json` location for tests. */
  readonly settingsPath?: string;
  /** Hooks-bridge port. Default 3101 per system-architecture §3.5. */
  readonly bridgePort: number;
  /** Bridge bind host. Default `127.0.0.1`. */
  readonly bridgeHost?: string;
  /** Per-request timeout in seconds. Default 10. */
  readonly timeoutSec?: number;
  /** Pass `--force` through from init: overwrites any drift even when no contextos-matcher entry exists. */
  readonly force: boolean;
  /** When true, compute the merge but do not write to disk. */
  readonly dryRun: boolean;
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

export function defaultClaudeSettingsPath(home: string = homedir()): string {
  return join(home, '.claude', 'settings.json');
}

export function buildContextosHookSpec(options: ClaudeSettingsMergeOptions): ClaudeHttpHookSpec {
  const host = options.bridgeHost ?? '127.0.0.1';
  return {
    type: 'http',
    url: `http://${host}:${options.bridgePort}/v1/hooks/claude-code`,
    headers: { 'X-Local-Hook-Secret': '$LOCAL_HOOK_SECRET' },
    allowedEnvVars: ['LOCAL_HOOK_SECRET'],
    timeout: options.timeoutSec ?? 10,
  };
}

export function buildContextosEntry(spec: ClaudeHttpHookSpec): ClaudeHookEntry {
  return { matcher: CONTEXTOS_MATCHER, hooks: [spec] };
}

/**
 * Returns true when `entry`'s matcher is the ContextOS sentinel AND
 * the entry's first hook is byte-equal to `desired`. False matches
 * trigger a replace; true matches stay untouched (no-op).
 */
function entryMatchesBaseline(entry: ClaudeHookEntry, desired: ClaudeHttpHookSpec): boolean {
  if (entry.matcher !== CONTEXTOS_MATCHER) return false;
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
 * Replace any ContextOS-owned entry in `existing` with `desired`.
 * Append `desired` if no contextos-owned entry was found.
 *
 * Returns `{ entries, changed }` — `changed` is true when the result
 * differs from `existing` under canonical-JSON comparison. Tests use
 * the `changed` flag to assert idempotence.
 */
function mergeEventEntries(
  existing: ClaudeHookEntry[] | undefined,
  desiredSpec: ClaudeHttpHookSpec,
): { entries: ClaudeHookEntry[]; changed: boolean } {
  const desired = buildContextosEntry(desiredSpec);
  const entries: ClaudeHookEntry[] = Array.isArray(existing) ? existing.slice() : [];
  const idx = entries.findIndex((e) => e?.matcher === CONTEXTOS_MATCHER);
  if (idx === -1) {
    entries.push(desired);
    return { entries, changed: true };
  }
  const before = entries[idx] ?? desired;
  if (entryMatchesBaseline(before, desiredSpec)) {
    return { entries, changed: false };
  }
  entries[idx] = desired;
  return { entries, changed: true };
}

export interface MergeClaudeSettingsResult {
  /** Resolved `~/.claude/settings.json` path. */
  readonly path: string;
  /** Outcome describing what changed (or didn't). */
  readonly outcome: WriteOutcome;
}

/**
 * Idempotent merge of ContextOS's four hook entries into
 * `~/.claude/settings.json`. Creates the parent directory + file if
 * absent. Backs up the original on first divergent write.
 */
export async function mergeClaudeSettings(options: ClaudeSettingsMergeOptions): Promise<MergeClaudeSettingsResult> {
  const path = options.settingsPath ?? defaultClaudeSettingsPath();
  const desiredSpec = buildContextosHookSpec(options);

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
    const merged = mergeEventEntries(hooksBlock[eventName] as ClaudeHookEntry[] | undefined, desiredSpec);
    updates[eventName] = merged.entries;
    if (merged.changed) anyChanged = true;
  }

  if (!anyChanged && !options.force) {
    return {
      path,
      outcome: { path, action: 'unchanged', notes: 'all four ContextOS hook entries already match baseline' },
    };
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
  // launches yet, ContextOS shipped without any hooks wired. The
  // 0700 mode matches what other ContextOS dirs use (see init.ts
  // logs/pids creation) — restrictive on multi-user systems so a
  // less-trusted account can't read another user's local hook
  // secrets.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  // Backup the original on the first divergent write so the user
  // can recover.
  if (raw !== null) {
    const backupPath = `${path}.contextos-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      await writeFile(backupPath, raw, 'utf8');
    } catch {
      // Backup is best-effort; failures must not block the install.
    }
  }

  // Atomic write: temp + rename.
  const tmpPath = `${path}.contextos.tmp`;
  await writeFile(tmpPath, nextRaw, 'utf8');
  await rename(tmpPath, path);

  return {
    path,
    outcome: {
      path,
      action: raw === null ? 'wrote' : options.force ? 'forced' : 'merged',
      notes:
        raw === null
          ? 'created baseline ~/.claude/settings.json with ContextOS hook entries'
          : options.force
            ? 'overwrote ContextOS hook entries with baseline'
            : 'updated ContextOS hook entries (existing user hooks preserved)',
    },
  };
}
