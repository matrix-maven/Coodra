import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { GLOBAL_PROJECT_ID, listProjects } from '@coodra/db';
import {
  COODRA_CODEX_NATIVE_PERMISSIONS_BEGIN,
  COODRA_CODEX_NATIVE_PERMISSIONS_END,
  COODRA_POLICY_PROJECTION_BEGIN,
  COODRA_POLICY_PROJECTION_END,
} from '@coodra/shared';
import { EXIT_OK } from '../exit-codes.js';
import { type ClaudeCliRunner, removeClaudePlugin } from '../lib/agents/claude-plugin.js';
import { type CodexCliRunner, removeCodexPlugin } from '../lib/agents/codex-plugin.js';
import { removeCursorPlugin } from '../lib/agents/cursor-plugin.js';
import { resolveCoodraDataDb, resolveCoodraHome } from '../lib/coodra-home.js';
import { type DaemonManager, selectDaemonManager } from '../lib/daemon/index.js';
import { removeClaudeSettings } from '../lib/init/claude-settings-merge.js';
import { removeCodexConfig } from '../lib/init/codex-merge.js';
import { removeInstructionBlock } from '../lib/init/instruction-files.js';
import { readMachineManifest } from '../lib/machine-store/manifest.js';
import { openLocalDb } from '../lib/open-local-db.js';
import { SERVICES } from '../lib/services.js';
import { hintLine, pc } from '../ui/index.js';

/**
 * `coodra uninstall` — tear down Coodra's machine-level runtime wiring.
 *
 * Per OQ-5 lock (2026-05-03) the default is conservative: preserve
 * data + config + project work by default. `--purge` additionally removes
 * every registered repo's Coodra-owned project footprint plus `~/.coodra/`.
 * Always prints the
 * `npm uninstall -g @coodra/cli` command for the user — the
 * CLI does NOT execute it (the binary is mid-execution).
 *
 * Order of operations (best-effort each step; one failure doesn't
 * block the rest):
 *
 *   0. Stop AND uninstall every Coodra daemon unit (mcp-server,
 *      hooks-bridge, sync-daemon, web) via the platform daemon
 *      manager (launchd / systemd / fallback). This runs FIRST so
 *      (a) `coodra uninstall` actually tears the running system down —
 *      pre-2026-07-18 it left the daemons alive, so the web daemon
 *      kept holding port 3001 after "uninstall" — and (b) the SQLite
 *      store is released before any `--remove-data` / `--purge`
 *      deletion (deleting `data.db` out from under an open WAL handle
 *      is a corruption risk).
 *   1. Drop global native/plugin wiring: Claude Code settings,
 *      marketplace/cache entries, and Codex personal marketplace/plugin
 *      bundle + cache mirror (Codex's own runtime, not this code, mirrors
 *      an installed plugin into `cache/personal/coodra/<version>/`; left
 *      alone, an old version lingers there forever — see
 *      `codex-plugin.ts::removeCodexPlugin`).
 *   2. With `--purge`: discover registered project roots from the local DB
 *      and machine manifest, then reverse project-local Coodra writes
 *      (`.codex/config.toml`, `.claude`/instruction blocks, `.coodra/`,
 *      legacy `docs/context-packs/`, etc.). Repo-root `.mcp.json` is
 *      user-owned and is never edited by uninstall.
 *   3. With `--remove-data` (and NOT `--purge`): delete the SQLite
 *      store — `data.db` + its `-wal` / `-shm` sidecars — while
 *      preserving `config.json` and the packs. The narrow "forget my
 *      local history but keep me configured" option.
 *   4. With `--purge`: remove `~/.coodra/` entirely (superset of
 *      `--remove-data`).
 *   5. Always: print the `npm uninstall -g @coodra/cli` command.
 *
 * Idempotent: re-running on a clean install (no coodra entries
 * anywhere, no daemon units) is exit-0 with "nothing to remove" /
 * "already stopped" notes for each step.
 *
 * NOT removed by default: `~/.coodra/data.db`, `~/.coodra/config.json`,
 * and every repo-level `.coodra/` project workspace (wiki, graphify output,
 * work packs, recipes). The user can re-run `coodra install` / `coodra
 * agent add ...` and pick up where they left off. `--remove-data` drops the
 * DB but keeps project work; `--purge` drops the whole Coodra footprint.
 */

