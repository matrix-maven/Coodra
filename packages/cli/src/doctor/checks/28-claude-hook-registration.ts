import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Check } from '../types.js';

/**
 * Slice 5 (2026-05-03 audit §14.1) — settings.json hook registration
 * completeness. Pre-Slice-5 doctor checked port health (17/18) and
 * /healthz reachability (10/11) but had NO check that the user's
 * `~/.claude/settings.json` actually had the right hook entries pointing
 * at the bridge. The Phase 4 Fix F matcher bug + the Phase 4 Fix G
 * SessionEnd-missing bug both lived in production for weeks because
 * doctor never inspected the file that decides whether Claude Code
 * calls the bridge at all.
 *
 * This check reads `~/.claude/settings.json` and asserts:
 *   1. The file exists.
 *   2. All five required hook events are registered (post-Fix-G):
 *      SessionStart, PreToolUse, PostToolUse, Stop, SessionEnd.
 *   3. Each registration has a hook URL pointing at the configured
 *      bridge endpoint (`http://<bridgeHost>:<bridgePort>/v1/hooks/claude-code`).
 *   4. PreToolUse and PostToolUse have a tool-name regex matcher
 *      covering the file-mutating tool set
 *      (Write|Edit|MultiEdit|NotebookEdit|Bash). The literal sentinel
 *      `__contextos__` is flagged as legacy pre-Fix-F drift — the
 *      remediation tells the user to re-run init.
 *   5. SessionStart/Stop/SessionEnd have NO matcher (per Claude Code's
 *      hook spec: matcher only applies to tool events).
 *
 * Read-only — never writes to settings.json. Failures emit a yellow
 * status with a remediation that names the exact init re-run.
 */

const hookSpecSchema = z
  .object({
    type: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

const hookEntrySchema = z
  .object({
    matcher: z.string().optional(),
    hooks: z.array(hookSpecSchema).optional(),
  })
  .passthrough();

const settingsSchema = z
  .object({
    hooks: z.record(z.string(), z.array(hookEntrySchema)).optional(),
  })
  .passthrough();

const REQUIRED_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'] as const;
const TOOL_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PostToolUse']);
const EXPECTED_TOOL_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash';
const LEGACY_SENTINEL = '__contextos__';

export const claudeHookRegistrationCheck: Check = {
  id: 28,
  name: '~/.claude/settings.json registers all 5 ContextOS hook events with correct matchers',
  severity: 'yellow',
  async run(ctx) {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    let raw: string;
    try {
      raw = await readFile(settingsPath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          status: 'yellow',
          detail: `~/.claude/settings.json not found — Claude Code is not configured to call the ContextOS bridge.`,
          remediation: 'Run `contextos init` to write the hook registration.',
        };
      }
      return {
        status: 'yellow',
        detail: `cannot read ~/.claude/settings.json: ${(err as Error).message}`,
      };
    }

    let parsed: z.infer<typeof settingsSchema>;
    try {
      parsed = settingsSchema.parse(JSON.parse(raw));
    } catch (err) {
      return {
        status: 'yellow',
        detail: `~/.claude/settings.json invalid JSON or shape: ${(err as Error).message}`,
        remediation: 'Re-run `contextos init` to rewrite the hook registration.',
      };
    }

    const hooks = parsed.hooks ?? {};
    const expectedUrl = `http://${ctx.env.LOCAL_HOOK_HOST ?? '127.0.0.1'}:${ctx.bridgePort}/v1/hooks/claude-code`;
    const missing: string[] = [];
    const driftedMatchers: string[] = [];
    const legacySentinels: string[] = [];

    for (const eventName of REQUIRED_EVENTS) {
      const entries = hooks[eventName];
      if (!Array.isArray(entries) || entries.length === 0) {
        missing.push(eventName);
        continue;
      }
      const ours = entries.find((e) =>
        (e.hooks ?? []).some((h) => typeof h.url === 'string' && h.url.startsWith(expectedUrl)),
      );
      if (ours === undefined) {
        missing.push(`${eventName}(no-bridge-url)`);
        continue;
      }
      // Matcher contract:
      //   - tool events MUST equal EXPECTED_TOOL_MATCHER (Phase 4 Fix F)
      //   - non-tool events MUST omit matcher entirely
      //   - the legacy `__contextos__` sentinel is pre-Fix-F drift
      if (TOOL_EVENTS.has(eventName)) {
        if (ours.matcher === LEGACY_SENTINEL) {
          legacySentinels.push(eventName);
        } else if (ours.matcher !== EXPECTED_TOOL_MATCHER) {
          driftedMatchers.push(`${eventName}=${ours.matcher ?? '(omitted)'}`);
        }
      } else {
        if (ours.matcher !== undefined) {
          driftedMatchers.push(`${eventName}=${ours.matcher} (should be omitted)`);
        }
      }
    }

    if (legacySentinels.length > 0) {
      return {
        status: 'yellow',
        detail: `pre-Fix-F legacy matcher (\`__contextos__\`) present on: ${legacySentinels.join(', ')}. Claude Code's hook matcher is a regex over tool names; the literal sentinel never matches any real tool, so PreToolUse / PostToolUse hooks are functionally inert.`,
        remediation:
          'Re-run `contextos init` to migrate the entry to the post-Fix-F per-event matcher (`Write|Edit|MultiEdit|NotebookEdit|Bash`).',
      };
    }
    if (missing.length > 0) {
      return {
        status: 'yellow',
        detail: `missing hook registrations: ${missing.join(', ')}. Claude Code will not POST these events to the bridge.`,
        remediation: 'Re-run `contextos init` to add the missing hook entries.',
      };
    }
    if (driftedMatchers.length > 0) {
      return {
        status: 'yellow',
        detail: `unexpected matcher shape: ${driftedMatchers.join(', ')}.`,
        remediation: 'Re-run `contextos init` to rewrite the hook entries with the canonical matcher set.',
      };
    }
    return {
      status: 'green',
      detail: `all 5 hook events registered with bridge URL ${expectedUrl} and the canonical Phase-4 matcher set.`,
    };
  },
};
