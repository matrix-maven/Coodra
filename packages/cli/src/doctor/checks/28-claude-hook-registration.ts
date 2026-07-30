import { homedir } from 'node:os';
import { createClaudeCliRunner, probeClaudePlugin } from '../../lib/agents/claude-plugin.js';
import { defaultClaudeSettingsPath } from '../../lib/init/claude-settings-merge.js';
import type { Check } from '../types.js';

/**
 * Slice 5 (2026-05-03 audit §14.1) — originally verified `~/.claude/settings.json`'s
 * `hooks` key against the (now legacy) HTTP-bridge integration: Claude Code
 * POSTing SessionStart/PreToolUse/PostToolUse/Stop/SessionEnd to
 * `http://<bridgeHost>:<bridgePort>/v1/hooks/claude-code`.
 *
 * That model was replaced by the native Claude Code plugin (COOD-6/COOD-7):
 * `coodra agent add claude` no longer writes hook entries into
 * `settings.json`'s `hooks` key at all — it installs/enables a plugin
 * (`coodra@coodra`) whose own bundled `hooks/hooks.json` uses `mcp_tool`-type
 * entries calling `plugin:coodra:coodra` → `lifecycle_event` directly, not
 * an HTTP POST to the bridge. `settings.json` under the new model only
 * carries `enabledPlugins`/`extraKnownMarketplaces` — the hook definitions
 * themselves live in the plugin bundle, not in settings.json.
 *
 * Left unchanged, this check would parse a `hooks` key that `coodra agent
 * add claude` never writes anymore and report every native-plugin install as
 * "missing hook registrations" — a false negative doctor would emit forever
 * for the only install path Claude Code now uses. This rewrite delegates to
 * `probeClaudePlugin` (the same probe `coodra agent status` uses) instead of
 * re-parsing settings.json by hand, so the two surfaces can't drift again.
 *
 * `probeClaudePlugin` also shells out to `claude plugin list --json` when
 * the `claude` CLI is on PATH, to catch a plugin installed via the preferred
 * CLI path (which never touches Coodra's own cache mirror at all). That call
 * is given a short (1.2s) timeout here — well under doctor's default 2s
 * per-check budget — so a slow/hung CLI call fails fast and falls back to
 * the file-based checks below, instead of the whole check racing past
 * doctor's own timeout and reporting an uninformative "timeout" status.
 *
 * Read-only — `probeClaudePlugin` never writes to settings.json or the
 * plugin cache.
 */

const DOCTOR_CLI_PROBE_TIMEOUT_MS = 1200;

export const claudeHookRegistrationCheck: Check = {
  id: 28,
  name: 'Claude Code native plugin (coodra@coodra) is enabled with manifest, MCP, hooks, and skills wired',
  severity: 'yellow',
  async run(ctx) {
    // Honour CLAUDE_SETTINGS_PATH (F2) via the shared resolver — same path
    // init/agent-add write to. Home is left to homedir() (CheckContext has
    // no OS-home field; coodraHome is ~/.coodra, not the OS home).
    const settingsPath = defaultClaudeSettingsPath(undefined, ctx.env);
    const probe = await probeClaudePlugin(
      { cwd: ctx.cwd, userHome: homedir(), settingsPath },
      createClaudeCliRunner(DOCTOR_CLI_PROBE_TIMEOUT_MS),
    );

    const missing: string[] = [];
    if (!probe.enabled) missing.push('enabled in settings.json (enabledPlugins["coodra@coodra"])');
    if (!probe.marketplace) missing.push('marketplace registration (known_marketplaces.json)');
    if (!probe.manifest) missing.push('plugin manifest');
    if (!probe.mcp) missing.push('MCP wiring');
    if (!probe.hooks) missing.push('lifecycle hooks (SessionStart/PreToolUse/PostToolUse/Stop/SessionEnd)');
    if (!probe.skills) missing.push('bundled skills (coodra-context)');

    if (missing.length > 0) {
      return {
        status: 'yellow',
        detail: `native Claude Code plugin (coodra@coodra) is not fully wired at ${settingsPath} — missing: ${missing.join(', ')}.`,
        remediation: 'Run `coodra agent add claude` (or `coodra agent repair claude`) to (re)install the native Claude Code plugin.',
      };
    }
    return {
      status: 'green',
      detail: 'native Claude Code plugin (coodra@coodra) is enabled with manifest, MCP, hooks, and skills wired.',
    };
  },
};