export interface UninstallOptions {
  readonly purge?: boolean;
  /**
   * Delete `~/.coodra/data.db` (+ `-wal` / `-shm`) while preserving
   * config + packs. Narrower than `--purge` (which removes all of
   * `~/.coodra/`). No effect when `--purge` is also set — purge is a
   * superset.
   */
  readonly removeData?: boolean;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  /** When set, omit the npm-uninstall print line (used by tests/scripting). */
  readonly skipNpmHint?: boolean;
}

export interface UninstallIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
  readonly coodraHome?: string;
  readonly cwd?: string;
  readonly bridgePort?: number;
  readonly settingsPath?: string;
  readonly userHome?: string;
  /** Test override so integration tests never invoke the real `claude` CLI. */
  readonly claudeCliRunner?: ClaudeCliRunner;
  /** Test override so integration tests never invoke the real `codex` CLI. */
  readonly codexCliRunner?: CodexCliRunner;
  /**
   * Daemon manager override. Tests inject a stub so the daemon-stop
   * step stays hermetic (never touches the host's real launchd /
   * systemd units). Production omits it — `selectDaemonManager` picks
   * the platform manager.
   */
  readonly daemonManager?: DaemonManager;
}

export const DEFAULT_UNINSTALL_IO: UninstallIO = {
  writeStdout: (chunk) => {
    process.stdout.write(chunk);
  },
  writeStderr: (chunk) => {
    process.stderr.write(chunk);
  },
  exit: (code) => {
    process.exit(code);
  },
};

interface UninstallStepResult {
  readonly step: string;
  readonly action: string;
  readonly notes: string;
}

interface UninstallJson {
  readonly ok: true;
  readonly purged: boolean;
  /** Registered project roots every project-scoped remover targeted. */
  readonly projectRoots: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<UninstallStepResult>;
  readonly preserved?: ReadonlyArray<string>;
  readonly npmUninstallCommand: string;
}

interface RegisteredProjectTarget {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly cwd: string;
}

interface ProjectTargetResolution {
  readonly targets: readonly RegisteredProjectTarget[];
  readonly note?: string;
}

