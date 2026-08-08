import { homedir } from 'node:os';
import { createCodexCliRunner, probeCodexPlugin } from '../../lib/agents/codex-plugin.js';
import type { Check } from '../types.js';

/**
 * Mirrors check 28 (`claude-hook-registration.ts`) for the Codex native
 * plugin: doctor check 14 (`mcp-config-validity.ts`) only ever reads
 * `probeCodexPlugin()`'s `.mcp` field, so a Codex install with MCP wired
 * but hooks/skills/manifest missing has never had its own doctor signal —
 * this check closes that gap the same way 28 does for Claude.
 *
 * Found investigating a live report (2026-08-08): a user's Codex Desktop
 * task produced zero `SessionStart`/`UserPromptSubmit`/`PreToolUse`/
 * `PostToolUse` rows in `run_events` even though `coodra plugin list`
 * showed `coodra@coodra` installed and enabled, and manual smokes against
 * the same MCP server worked fine. Root cause: Codex Desktop gates
 * plugin-bundled hooks behind a one-time interactive trust review (its own
 * docs — developers.openai.com/codex/hooks) that is invisible to
 * `codex plugin list --json` and to `~/.codex/config.toml` (confirmed live,
 * 2026-08-08: `[plugins."coodra@coodra"]` only ever carries `enabled`, no
 * hook-trust field exists anywhere in that file). `probeCodexPlugin`'s own
 * CLI fast-path — `isInstalled(codexBin)` true ⇒ manifest/marketplace/mcp/
 * hooks/skills all reported true — is accurate as far as it goes (the hook
 * DEFINITION really is registered), but "registered" and "trusted to
 * actually fire" are two different Codex-side facts, and only the first is
 * checkable from here. Rather than downgrade a real positive signal to a
 * false "missing" (Coodra has no better evidence either way), a green
 * result here says exactly what was verified and hands the user the one
 * manual step Coodra cannot perform or detect on its own.
 *
 * Read-only — `probeCodexPlugin` never writes to config.toml or the plugin
 * cache.
 */

const DOCTOR_CLI_PROBE_TIMEOUT_MS = 1200;

export const codexHookRegistrationCheck: Check = {
  id: 39,
  name: 'Codex native plugin (coodra@coodra) is installed with manifest, MCP, hooks, and skills wired',
  severity: 'yellow',
  async run(ctx) {
    const userHome = ctx.env.HOME || ctx.env.USERPROFILE || homedir();
    const probe = await probeCodexPlugin({ cwd: ctx.cwd, userHome }, createCodexCliRunner(DOCTOR_CLI_PROBE_TIMEOUT_MS));

    const missing: string[] = [];
    if (!probe.manifest) missing.push('plugin manifest');
    if (!probe.marketplace) missing.push('marketplace registration');
    if (!probe.mcp) missing.push('MCP wiring');
    if (!probe.hooks) missing.push('lifecycle hooks (SessionStart/PreToolUse/PostToolUse/Stop/SessionEnd)');
    if (!probe.skills) missing.push('bundled skills (coodra-context)');

    if (missing.length > 0) {
      return {
        status: 'yellow',
        detail: `native Codex plugin (coodra@coodra) is not fully wired at ${probe.paths.pluginRoot} — missing: ${missing.join(', ')}.`,
        remediation:
          'Run `coodra agent add codex` (or `coodra agent repair codex`) to (re)install the native Codex plugin.',
      };
    }
    return {
      status: 'green',
      detail:
        'native Codex plugin (coodra@coodra) is installed with manifest, MCP, hooks, and skills wired. ' +
        "This confirms the hook definitions are registered — it cannot confirm Codex Desktop's separate, " +
        'one-time hook-trust review has been completed, since Codex exposes no CLI/file signal for that. ' +
        'If hooks still do not fire (no SessionStart/PreToolUse/PostToolUse rows appear for new tasks), open ' +
        'Codex Desktop, run `/hooks`, and review/trust the Coodra hook definition, then start a fresh task.',
    };
  },
};
