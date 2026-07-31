import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { VERSION } from '../../version.js';
import { buildCoodraMcpEntry, type CoodraMcpEntry } from '../init/mcp-merge.js';
import type { WriteOutcome } from '../init/types.js';
import { deepWikiFeatureFrontmatter, renderDeepWikiFeatureBody } from '../wiki/recipe.js';
import { buildManagedGraphifyMcpEntry } from './managed-capabilities.js';
import type { AgentContext, AgentPathContext, AgentRemoveContext } from './types.js';

const execFile = promisify(execFileCallback);

export const CLAUDE_PLUGIN_NAME = 'coodra' as const;
export const CLAUDE_MARKETPLACE_NAME = 'coodra' as const;
export const CLAUDE_PLUGIN_KEY = `${CLAUDE_PLUGIN_NAME}@${CLAUDE_MARKETPLACE_NAME}` as const;
export const CLAUDE_LEGACY_SKILLS_DIR_PLUGIN_KEY = `${CLAUDE_PLUGIN_NAME}@skills-dir` as const;

/**
 * Prefer Claude Code's own `claude plugin` CLI to register the marketplace
 * and install/remove the plugin — it owns `settings.json`,
 * `known_marketplaces.json`, and the plugin cache directly, so Coodra
 * doesn't need to guess their shape or race Claude Code's own
 * install/update-triggered cache-eviction bookkeeping. See
 * docs/en/plugin-marketplaces and docs/en/plugins-reference (code.claude.com)
 * for the documented `claude plugin marketplace add` / `claude plugin
 * install --scope user` / `claude plugin uninstall --scope user` surface.
 *
 * Falls back to the hand-written settings/cache path below whenever the
 * `claude` binary isn't on PATH yet (the common case on a machine where
 * Coodra runs before Claude Code has ever been launched) or the CLI call
 * fails for any reason — the exact scripting contract (exit codes,
 * preconditions) isn't documented, so failures here are treated as
 * "unavailable," not surfaced as errors.
 */
