import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import {
  CODEX_MARKETPLACE_NAME,
  CODEX_PLUGIN_NAME,
  createCodexCliRunner,
  LEGACY_CODEX_PERSONAL_PLUGIN_KEY,
  probeCodexPlugin,
} from '../../lib/agents/codex-plugin.js';
import type { Check } from '../types.js';

/**
 * Mirrors check 28 (claude-hook-registration.ts) for the Codex native
 * plugin: doctor check 14 (mcp-config-validity.ts) only ever reads
 * probeCodexPlugin()'s `.mcp` field, so a Codex install with MCP wired but
 * hooks/skills/manifest missing has never had its own doctor signal — this
 * check closes that gap the same way 28 does for Claude.
 *
 * Found investigating a live report (2026-08-08): a user's Codex Desktop
 * task produced zero SessionStart/UserPromptSubmit/PreToolUse/PostToolUse
 * rows in run_events even though `coodra plugin list` showed coodra@coodra
 * installed and enabled, and manual smokes against the same MCP server
 * worked fine. Two independently confirmed root causes, in order of what
 * actually blocks hook execution:
 *
 * 1. Codex's matcher regex engine rejects look-around ("look-around,
 *    including look-ahead and look-behind, is not supported"), confirmed
 *    via a live `codex exec --dangerously-bypass-hook-trust` smoke. The
 *    original TOOL_MATCHER (copied from Claude's, whose engine DOES
 *    support look-around) used a negative lookahead to exclude Coodra's
 *    own two managed MCP servers, which made Codex reject the whole
 *    hooks.json at load — PreToolUse/PostToolUse/PermissionRequest never
 *    registered at all, silently, for every install made before this fix.
 *    installCodexPlugin now writes a look-around-free matcher (see
 *    codex-plugin.ts's TOOL_MATCHER docblock) and filters Coodra's own
 *    tool calls server-side instead — but a plugin installed before this
 *    fix has the broken matcher baked into Codex's OWN cache
 *    (~/.codex/plugins/cache/coodra/coodra/<version>/hooks/hooks.json, a
 *    version-pinned copy Codex itself owns) until reinstalled. This check
 *    scans that live cache directly — not just Coodra's own generated
 *    source, which will always look correct post-fix regardless of what
 *    Codex actually has cached.
 * 2. Separately, Codex Desktop gates plugin-bundled hooks behind a
 *    one-time interactive trust review (its own docs —
 *    developers.openai.com/codex/hooks) that is invisible to `codex
 *    plugin list --json` and to ~/.codex/config.toml (confirmed live,
 *    2026-08-08: the plugin's config.toml entry only ever carries
 *    `enabled`, no hook-trust field exists anywhere in that file). This is
 *    the part genuinely unverifiable from here — see the green-path
 *    caveat below.
 *
 * probeCodexPlugin's own CLI fast-path — isInstalled(codexBin) true means
 * manifest/marketplace/mcp/hooks/skills are all reported true — is
 * accurate as far as it goes (the hook DEFINITION really is registered),
 * but "registered" and "trusted to actually fire" are two different
 * Codex-side facts, and only the first is checkable from here. Rather than
 * downgrade a real positive signal to a false "missing" (Coodra has no
 * better evidence either way), a green result says exactly what was
 * verified and hands the user the one manual step Coodra cannot perform
 * or detect.
 *
 * Read-only — never writes to config.toml or the plugin cache.
 */
