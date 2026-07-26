import { rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { EXIT_OK } from '../exit-codes.js';
import { resolveCoodraHome } from '../lib/coodra-home.js';
import { type DaemonManager, selectDaemonManager } from '../lib/daemon/index.js';
import { detectProjectRoot } from '../lib/detect.js';
import { removeClaudeSettings } from '../lib/init/claude-settings-merge.js';
import { removeCodexConfig } from '../lib/init/codex-merge.js';
import { removeCursorMcpConfig } from '../lib/init/cursor-merge.js';
import { removeInstructionBlock } from '../lib/init/instruction-files.js';
import { removeMcpJson } from '../lib/init/mcp-merge.js';
import { removeWindsurfMcpConfig } from '../lib/init/windsurf-merge.js';
import { SERVICES } from '../lib/services.js';
import { pc } from '../ui/index.js';

/**
 * `coodra uninstall` — reverse `coodra init` writes.
 *
 * Per OQ-5 lock (2026-05-03) the default is conservative: preserve
 * data + config + feature/context packs by default. `--purge` adds
 * removal of `~/.coodra/`. Always prints the
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
 *   1. Drop `__coodra__`-matcher / URL-owned entries from
 *      `~/.claude/settings.json`.
 *   2. Drop the `coodra` server from `<cwd>/.mcp.json` + reverse the
 *      per-agent Codex / Cursor / Windsurf / CLAUDE.md writes.
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
 * NOT removed by default: `~/.coodra/data.db`,
 * `~/.coodra/config.json`, every `docs/feature-packs/<slug>/`,
 * every `docs/context-packs/`. The user can re-run `coodra init`
 * after `npm i -g` and pick up where they left off. `--remove-data`
 * drops the DB but keeps config + packs; `--purge` drops everything.
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
  /** The resolved project root every project-scoped remover targeted. */
  readonly projectRoot: string;
  readonly steps: ReadonlyArray<UninstallStepResult>;
  readonly preserved?: ReadonlyArray<string>;
  readonly npmUninstallCommand: string;
}

export async function runUninstallCommand(options: UninstallOptions, ioOverride?: UninstallIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_UNINSTALL_IO;
  const json = options.json === true;
  const purge = options.purge === true;
  const dryRun = options.dryRun === true;
  const homePath = io.coodraHome ?? resolveCoodraHome();
  // Resolve the SAME project root `coodra init` used — init walks up from
  // cwd to the nearest marker (`.git` / `package.json` / …) and writes
  // `.mcp.json`, `.cursor/mcp.json`, `CLAUDE.md`, `.codex/config.toml`
  // there. Uninstall previously used the raw `process.cwd()`, so running
  // it from a subdirectory inspected a DIFFERENT `.cursor/mcp.json` and
  // truthfully reported "no coodra entry to remove" while the real entry
  // persisted (field bug 2026-07-12). An explicit `io.cwd` (tests /
  // scripting) is honoured verbatim.
  const cwd = io.cwd ?? (await detectProjectRoot(process.cwd())).root;
  const bridgePort = io.bridgePort ?? 3101;
  const removeData = options.removeData === true;

  const steps: UninstallStepResult[] = [];

  // Step 0: stop + uninstall every daemon unit BEFORE touching config or
  // data. This is what makes `coodra uninstall` actually tear the system
  // down — pre-2026-07-18 it never called the daemon manager, so the web
  // daemon kept holding port 3001 after "uninstall". Running it first also
  // releases the SQLite store so a later `--remove-data` / `--purge` never
  // deletes `data.db` out from under an open WAL handle.
  await stopAndUninstallDaemons({ io, homePath, dryRun, steps });

  // Step 1: ~/.claude/settings.json
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

  // Step 2: <cwd>/.mcp.json
  try {
    const result = await removeMcpJson({ cwd, dryRun });
    steps.push({ step: 'mcp-json', action: String(result.action), notes: result.notes ?? '' });
  } catch (err) {
    steps.push({
      step: 'mcp-json',
      action: 'failed',
      notes: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 2b: reverse the per-agent writes for Codex, Windsurf, Cursor,
  // and Claude's CLAUDE.md (the `~/.claude/settings.json` reverse runs
  // in Step 2 above). Each is idempotent: a no-op when the entry/block
  // isn't present, so running uninstall on a partial install is
  // harmless. Best-effort per step — one failure doesn't block the
  // rest (same as every other uninstall step).
  for (const [step, fn] of [
    ['claude-md', () => removeInstructionBlock({ cwd, filename: 'CLAUDE.md', dryRun })],
    ['cursor-mcp', () => removeCursorMcpConfig({ cwd, dryRun })],
    ['cursor-rules', () => removeInstructionBlock({ cwd, filename: '.cursorrules', dryRun })],
    ['codex-config', () => removeCodexConfig({ cwd, dryRun })],
    ['codex-agents-md', () => removeInstructionBlock({ cwd, filename: 'AGENTS.md', dryRun })],
    ['windsurf-mcp', () => removeWindsurfMcpConfig({ dryRun })],
    ['windsurf-rules', () => removeInstructionBlock({ cwd, filename: '.windsurfrules', dryRun })],
  ] as const) {
    try {
      const result = await fn();
      steps.push({ step, action: String(result.action), notes: result.notes ?? '' });
    } catch (err) {
      steps.push({ step, action: 'failed', notes: err instanceof Error ? err.message : String(err) });
    }
  }

  // Step 3: ~/.coodra/ purge (only on --purge)
  if (purge) {
    try {
      try {
        await stat(homePath);
      } catch {
        steps.push({ step: 'purge-home', action: 'unchanged', notes: `${homePath} does not exist` });
      }
      if (!dryRun) {
        await rm(homePath, { recursive: true, force: true });
      }
      steps.push({
        step: 'purge-home',
        action: dryRun ? 'unchanged' : 'merged',
        notes: dryRun ? `dry-run: would remove ${homePath}` : `removed ${homePath}`,
      });
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
      ? [`${homePath}/config.json`, 'docs/feature-packs/', 'docs/context-packs/']
      : [`${homePath}/data.db`, `${homePath}/config.json`, 'docs/feature-packs/', 'docs/context-packs/'];

  if (json) {
    const payload: UninstallJson = {
      ok: true,
      purged: purge,
      projectRoot: cwd,
      steps,
      preserved,
      npmUninstallCommand,
    };
    io.writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    io.writeStdout(`${pc.green('✓')} coodra uninstall ${dryRun ? '(dry-run) ' : ''}complete:\n`);
    io.writeStdout(`  ${pc.gray(`project root: ${cwd}`)}\n`);
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
    if (options.skipNpmHint !== true) {
      io.writeStdout(
        `\n  ${pc.cyan('Final step:')} run ${pc.bold(npmUninstallCommand)} to remove the @coodra/cli binary.\n`,
      );
    }
  }
  io.exit(EXIT_OK);
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