export interface ClaudeCliRunner {
  detect(): Promise<string | null>;
  installMarketplaceAndPlugin(
    claudeBin: string,
    marketplaceRoot: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  uninstallPlugin(claudeBin: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Best-effort: is `coodra@coodra` visible to `claude plugin list --json`? */
  isInstalled(claudeBin: string): Promise<boolean>;
}

const CLI_TIMEOUT_MS = 15_000;

async function detectClaudeCli(timeoutMs: number): Promise<string | null> {
  try {
    const { stdout } = await execFile('which', ['claude'], { timeout: timeoutMs });
    const path = stdout.trim();
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

/**
 * Factory rather than a single constant so callers with a tight time budget
 * (doctor's per-check timeout races the whole check against ~2s by default —
 * see 28-claude-hook-registration.ts) can ask for a short-timeout runner
 * instead of the 15s budget that's appropriate for an actual install/remove.
 * A slow CLI call under a short budget fails fast and falls back to the
 * file-based checks, rather than the whole doctor check racing past its own
 * timeout and reporting an uninformative "timeout" status.
 */
export function createClaudeCliRunner(timeoutMs: number = CLI_TIMEOUT_MS): ClaudeCliRunner {
  return {
    detect: () => detectClaudeCli(timeoutMs),
    async installMarketplaceAndPlugin(claudeBin, marketplaceRoot) {
      try {
        await execFile(claudeBin, ['plugin', 'marketplace', 'add', marketplaceRoot], { timeout: timeoutMs });
        await execFile(claudeBin, ['plugin', 'install', CLAUDE_PLUGIN_KEY, '--scope', 'user'], { timeout: timeoutMs });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    async uninstallPlugin(claudeBin) {
      try {
        await execFile(claudeBin, ['plugin', 'uninstall', CLAUDE_PLUGIN_KEY, '--scope', 'user'], {
          timeout: timeoutMs,
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    async isInstalled(claudeBin) {
      // Best-effort: `claude plugin list --json`'s exact schema hasn't been
      // verified against a live install (no `claude` binary was available to
      // test against while this was written) — a loose substring match on
      // both the plugin and marketplace name avoids over-fitting to a schema
      // we haven't confirmed. False negatives here just mean probe falls back
      // to the file-based checks; they don't affect install/remove behavior.
      try {
        const { stdout } = await execFile(claudeBin, ['plugin', 'list', '--json'], { timeout: timeoutMs });
        return stdout.includes(CLAUDE_PLUGIN_NAME) && stdout.includes(CLAUDE_MARKETPLACE_NAME);
      } catch {
        return false;
      }
    },
  };
}

export const defaultClaudeCliRunner: ClaudeCliRunner = createClaudeCliRunner();

export interface ClaudePluginPaths {
  readonly settingsPath: string;
  readonly pluginsRoot: string;
  readonly knownMarketplacesPath: string;
  readonly legacyInstalledPluginsPath: string;
  readonly marketplaceRoot: string;
  readonly marketplacePath: string;
  readonly pluginRoot: string;
  readonly cachePluginRoot: string;
  readonly manifestPath: string;
  readonly cacheManifestPath: string;
  readonly mcpPath: string;
  readonly cacheMcpPath: string;
  readonly hooksPath: string;
  readonly cacheHooksPath: string;
  readonly skillsRoot: string;
  readonly cacheSkillsRoot: string;
  readonly readmePath: string;
}

export function claudePluginPaths(
  userHome: string,
  coodraHome = join(userHome, '.coodra'),
  settingsPathOverride?: string,
): ClaudePluginPaths {
  const pluginsRoot = join(userHome, '.claude', 'plugins');
  const marketplaceRoot = join(coodraHome, 'claude-marketplaces', CLAUDE_MARKETPLACE_NAME);
  const pluginRoot = join(marketplaceRoot, 'plugins', CLAUDE_PLUGIN_NAME);
  const cachePluginRoot = join(pluginsRoot, 'cache', CLAUDE_MARKETPLACE_NAME, CLAUDE_PLUGIN_NAME, VERSION);
  const skillsRoot = join(pluginRoot, 'skills');
  return {
    settingsPath: settingsPathOverride ?? join(userHome, '.claude', 'settings.json'),
    pluginsRoot,
    knownMarketplacesPath: join(pluginsRoot, 'known_marketplaces.json'),
    legacyInstalledPluginsPath: join(pluginsRoot, 'installed_plugins.json'),
    marketplaceRoot,
    marketplacePath: join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    pluginRoot,
    cachePluginRoot,
    manifestPath: join(pluginRoot, '.claude-plugin', 'plugin.json'),
    cacheManifestPath: join(cachePluginRoot, '.claude-plugin', 'plugin.json'),
    mcpPath: join(pluginRoot, '.mcp.json'),
    cacheMcpPath: join(cachePluginRoot, '.mcp.json'),
    hooksPath: join(pluginRoot, 'hooks', 'hooks.json'),
    cacheHooksPath: join(cachePluginRoot, 'hooks', 'hooks.json'),
    skillsRoot,
    cacheSkillsRoot: join(cachePluginRoot, 'skills'),
    readmePath: join(pluginRoot, 'README.md'),
  };
}

export function buildClaudePluginMcpEntry(ctx: AgentContext): CoodraMcpEntry {
  return buildCoodraMcpEntry({ ...ctx.mcpEntryOptions, agentType: 'claude_code' });
}

export async function probeClaudePlugin(
  ctx: AgentPathContext,
  cliRunner: ClaudeCliRunner = defaultClaudeCliRunner,
): Promise<{
  readonly enabled: boolean;
  readonly marketplace: boolean;
  readonly manifest: boolean;
  readonly mcp: boolean;
  readonly hooks: boolean;
  readonly skills: boolean;
  readonly paths: ClaudePluginPaths;
}> {
  const paths = claudePluginPaths(ctx.userHome, undefined, ctx.settingsPath);
  const [enabled, manifest, marketplace, mcp, hooks, coodraContextSkill, deepWikiAuthorSkill] = await Promise.all([
    settingsEnablesPlugin(paths.settingsPath, CLAUDE_PLUGIN_KEY),
    fileContains(paths.cacheManifestPath, `"name": "${CLAUDE_PLUGIN_NAME}"`),
    fileContains(paths.knownMarketplacesPath, `"${CLAUDE_MARKETPLACE_NAME}"`),
    fileContainsAll(paths.cacheMcpPath, [`"coodra"`, `"graphify"`]),
    fileContains(paths.cacheHooksPath, `"SessionStart"`),
    fileContains(join(paths.cacheSkillsRoot, 'coodra-context', 'SKILL.md'), 'name: coodra-context'),
    fileContains(join(paths.cacheSkillsRoot, 'deep-wiki-author', 'SKILL.md'), 'name: deep-wiki-author'),
  ]);
  const skills = coodraContextSkill && deepWikiAuthorSkill;
  // The file-based checks above only see state Coodra wrote by hand — they
  // miss an install that went through `claude plugin install` (which never
  // touches Coodra's own cache mirror; see installClaudePlugin). When the
  // CLI is available, treat "claude plugin list" seeing coodra@coodra as
  // sufficient evidence that manifest/mcp/hooks/skills are all wired,
  // rather than reporting a false "missing" for a correctly-installed
  // plugin.
  const claudeBin = await cliRunner.detect();
  if (claudeBin !== null && (await cliRunner.isInstalled(claudeBin))) {
    return { enabled: true, marketplace: true, manifest: true, mcp: true, hooks: true, skills: true, paths };
  }
  return { enabled, marketplace, manifest, mcp, hooks, skills, paths };
}

export async function installClaudePlugin(
  ctx: AgentContext,
  cliRunner: ClaudeCliRunner = defaultClaudeCliRunner,
): Promise<{
  readonly outcomes: WriteOutcome[];
  readonly paths: ClaudePluginPaths;
}> {
  const paths = claudePluginPaths(ctx.userHome, ctx.mcpEntryOptions.coodraHome, ctx.settingsPath);
  const mcpEntry = buildClaudePluginMcpEntry(ctx);
  const graphifyEntry = buildManagedGraphifyMcpEntry(ctx.mcpEntryOptions.coodraHome ?? join(ctx.userHome, '.coodra'));
  const sourceFiles = new Map<string, string>([
    [paths.marketplacePath, marketplaceManifest()],
    [paths.manifestPath, pluginManifest()],
    [paths.mcpPath, `${JSON.stringify({ mcpServers: { coodra: mcpEntry, graphify: graphifyEntry } }, null, 2)}\n`],
    [paths.hooksPath, `${JSON.stringify(hooksConfig(), null, 2)}\n`],
    [join(paths.skillsRoot, 'coodra-init', 'SKILL.md'), coodraInitSkill()],
    [join(paths.skillsRoot, 'coodra-context', 'SKILL.md'), coodraContextSkill()],
    [join(paths.skillsRoot, 'coodra-skill', 'SKILL.md'), coodraSkillSkill()],
    [join(paths.skillsRoot, 'coodra-wiki', 'SKILL.md'), coodraWikiSkill()],
    [join(paths.skillsRoot, 'deep-wiki-author', 'SKILL.md'), deepWikiAuthorSkill()],
    [join(paths.skillsRoot, 'coodra-graphify', 'SKILL.md'), coodraGraphifySkill()],
    [paths.readmePath, readme()],
  ]);

  // The marketplace SOURCE always lands on disk first — both the CLI path
  // and the fallback path need it (`claude plugin marketplace add` registers
  // an *existing* local marketplace; it doesn't create one).
  const outcomes: WriteOutcome[] = [];
  for (const [path, content] of sourceFiles) {
    outcomes.push(await writeGenerated(path, content, ctx.force, ctx.dryRun));
  }

  if (!ctx.dryRun) {
    const claudeBin = await cliRunner.detect();
    if (claudeBin !== null) {
      const cli = await cliRunner.installMarketplaceAndPlugin(claudeBin, paths.marketplaceRoot);
      if (cli.ok) {
        outcomes.push({
          path: paths.settingsPath,
          action: 'wrote',
          notes: `enabled ${CLAUDE_PLUGIN_KEY} via 'claude plugin install --scope user'`,
        });
        return { outcomes, paths };
      }
      outcomes.push({
        path: paths.settingsPath,
        action: 'unchanged',
        notes: `'claude plugin install' failed (${cli.reason}); falling back to direct settings/cache write`,
      });
    }
  }

  outcomes.push(await enablePluginInUserSettings(paths.settingsPath, paths.marketplaceRoot, ctx.force, ctx.dryRun));
  outcomes.push(await registerMarketplace(paths, ctx.dryRun));
  const cacheFiles = new Map(
    [...sourceFiles]
      .filter(([path]) => path !== paths.marketplacePath)
      .map(([path, content]) => [join(paths.cachePluginRoot, path.slice(paths.pluginRoot.length + 1)), content]),
  );
  for (const [path, content] of cacheFiles) {
    outcomes.push(await writeGenerated(path, content, ctx.force, ctx.dryRun));
  }
  outcomes.push(...(await pruneStaleCacheVersions(paths.cachePluginRoot, ctx.dryRun)));
  return { outcomes, paths };
}

export async function removeClaudePlugin(
  ctx: AgentRemoveContext,
  cliRunner: ClaudeCliRunner = defaultClaudeCliRunner,
): Promise<{
  readonly outcomes: WriteOutcome[];
  readonly paths: ClaudePluginPaths;
}> {
  const paths = claudePluginPaths(ctx.userHome, ctx.coodraHome, ctx.settingsPath);
  const outcomes: WriteOutcome[] = [];

  // Best-effort: let Claude Code's own uninstall clean up whatever it owns
  // (settings.json, known_marketplaces.json, cache). The manual cleanup
  // below always runs afterward regardless of outcome — it's idempotent
  // (each step no-ops on a missing path/entry) and also removes the
  // Coodra-owned marketplace source + legacy artifacts the CLI doesn't
  // know about.
  if (!ctx.dryRun) {
    const claudeBin = await cliRunner.detect();
    if (claudeBin !== null) {
      const cli = await cliRunner.uninstallPlugin(claudeBin);
      outcomes.push({
        path: paths.settingsPath,
        action: cli.ok ? 'merged' : 'unchanged',
        notes: cli.ok
          ? `removed ${CLAUDE_PLUGIN_KEY} via 'claude plugin uninstall --scope user'`
          : `'claude plugin uninstall' failed or plugin not installed via CLI (${cli.reason})`,
      });
    }
  }

  outcomes.push(await removePluginFromUserSettings(paths.settingsPath, ctx.dryRun));
  outcomes.push(await removeMarketplaceRegistration(paths.knownMarketplacesPath, ctx.dryRun));
  outcomes.push(await removeLegacyInstalledPluginRecord(paths.legacyInstalledPluginsPath, ctx.dryRun));
  outcomes.push(await removePath(paths.marketplaceRoot, ctx.dryRun, 'removed Coodra Claude marketplace source'));
  // Full uninstall sweeps every cached version, not just the current one —
  // unlike the install-time prune above, there's no concurrent-session grace
  // period to respect here, the user explicitly asked to remove everything.
  outcomes.push(
    await removePath(dirname(paths.cachePluginRoot), ctx.dryRun, 'removed all Coodra Claude plugin cache versions'),
  );
  outcomes.push(
    await removePath(
      join(ctx.userHome, '.claude', 'plugins', 'marketplaces', CLAUDE_MARKETPLACE_NAME),
      ctx.dryRun,
      'removed legacy Coodra marketplace source under ~/.claude',
    ),
  );
  outcomes.push(
    await removePath(
      join(ctx.userHome, '.claude', 'skills', CLAUDE_PLUGIN_NAME),
      ctx.dryRun,
      'removed legacy Coodra skills-dir plugin',
    ),
  );
  return { outcomes, paths };
}

async function enablePluginInUserSettings(
  settingsPath: string,
  marketplaceRoot: string,
  force: boolean,
  dryRun: boolean,
): Promise<WriteOutcome> {
  let parsed: Record<string, unknown> = {};
  try {
    const raw = await readFile(settingsPath, 'utf8');
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  const enabledPlugins =
    parsed.enabledPlugins !== null && typeof parsed.enabledPlugins === 'object' && !Array.isArray(parsed.enabledPlugins)
      ? { ...(parsed.enabledPlugins as Record<string, unknown>) }
      : {};
  const extraKnownMarketplaces =
    parsed.extraKnownMarketplaces !== null &&
    typeof parsed.extraKnownMarketplaces === 'object' &&
    !Array.isArray(parsed.extraKnownMarketplaces)
      ? { ...(parsed.extraKnownMarketplaces as Record<string, unknown>) }
      : {};

  const marketplaceEntry = { source: { source: 'directory', path: marketplaceRoot } };
  const marketplaceAlreadyRegistered =
    JSON.stringify(extraKnownMarketplaces[CLAUDE_MARKETPLACE_NAME]) === JSON.stringify(marketplaceEntry);
  if (enabledPlugins[CLAUDE_PLUGIN_KEY] === true && marketplaceAlreadyRegistered) {
    return { path: settingsPath, action: 'unchanged', notes: `${CLAUDE_PLUGIN_KEY} already enabled in user settings` };
  }
  if (enabledPlugins[CLAUDE_PLUGIN_KEY] !== undefined && enabledPlugins[CLAUDE_PLUGIN_KEY] !== true && !force) {
    return {
      path: settingsPath,
      action: 'unchanged',
      notes: `${CLAUDE_PLUGIN_KEY} is explicitly disabled; pass --force to enable`,
    };
  }

  delete enabledPlugins[CLAUDE_LEGACY_SKILLS_DIR_PLUGIN_KEY];
  enabledPlugins[CLAUDE_PLUGIN_KEY] = true;
  extraKnownMarketplaces[CLAUDE_MARKETPLACE_NAME] = marketplaceEntry;
  const next = { ...parsed, enabledPlugins, extraKnownMarketplaces };
  if (!dryRun) {
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  }
  return { path: settingsPath, action: 'wrote', notes: `enabled ${CLAUDE_PLUGIN_KEY} in Claude Code user settings` };
}

async function removePluginFromUserSettings(settingsPath: string, dryRun: boolean): Promise<WriteOutcome> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return { path: settingsPath, action: 'unchanged', notes: 'Claude settings do not exist; nothing to remove' };
  }

  const enabledPlugins =
    parsed.enabledPlugins !== null && typeof parsed.enabledPlugins === 'object' && !Array.isArray(parsed.enabledPlugins)
      ? { ...(parsed.enabledPlugins as Record<string, unknown>) }
      : {};
  const extraKnownMarketplaces =
    parsed.extraKnownMarketplaces !== null &&
    typeof parsed.extraKnownMarketplaces === 'object' &&
    !Array.isArray(parsed.extraKnownMarketplaces)
      ? { ...(parsed.extraKnownMarketplaces as Record<string, unknown>) }
      : {};

  const before = JSON.stringify({ enabledPlugins, extraKnownMarketplaces });
  delete enabledPlugins[CLAUDE_PLUGIN_KEY];
  delete enabledPlugins[CLAUDE_LEGACY_SKILLS_DIR_PLUGIN_KEY];
  delete extraKnownMarketplaces[CLAUDE_MARKETPLACE_NAME];
  const after = JSON.stringify({ enabledPlugins, extraKnownMarketplaces });
  if (before === after) {
    return { path: settingsPath, action: 'unchanged', notes: 'no Coodra Claude plugin settings to remove' };
  }

  const next = { ...parsed, enabledPlugins, extraKnownMarketplaces };
  if (!dryRun) await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { path: settingsPath, action: 'merged', notes: 'removed Coodra Claude plugin settings' };
}

async function registerMarketplace(paths: ClaudePluginPaths, dryRun: boolean): Promise<WriteOutcome> {
  const now = new Date().toISOString();
  const entry = {
    source: { source: 'directory', path: paths.marketplaceRoot },
    installLocation: paths.marketplaceRoot,
    lastUpdated: now,
  };
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(await readFile(paths.knownMarketplacesPath, 'utf8')) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const existing = parsed[CLAUDE_MARKETPLACE_NAME];
  if (JSON.stringify(existing) === JSON.stringify(entry)) {
    return {
      path: paths.knownMarketplacesPath,
      action: 'unchanged',
      notes: `${CLAUDE_MARKETPLACE_NAME} marketplace already registered`,
    };
  }
  const next = { ...parsed, [CLAUDE_MARKETPLACE_NAME]: entry };
  if (!dryRun) {
    await mkdir(dirname(paths.knownMarketplacesPath), { recursive: true });
    await writeFile(paths.knownMarketplacesPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  }
  return { path: paths.knownMarketplacesPath, action: 'wrote', notes: 'registered Coodra Claude marketplace' };
}

async function removeMarketplaceRegistration(path: string, dryRun: boolean): Promise<WriteOutcome> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return { path, action: 'unchanged', notes: 'known marketplaces file does not exist; nothing to remove' };
  }
  if (!Object.hasOwn(parsed, CLAUDE_MARKETPLACE_NAME)) {
    return { path, action: 'unchanged', notes: 'Coodra marketplace is not registered' };
  }
  delete parsed[CLAUDE_MARKETPLACE_NAME];
  if (!dryRun) await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return { path, action: 'merged', notes: 'removed Coodra Claude marketplace registration' };
}

async function removeLegacyInstalledPluginRecord(path: string, dryRun: boolean): Promise<WriteOutcome> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return { path, action: 'unchanged', notes: 'legacy installed plugins file does not exist; nothing to remove' };
  }

  const plugins =
    parsed.plugins !== null && typeof parsed.plugins === 'object' && !Array.isArray(parsed.plugins)
      ? { ...(parsed.plugins as Record<string, unknown>) }
      : {};
  if (!Object.hasOwn(plugins, CLAUDE_PLUGIN_KEY)) {
    return { path, action: 'unchanged', notes: 'legacy Coodra installed plugin record is not present' };
  }

  delete plugins[CLAUDE_PLUGIN_KEY];
  const next = { ...parsed, plugins };
  if (!dryRun) {
    if (Object.keys(plugins).length === 0) {
      await rm(path);
    } else {
      await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    }
  }
  return { path, action: 'merged', notes: 'removed legacy Coodra installed plugin record' };
}

async function removePath(path: string, dryRun: boolean, note: string): Promise<WriteOutcome> {
  try {
    await access(path);
    if (!dryRun) await rm(path, { recursive: true });
    return { path, action: 'merged', notes: note };
  } catch {
    return { path, action: 'unchanged', notes: 'path does not exist; nothing to remove' };
  }
}

async function settingsEnablesPlugin(settingsPath: string, pluginKey: string): Promise<boolean> {
  try {
    const raw = await readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as { enabledPlugins?: Record<string, unknown> };
    return parsed.enabledPlugins?.[pluginKey] === true;
  } catch {
    return false;
  }
}

function marketplaceManifest(): string {
  return `${JSON.stringify(
    {
      name: CLAUDE_MARKETPLACE_NAME,
      owner: {
        name: 'Coodra',
        url: 'https://github.com/matrix-maven/Coodra',
      },
      description: 'Local Coodra Claude Code plugins.',
      plugins: [
        {
          name: CLAUDE_PLUGIN_NAME,
          displayName: 'Coodra',
          source: './plugins/coodra',
          description:
            'Coodra project memory, context packs, wiki, Graphify, policy, and Jira sync workflows for Claude Code.',
          version: VERSION,
          author: { name: 'Coodra' },
          homepage: 'https://github.com/matrix-maven/Coodra',
          repository: 'https://github.com/matrix-maven/Coodra',
          license: 'MIT',
          category: 'Developer Tools',
          keywords: ['coodra', 'claude-code', 'mcp', 'context', 'wiki', 'graphify', 'jira'],
          defaultEnabled: true,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

async function writeGenerated(path: string, content: string, force: boolean, dryRun: boolean): Promise<WriteOutcome> {
  try {
    const existing = await readFile(path, 'utf8');
    if (existing === content) {
      return { path, action: 'unchanged', notes: 'already matches Coodra Claude Code plugin baseline' };
    }
    if (!force) {
      return { path, action: 'unchanged', notes: 'exists with local changes; pass --force to overwrite' };
    }
    if (!dryRun) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    }
    return { path, action: 'forced', notes: 'overwrote with Coodra Claude Code plugin baseline' };
  } catch {
    if (!dryRun) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    }
    return { path, action: 'wrote', notes: 'created Coodra Claude Code plugin file' };
  }
}

/**
 * Matches Claude Code's own documented orphaned-version grace period (docs:
 * "the previous version directory is marked as orphaned and removed
 * automatically 14 days later. The grace period lets concurrent Claude Code
 * sessions that already loaded the old version keep running without
 * errors."). Claude Code's eviction is triggered by an install/update
 * *operation*, which the hand-written fallback path never records — so
 * without this, every version bump would leave a permanent orphaned
 * directory behind. Coodra prunes its own stale versions on the same grace
 * window rather than immediately, for the same reason Claude Code waits:
 * a session that just picked up an older version shouldn't have its files
 * yanked out from under it mid-session.
 */
const CACHE_EVICTION_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

async function pruneStaleCacheVersions(
  cachePluginRoot: string,
  dryRun: boolean,
  graceMs: number = CACHE_EVICTION_GRACE_MS,
): Promise<WriteOutcome[]> {
  const versionsRoot = dirname(cachePluginRoot);
  const currentVersionDir = basename(cachePluginRoot);
  let entries: string[];
  try {
    entries = await readdir(versionsRoot);
  } catch {
    return [];
  }

  const outcomes: WriteOutcome[] = [];
  for (const entry of entries) {
    if (entry === currentVersionDir) continue;
    const entryPath = join(versionsRoot, entry);
    try {
      const stats = await stat(entryPath);
      if (!stats.isDirectory()) continue;
      if (Date.now() - stats.mtimeMs < graceMs) continue;
      if (!dryRun) await rm(entryPath, { recursive: true });
      outcomes.push({
        path: entryPath,
        action: 'merged',
        notes: 'pruned stale Coodra Claude plugin cache version (older than the 14-day grace window)',
      });
    } catch {
      // Entry vanished or unreadable between readdir and stat — skip it.
    }
  }
  return outcomes;
}

function pluginManifest(): string {
  return `${JSON.stringify(
    {
      name: CLAUDE_PLUGIN_NAME,
      version: VERSION,
      description:
        'Coodra project memory, context packs, wiki, Graphify, policy, and Jira sync workflows for Claude Code.',
      author: { name: 'Coodra' },
      homepage: 'https://github.com/matrix-maven/Coodra',
      repository: 'https://github.com/matrix-maven/Coodra',
      license: 'MIT',
      keywords: ['coodra', 'claude-code', 'mcp', 'context', 'wiki', 'graphify', 'jira'],
      skills: './skills/',
      hooks: './hooks/hooks.json',
      mcpServers: './.mcp.json',
    },
    null,
    2,
  )}\n`;
}

function hooksConfig(): unknown {
  const lifecycleHook = mcpLifecycleHook(10);
  const shortHook = mcpLifecycleHook(3);
  return {
    hooks: {
      SessionStart: [{ hooks: [lifecycleHook] }],
      UserPromptSubmit: [{ hooks: [lifecycleHook] }],
      PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [lifecycleHook] }],
      PostToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [lifecycleHook] }],
      Stop: [{ hooks: [lifecycleHook] }],
      SessionEnd: [{ hooks: [shortHook] }],
    },
  };
}

function mcpLifecycleHook(timeout: number): unknown {
  return {
    type: 'mcp_tool',
    server: `plugin:${CLAUDE_PLUGIN_NAME}:coodra`,
    tool: 'lifecycle_event',
    input: {
      agentType: 'claude_code',
      rawPayload: {
        hook_event_name: placeholder('hook_event_name'),
        session_id: placeholder('session_id'),
        cwd: placeholder('cwd'),
        tool_name: placeholder('tool_name'),
        tool_use_id: placeholder('tool_use_id'),
        prompt: placeholder('prompt'),
        prompt_id: placeholder('prompt_id'),
        tool_input: {
          file_path: placeholder('tool_input.file_path'),
          filePath: placeholder('tool_input.filePath'),
          path: placeholder('tool_input.path'),
          command: placeholder('tool_input.command'),
          description: placeholder('tool_input.description'),
          content: placeholder('tool_input.content'),
        },
      },
    },
    timeout,
  };
}

function placeholder(path: string): string {
  return `\${${path}}`;
}

function coodraInitSkill(): string {
  return `---
name: coodra-init
description: Initialize or repair Coodra project state for the current repository using the project-local .coodra layout.
---

Use this skill when the user asks to initialize, register, repair, or inspect Coodra setup for a repository.

1. Inspect the repository root and current Coodra state under \`.coodra/\`.
2. Run \`coodra init\` to create or repair project-local Coodra files.
3. Confirm that setup created \`.coodra/config.json\`, \`.coodra/manifest.json\`, \`.coodra/skill-packs/\`, \`.coodra/graphify/\`, and \`.coodra/wiki/\`.
4. Do not create legacy root-level \`.coodra.json\`, project \`.env\`, \`.codex/config.toml\`, or \`AGENTS.md\` for Claude Code setup.
`;
}

function coodraContextSkill(): string {
  return `---
name: coodra-context
description: Retrieve and use Coodra project context, decisions, run history, and context packs before making code changes.
---

Use this skill before implementation when the task may depend on repository architecture, previous decisions, feature-pack state, or policy history.

1. Prefer Coodra MCP tools for live project context when available.
2. Read \`.coodra/config.json\` and \`.coodra/manifest.json\` to identify the project.
3. Review relevant context packs and recent decisions before editing.
4. Keep generated Coodra state under \`.coodra/\`.
`;
}

function coodraSkillSkill(): string {
  return `---
name: coodra-skill
description: Find and apply project or global Coodra skill packs such as API development, security audit, plugin-building, or language best-practice workflows.
---

Use this skill when the user asks for a reusable project or global skill pack, or when a task clearly matches one.

1. Look for project skill packs under \`.coodra/skill-packs/\`.
2. Prefer project skill packs over global packs when both apply.
3. Treat skill packs as task workflow guidance, not as product feature packs.
4. Apply the chosen pack's instructions before implementing.
`;
}

function coodraWikiSkill(): string {
  return `---
name: coodra-wiki
description: Generate, update, inspect, or use the Coodra project wiki stored under .coodra/wiki.
---

Use this skill when the user asks for wiki generation, architecture documentation, codebase explanations, or wiki-grounded implementation context.

1. Inspect \`.coodra/wiki/job.md\` and \`.coodra/wiki/grounding.md\` first when generating or refreshing a wiki.
2. Save wiki structure/pages through Coodra's \`wiki_save_structure\`, \`wiki_save_page\`, and \`wiki_status\` MCP tools before writing mirror files.
3. Mirror successful saves under \`.coodra/wiki/<slug>/structure.json\` and \`.coodra/wiki/<slug>/<pageId>.md\`.
4. Use Graphify artifacts under \`.coodra/graphify/out/\` when they exist, and derive the wiki shape from this repo rather than a fixed template.
5. Use existing wiki records as grounding, but verify claims against source files before editing.
`;
}

function deepWikiAuthorSkill(): string {
  const fm = deepWikiFeatureFrontmatter();
  return `---
name: ${fm.name}
description: ${fm.description}
---

${renderDeepWikiFeatureBody()}`;
}

function coodraGraphifySkill(): string {
  return `---
name: coodra-graphify
description: Build, inspect, or use Graphify codebase graph artifacts managed by Coodra under .coodra/graphify.
---

Use this skill when the user asks to graphify a repository, use the code graph, inspect graph artifacts, or make the assistant always consult the graph.

1. Prefer Coodra-managed Graphify output under \`.coodra/graphify/out/\`.
2. Set \`GRAPHIFY_OUT=.coodra/graphify/out\` before running Graphify when the command supports it.
3. Use Graphify artifacts as context before broad architecture, dependency, wiki, or refactor work.
4. Do not leave new Graphify output in root-level \`graphify-out/\` unless the user explicitly asks.
`;
}

function readme(): string {
  return `# Coodra for Claude Code

This is the Coodra native Claude Code plugin. It bundles Coodra MCP registration, lifecycle hooks, and reusable Coodra skills.

Claude Code loads this plugin from the local Coodra marketplace as \`coodra@coodra\`. Restart Claude Code or run \`/reload-plugins\` after \`coodra agent add claude\`.
`;
}

async function fileContains(path: string, needle: string): Promise<boolean> {
  try {
    return (await readFile(path, 'utf8')).includes(needle);
  } catch {
    return false;
  }
}

async function fileContainsAll(path: string, needles: readonly string[]): Promise<boolean> {
  try {
    const content = await readFile(path, 'utf8');
    return needles.every((needle) => content.includes(needle));
  } catch {
    return false;
  }
}