const LOOKAROUND_PATTERN = /\(\?[=!<]/;

const DOCTOR_CLI_PROBE_TIMEOUT_MS = 1200;

/**
 * Best-effort scan of every version Codex has cached for coodra@coodra —
 * `codex plugin add` refreshes this cache in place on reinstall, but never
 * prunes stale versions on its own, and Coodra doesn't manage this
 * directory (Codex owns its shape entirely). Missing directories (nothing
 * cached yet) are not an error here — `probe.hooks`'s file-presence check
 * already covers that case via the marketplace source.
 */
async function findLookaroundInCodexCache(userHome: string): Promise<string | null> {
  const cacheRoot = join(userHome, '.codex', 'plugins', 'cache', CODEX_MARKETPLACE_NAME, CODEX_PLUGIN_NAME);
  const versions = await readdir(cacheRoot).catch(() => []);
  for (const version of versions) {
    const hooksPath = join(cacheRoot, version, 'hooks', 'hooks.json');
    const content = await readFile(hooksPath, 'utf8').catch(() => null);
    if (content !== null && LOOKAROUND_PATTERN.test(content)) return hooksPath;
  }
  return null;
}

async function findDanglingCoodraPluginEntry(userHome: string): Promise<string | null> {
  const configPath = join(userHome, '.codex', 'config.toml');
  const raw = await readFile(configPath, 'utf8').catch(() => null);
  if (raw === null) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const plugins = asRecord(parsed.plugins);
  const marketplaces = asRecord(parsed.marketplaces);
  if (plugins === null) return null;

  for (const key of Object.keys(plugins)) {
    if (!key.startsWith(`${CODEX_PLUGIN_NAME}@`) || key === `${CODEX_PLUGIN_NAME}@${CODEX_MARKETPLACE_NAME}`) continue;
    const marketplaceName = key.slice(`${CODEX_PLUGIN_NAME}@`.length);
    if (marketplaces === null || !(marketplaceName in marketplaces)) return key;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export const codexHookRegistrationCheck: Check = {
  id: 39,
  name: 'Codex native plugin (coodra@coodra) is installed with manifest, MCP, hooks, and skills wired',
  severity: 'yellow',
  async run(ctx) {
    const userHome = ctx.env.HOME || ctx.env.USERPROFILE || homedir();
    const probe = await probeCodexPlugin({ cwd: ctx.cwd, userHome }, createCodexCliRunner(DOCTOR_CLI_PROBE_TIMEOUT_MS));

    const danglingPluginEntry = await findDanglingCoodraPluginEntry(userHome);
    if (danglingPluginEntry !== null) {
      return {
        status: 'yellow',
        detail:
          `Codex config.toml still enables ${danglingPluginEntry}, but no matching marketplace is registered. ` +
          `This is a legacy Coodra Codex plugin entry from the old personal-marketplace install path; the live plugin should be ` +
          `${CODEX_PLUGIN_NAME}@${CODEX_MARKETPLACE_NAME}.`,
        remediation:
          danglingPluginEntry === LEGACY_CODEX_PERSONAL_PLUGIN_KEY
            ? 'Run `coodra agent add codex --force` (or `coodra agent repair codex`) to refresh Coodra and remove the legacy personal-marketplace entry, then start a fresh Codex task.'
            : `Remove the dangling [plugins."${danglingPluginEntry}"] entry from ~/.codex/config.toml or restore its marketplace, then start a fresh Codex task.`,
      };
    }

    const staleCacheHooksPath = await findLookaroundInCodexCache(userHome);
    if (staleCacheHooksPath !== null) {
      return {
        status: 'red',
        detail:
          `Codex's own cached hooks.json at ${staleCacheHooksPath} contains a look-around regex ` +
          "(e.g. `(?!...)`), which Codex's matcher engine rejects outright — PreToolUse/PostToolUse/" +
          'PermissionRequest hooks silently never register, even though the plugin looks fully installed ' +
          "and Coodra's own generated source may already be fixed.",
        remediation:
          'Run `coodra agent add codex --force` (or `coodra agent repair codex`) to make Codex refresh its ' +
          'cached copy with the corrected matcher, then start a fresh Codex task.',
      };
    }

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
        'native Codex plugin (coodra@coodra) is installed with manifest, MCP, hooks, and skills wired, and no ' +
        "look-around regex was found in any cached version of hooks.json. This cannot confirm Codex Desktop's " +
        'separate, one-time hook-trust review has been completed, since Codex exposes no CLI/file signal for ' +
        'that. If hooks still do not fire (no SessionStart/PreToolUse/PostToolUse rows appear for new tasks), ' +
        'open Codex Desktop, run `/hooks`, and review/trust the Coodra hook definition, then start a fresh task.',
    };
  },
};
