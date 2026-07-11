import { rm, stat } from 'node:fs/promises';
import { EXIT_OK } from '../exit-codes.js';
import { resolveCoodraHome } from '../lib/coodra-home.js';
import { detectProjectRoot } from '../lib/detect.js';
import { removeClaudeSettings } from '../lib/init/claude-settings-merge.js';
import { removeCodexConfig } from '../lib/init/codex-merge.js';
import { removeCursorMcpConfig } from '../lib/init/cursor-merge.js';
import { removeInstructionBlock } from '../lib/init/instruction-files.js';
import { removeMcpJson } from '../lib/init/mcp-merge.js';
import { removeWindsurfMcpConfig } from '../lib/init/windsurf-merge.js';
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
 *   1. Drop `__coodra__`-matcher / URL-owned entries from
 *      `~/.claude/settings.json`.
 *   2. Drop the `coodra` server from `<cwd>/.mcp.json`.
 *   3. With `--purge`: remove `~/.coodra/` entirely.
 *   4. Always: print the `npm uninstall -g @coodra/cli`
 *      command.
 *
 * Idempotent: re-running on a clean install (no coodra entries
 * anywhere) is exit-0 with "nothing to remove" notes for each step.
 *
 * NOT removed (default-safe): `~/.coodra/data.db`,
 * `~/.coodra/config.json`, every `docs/feature-packs/<slug>/`,
 * every `docs/context-packs/`. The user can re-run `coodra init`
 * after `npm i -g` and pick up where they left off.
 */

export interface UninstallOptions {
  readonly purge?: boolean;
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

  const steps: UninstallStepResult[] = [];

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

  const npmUninstallCommand = 'npm uninstall -g @coodra/cli';
  const preserved = purge
    ? []
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