export async function runUninstallCommand(options: UninstallOptions, ioOverride?: UninstallIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_UNINSTALL_IO;
  const json = options.json === true;
  const purge = options.purge === true;
  const dryRun = options.dryRun === true;
  const homePath = io.coodraHome ?? resolveCoodraHome();
  const bridgePort = io.bridgePort ?? 3101;
  const removeData = options.removeData === true;
  const userHome = io.userHome ?? homedir();

  const steps: UninstallStepResult[] = [];
  const projectTargets = await resolveProjectTargets({ homePath });

  // Step 0: stop + uninstall every daemon unit BEFORE touching config or
  // data. This is what makes `coodra uninstall` actually tear the system
  // down — pre-2026-07-18 it never called the daemon manager, so the web
  // daemon kept holding port 3001 after "uninstall". Running it first also
  // releases the SQLite store so a later `--remove-data` / `--purge` never
  // deletes `data.db` out from under an open WAL handle.
  await stopAndUninstallDaemons({ io, homePath, dryRun, steps });

  // Step 1: global native/plugin surfaces. Plain uninstall removes these so
  // the next agent session does not keep loading Coodra hooks/skills, while
  // leaving every repo's `.coodra/` artifacts in place for a later reinstall.
  // settingsPath precedence: explicit IO override (tests) > CLAUDE_SETTINGS_PATH
  // env (sandbox runners) > defaultClaudeSettingsPath() (production default).
  // The env override lands inside `removeClaudeSettings`'s default-path
  // resolution so we don't have to thread it through here when the IO
  // override is absent.
  try {
    const result = await removeClaudeSettings({
      ...(io.settingsPath !== undefined ? { settingsPath: io.settingsPath } : {}),
      bridgePort,
      dryRun,
    });
    steps.push({
      step: 'claude-settings',
      action: result.outcome.action,
      notes: result.outcome.notes ?? '',
    });
  } catch (err) {
    steps.push({
      step: 'claude-settings',
      action: 'failed',
      notes: err instanceof Error ? err.message : String(err),
    });
  }

  await removeGlobalNativePlugins({
    userHome,
    homePath,
    bridgePort,
    dryRun,
    ...(io.settingsPath !== undefined ? { settingsPath: io.settingsPath } : {}),
    ...(io.claudeCliRunner !== undefined ? { claudeCliRunner: io.claudeCliRunner } : {}),
    ...(io.codexCliRunner !== undefined ? { codexCliRunner: io.codexCliRunner } : {}),
    steps,
  });

  if (purge) {
    if (projectTargets.note !== undefined) {
      steps.push({ step: 'registered-projects', action: 'unchanged', notes: projectTargets.note });
    }
    if (projectTargets.targets.length === 0) {
      steps.push({ step: 'registered-projects', action: 'unchanged', notes: 'no project roots selected' });
    }
    for (const project of projectTargets.targets) {
      const prefix = projectTargets.targets.length === 1 ? '' : `project:${project.slug}:`;
      await removeProjectScopedFiles({ root: project.cwd, prefix, dryRun, steps });
      await purgeProjectDataDirs({ root: project.cwd, prefix, dryRun, steps });
    }
  } else if (projectTargets.note !== undefined) {
    steps.push({ step: 'registered-projects', action: 'unchanged', notes: projectTargets.note });
  }

  // Step 3: ~/.coodra/ purge (only on --purge)
  if (purge) {
    try {
      let exists = true;
      try {
        await stat(homePath);
      } catch {
        exists = false;
      }
      if (!exists) {
        steps.push({ step: 'purge-home', action: 'unchanged', notes: `${homePath} does not exist` });
      } else {
        if (!dryRun) {
          await rm(homePath, { recursive: true, force: true });
        }
        steps.push({
          step: 'purge-home',
          action: dryRun ? 'unchanged' : 'merged',
          notes: dryRun ? `dry-run: would remove ${homePath}` : `removed ${homePath}`,
        });
      }
    } catch (err) {
      steps.push({
        step: 'purge-home',
        action: 'failed',
        notes: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Step 3b: --remove-data (narrow SQLite removal). Only when NOT purging
  // (purge already removed the whole home dir including data.db). Deletes
  // the main DB plus its WAL + shared-memory sidecars, but keeps
  // config.json and the on-disk packs so a subsequent `coodra start`
  // re-creates a fresh store without re-running `coodra init`.
  if (removeData && !purge) {
    const dbFiles = ['data.db', 'data.db-wal', 'data.db-shm'].map((f) => join(homePath, f));
    const removedNames: string[] = [];
    let removeFailed: string | null = null;
    for (const file of dbFiles) {
      let existed = true;
      try {
        await stat(file);
      } catch {
        existed = false;
      }
      if (!existed) continue;
      try {
        if (!dryRun) await rm(file, { force: true });
        removedNames.push(basename(file));
      } catch (err) {
        removeFailed = err instanceof Error ? err.message : String(err);
      }
    }
    if (removeFailed !== null) {
      steps.push({ step: 'remove-data', action: 'failed', notes: removeFailed });
    } else if (removedNames.length === 0) {
      steps.push({ step: 'remove-data', action: 'unchanged', notes: 'no SQLite store present' });
    } else {
      steps.push({
        step: 'remove-data',
        action: dryRun ? 'unchanged' : 'merged',
        notes: `${dryRun ? 'dry-run: would remove' : 'removed'} ${removedNames.join(', ')} (config + packs preserved)`,
      });
    }
  }

  const npmUninstallCommand = 'npm uninstall -g @coodra/cli';
  const preserved = purge
    ? []
    : removeData
      ? [`${homePath}/config.json`, '.coodra/work-packs/', 'docs/context-packs/']
      : [`${homePath}/data.db`, `${homePath}/config.json`, '.coodra/work-packs/', 'docs/context-packs/'];

  if (json) {
    const payload: UninstallJson = {
      ok: true,
      purged: purge,
      projectRoots: projectTargets.targets.map((project) => project.cwd),
      steps,
      preserved,
      npmUninstallCommand,
    };
    io.writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    io.writeStdout(`${pc.green('✓')} coodra uninstall ${dryRun ? '(dry-run) ' : ''}complete:\n`);
    io.writeStdout(`  ${pc.gray(`project roots: ${projectTargets.targets.length}`)}\n`);
    for (const project of projectTargets.targets) {
      io.writeStdout(`    • ${project.slug}  ${pc.gray(project.cwd)}\n`);
    }
    for (const s of steps) {
      const symbol = s.action === 'failed' ? pc.red('✗') : s.action === 'unchanged' ? pc.dim('—') : pc.green('•');
      io.writeStdout(`  ${symbol} ${s.step}: ${s.action} (${s.notes})\n`);
    }
    if (!purge) {
      io.writeStdout(`\n  Preserved (use ${pc.cyan('--purge')} to remove):\n`);
      for (const p of preserved) {
        io.writeStdout(`    • ${p}\n`);
      }
    }
    if (!dryRun) {
      io.writeStdout(
        `\n${hintLine(
          '  Restart Claude Code / Codex now. A coding agent already running keeps its MCP server subprocess ' +
            'alive regardless of what just got removed on disk — it can silently recreate the DB file and keep ' +
            'answering tool calls (Work Packs, decisions, etc.) against a fresh, empty store until you restart it.',
        )}\n`,
      );
    }
    if (options.skipNpmHint !== true) {
      io.writeStdout(
        `\n  ${pc.cyan('Final step:')} run ${pc.bold(npmUninstallCommand)} to remove the @coodra/cli binary.\n`,
      );
    }
  }
  io.exit(EXIT_OK);
}

async function resolveProjectTargets(args: { readonly homePath: string }): Promise<ProjectTargetResolution> {
  const dbPath = resolveCoodraDataDb(args.homePath);
  let handle: Awaited<ReturnType<typeof openLocalDb>> | null = null;
  const targetsByCwd = new Map<string, RegisteredProjectTarget>();
  let dbReadError: string | null = null;
  try {
    handle = await openLocalDb(dbPath, { loadVecExtension: false });
    const projects = await listProjects(handle);
    for (const project of projects
      .filter((project) => project.id !== GLOBAL_PROJECT_ID && project.cwd !== null)
      .map((project) => ({
        id: project.id,
        slug: project.slug,
        name: project.name,
        cwd: project.cwd as string,
      }))) {
      targetsByCwd.set(project.cwd, project);
    }
  } catch (err) {
    dbReadError = err instanceof Error ? err.message : String(err);
  } finally {
    handle?.close();
  }

  const manifest = await readMachineManifest(args.homePath);
  for (const project of manifest?.projects ?? []) {
    if (!targetsByCwd.has(project.cwd)) {
      targetsByCwd.set(project.cwd, {
        id: project.id,
        slug: project.slug,
        name: project.slug,
        cwd: project.cwd,
      });
    }
  }

  const allTargets = [...targetsByCwd.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  if (allTargets.length > 0) {
    return {
      targets: allTargets,
      ...(dbReadError !== null
        ? { note: `local DB unreadable; using machine manifest project index (${dbReadError})` }
        : {}),
    };
  }
  return {
    targets: [],
    note:
      dbReadError === null
        ? 'no registered project roots found'
        : `could not read registered projects and no manifest project index was available (${dbReadError})`,
  };
}

async function removeGlobalNativePlugins(args: {
  readonly userHome: string;
  readonly homePath: string;
  readonly bridgePort: number;
  readonly dryRun: boolean;
  readonly settingsPath?: string;
  readonly claudeCliRunner?: ClaudeCliRunner;
  readonly codexCliRunner?: CodexCliRunner;
  readonly steps: UninstallStepResult[];
}): Promise<void> {
  const ctx = {
    cwd: args.userHome,
    userHome: args.userHome,
    coodraHome: args.homePath,
    bridgePort: args.bridgePort,
    dryRun: args.dryRun,
    ...(args.settingsPath !== undefined ? { settingsPath: args.settingsPath } : {}),
  };

  try {
    const result = await removeClaudePlugin(ctx, args.claudeCliRunner ?? undefined);
    pushWriteOutcomes(args.steps, 'claude-plugin', result.outcomes);
  } catch (err) {
    args.steps.push({
      step: 'claude-plugin',
      action: 'failed',
      notes: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const result = await removeCodexPlugin(ctx, args.codexCliRunner ?? undefined);
    pushWriteOutcomes(args.steps, 'codex-plugin', result.outcomes);
  } catch (err) {
    args.steps.push({
      step: 'codex-plugin',
      action: 'failed',
      notes: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const result = await removeCursorPlugin(ctx);
    pushWriteOutcomes(args.steps, 'cursor-plugin', result.outcomes);
  } catch (err) {
    args.steps.push({
      step: 'cursor-plugin',
      action: 'failed',
      notes: err instanceof Error ? err.message : String(err),
    });
  }
}

function pushWriteOutcomes(
  steps: UninstallStepResult[],
  prefix: string,
  outcomes: ReadonlyArray<{ readonly path: string; readonly action: string; readonly notes?: string }>,
): void {
  if (outcomes.length === 0) {
    steps.push({ step: prefix, action: 'unchanged', notes: 'nothing to remove' });
    return;
  }
  for (const outcome of outcomes) {
    steps.push({
      step: `${prefix}:${basename(outcome.path)}`,
      action: outcome.action,
      notes: outcome.notes ?? outcome.path,
    });
  }
}

async function removeCodexPolicyProjection(options: { cwd: string; dryRun: boolean }): Promise<{
  readonly action: string;
  readonly notes?: string;
}> {
  const path = join(options.cwd, '.codex', 'config.toml');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { action: 'unchanged', notes: '.codex/config.toml does not exist; nothing to remove' };
  }
  let next = removeManagedTextBlock(raw, COODRA_POLICY_PROJECTION_BEGIN, COODRA_POLICY_PROJECTION_END);
  next = removeManagedTextBlock(next, COODRA_CODEX_NATIVE_PERMISSIONS_BEGIN, COODRA_CODEX_NATIVE_PERMISSIONS_END);
  next = removeTopLevelTomlAssignment(next, 'default_permissions', 'coodra-project');
  if (next === raw) return { action: 'unchanged', notes: 'no Coodra policy projection found' };
  if (!options.dryRun) await writeFile(path, normalizeTextFile(next), 'utf8');
  return {
    action: options.dryRun ? 'unchanged' : 'merged',
    notes: 'removed Coodra policy projection from .codex/config.toml',
  };
}

async function removeClaudePolicyProjection(options: { cwd: string; dryRun: boolean }): Promise<{
  readonly action: string;
  readonly notes?: string;
}> {
  const path = join(options.cwd, '.claude', 'settings.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { action: 'unchanged', notes: '.claude/settings.json does not exist; nothing to remove' };
  }
  let settings: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { action: 'unchanged', notes: '.claude/settings.json is not a JSON object' };
    }
    settings = parsed as Record<string, unknown>;
  } catch (err) {
    return {
      action: 'failed',
      notes: `Cannot parse .claude/settings.json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const coodra =
    settings.coodra !== null && typeof settings.coodra === 'object' && !Array.isArray(settings.coodra)
      ? (settings.coodra as Record<string, unknown>)
      : null;
  const projection = parseProjectionRecord(coodra?.policyProjection);
  if (coodra === null || projection === null) {
    return { action: 'unchanged', notes: 'no Coodra policy projection found' };
  }

  const claudeNative = parseClaudeNativePermissions(projection.nativePermissions);
  if (claudeNative !== null)
    settings.permissions = removeClaudeGeneratedPermissions(settings.permissions, claudeNative);
  delete coodra.policyProjection;
  if (Object.keys(coodra).length === 0) delete settings.coodra;
  else settings.coodra = coodra;

  if (!options.dryRun) await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return {
    action: options.dryRun ? 'unchanged' : 'merged',
    notes: 'removed Coodra policy projection from .claude/settings.json',
  };
}

function removeManagedTextBlock(raw: string, begin: string, end: string): string {
  const start = raw.indexOf(begin);
  const stop = raw.indexOf(end);
  if (start < 0 || stop < start) return raw;
  const afterEnd = stop + end.length;
  return `${raw.slice(0, start)}${raw.slice(afterEnd)}`.replace(/\n{3,}/g, '\n\n');
}

function removeTopLevelTomlAssignment(raw: string, key: string, expectedValue: string): string {
  const lines = raw.split(/\r?\n/);
  let firstTableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  if (firstTableIndex < 0) firstTableIndex = lines.length;
  const matcher = new RegExp(`^\\s*${key}\\s*=\\s*"${escapeRegExp(expectedValue)}"\\s*$`);
  return lines.filter((line, index) => index >= firstTableIndex || !matcher.test(line)).join('\n');
}

function normalizeTextFile(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? '' : `${trimmed}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseProjectionRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseClaudeNativePermissions(value: unknown): {
  readonly allow: readonly string[];
  readonly ask: readonly string[];
  readonly deny: readonly string[];
} | null {
  const native = parseProjectionRecord(value);
  const claude = parseProjectionRecord(native?.claude);
  if (claude === null) return null;
  return {
    allow: asStringArray(claude.allow),
    ask: asStringArray(claude.ask),
    deny: asStringArray(claude.deny),
  };
}

function removeClaudeGeneratedPermissions(
  rawPermissions: unknown,
  generated: { readonly allow: readonly string[]; readonly ask: readonly string[]; readonly deny: readonly string[] },
): Record<string, unknown> {
  const permissions =
    rawPermissions !== null && typeof rawPermissions === 'object' && !Array.isArray(rawPermissions)
      ? { ...(rawPermissions as Record<string, unknown>) }
      : {};
  permissions.allow = removeStrings(asStringArray(permissions.allow), generated.allow);
  permissions.ask = removeStrings(asStringArray(permissions.ask), generated.ask);
  permissions.deny = removeStrings(asStringArray(permissions.deny), generated.deny);
  if (permissions.disableAutoMode === 'disable') delete permissions.disableAutoMode;
  if (permissions.disableBypassPermissionsMode === 'disable') delete permissions.disableBypassPermissionsMode;
  return permissions;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function removeStrings(existing: readonly string[], generated: readonly string[]): string[] {
  const generatedSet = new Set(generated);
  return existing.filter((entry) => !generatedSet.has(entry));
}

async function removeProjectScopedFiles(args: {
  readonly root: string;
  readonly prefix: string;
  readonly dryRun: boolean;
  readonly steps: UninstallStepResult[];
}): Promise<void> {
  const { root, prefix, dryRun, steps } = args;

  for (const [step, fn] of [
    ['claude-md', () => removeInstructionBlock({ cwd: root, filename: 'CLAUDE.md', dryRun })],
    ['claude-policy-projection', () => removeClaudePolicyProjection({ cwd: root, dryRun })],
    ['codex-policy-projection', () => removeCodexPolicyProjection({ cwd: root, dryRun })],
    ['codex-config', () => removeCodexConfig({ cwd: root, dryRun })],
    ['codex-agents-md', () => removeInstructionBlock({ cwd: root, filename: 'AGENTS.md', dryRun })],
  ] as const) {
    try {
      const result = await fn();
      steps.push({ step: `${prefix}${step}`, action: String(result.action), notes: result.notes ?? '' });
    } catch (err) {
      steps.push({
        step: `${prefix}${step}`,
        action: 'failed',
        notes: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function purgeProjectDataDirs(args: {
  readonly root: string;
  readonly prefix: string;
  readonly dryRun: boolean;
  readonly steps: UninstallStepResult[];
}): Promise<void> {
  for (const [step, path] of [
    ['project-coodra-dir', join(args.root, '.coodra')],
    ['legacy-context-packs', join(args.root, 'docs', 'context-packs')],
  ] as const) {
    let exists = true;
    try {
      await stat(path);
    } catch {
      exists = false;
    }
    if (!exists) {
      args.steps.push({ step: `${args.prefix}${step}`, action: 'unchanged', notes: `${path} does not exist` });
      continue;
    }
    try {
      if (!args.dryRun) await rm(path, { recursive: true, force: true });
      args.steps.push({
        step: `${args.prefix}${step}`,
        action: args.dryRun ? 'unchanged' : 'merged',
        notes: args.dryRun ? `dry-run: would remove ${path}` : `removed ${path}`,
      });
    } catch (err) {
      args.steps.push({
        step: `${args.prefix}${step}`,
        action: 'failed',
        notes: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Stop AND uninstall every Coodra daemon unit (mcp-server, hooks-bridge,
 * sync-daemon, web). Best-effort per unit — a stop/uninstall failure for
 * one service is recorded and does not block the rest of uninstall.
 *
 * `manager.stop` + `manager.uninstall` are both idempotent (per the
 * DaemonManager contract), so calling them on a service that was never
 * installed / already stopped is a safe no-op. In `--dry-run` we skip the
 * calls entirely and just record what would happen. Tests inject
 * `io.daemonManager` so this never touches the host's real launchd /
 * systemd; production resolves the platform manager via
 * `selectDaemonManager`.
 */
async function stopAndUninstallDaemons(args: {
  readonly io: UninstallIO;
  readonly homePath: string;
  readonly dryRun: boolean;
  readonly steps: UninstallStepResult[];
}): Promise<void> {
  const { io, homePath, dryRun, steps } = args;
  const serviceNames = SERVICES.map((s) => s.name);

  if (dryRun) {
    for (const name of serviceNames) {
      steps.push({ step: `daemon:${name}`, action: 'unchanged', notes: 'dry-run: would stop + uninstall unit' });
    }
    return;
  }

  let manager: DaemonManager;
  try {
    manager = io.daemonManager ?? (await selectDaemonManager({ coodraHome: homePath }));
  } catch (err) {
    // Could not resolve a daemon manager — record once and skip the loop.
    // The rest of uninstall (config reversal, data removal) still runs.
    steps.push({
      step: 'daemons',
      action: 'failed',
      notes: `could not select daemon manager: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  for (const name of serviceNames) {
    try {
      await manager.stop(name);
      await manager.uninstall(name);
      steps.push({ step: `daemon:${name}`, action: 'merged', notes: 'stopped + removed unit' });
    } catch (err) {
      steps.push({ step: `daemon:${name}`, action: 'failed', notes: err instanceof Error ? err.message : String(err) });
    }
  }
}
