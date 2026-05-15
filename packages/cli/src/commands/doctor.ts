import { listProjects } from '@coodra/db';
import { buildCheckContext } from '../doctor/context.js';
import { formatHuman, formatJson } from '../doctor/output.js';
import { ALL_CHECKS, ESSENTIAL_CHECKS } from '../doctor/registry.js';
import { exitCodeForReport, runChecks } from '../doctor/run.js';
import { resolveCoodraDataDb, resolveCoodraHome } from '../lib/coodra-home.js';
import { openLocalDb } from '../lib/open-local-db.js';
import { scanProjectEnvForStaleMode, stripStaleModeFromProjectEnv } from '../lib/project-env-scan.js';
import { checkGlyph, hintLine, paint, style } from '../ui/index.js';

export interface DoctorOptions {
  readonly json?: boolean;
  readonly timeoutMs?: string;
  /**
   * Run every check in the registry, not just the 9 essentials.
   * Decision dec_83ba10c1 (2026-05-02). Default false — `coodra
   * doctor` runs the trimmed essential surface and `--full` opts in
   * to debug / team-mode / outbox observability checks.
   */
  readonly full?: boolean;
  /**
   * After running checks, repair safe drift conditions. Currently:
   * strip stale `COODRA_MODE` lines from every registered
   * project's `.env` file (Phase A, clarity-pass-plan 2026-05-11).
   *
   * Idempotent — re-running on an already-clean machine reports
   * "no drift detected" and exits 0. Touches `<projectCwd>/.env`
   * only; never modifies `~/.coodra/.env` or `<cwd>/.coodra.json`.
   */
  readonly fix?: boolean;
}

interface FixReport {
  readonly scanned: number;
  readonly stripped: ReadonlyArray<{
    readonly cwd: string;
    readonly envPath: string;
    readonly removedLines: readonly string[];
  }>;
  readonly skippedMissing: ReadonlyArray<string>;
}

export interface DoctorIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_DOCTOR_IO: DoctorIO = {
  writeStdout: (chunk) => {
    process.stdout.write(chunk);
  },
  writeStderr: (chunk) => {
    process.stderr.write(chunk);
  },
  exit: (code) => {
    // Slice 5 (2026-05-03 audit §14.1): set exitCode + drain stdout
    // BEFORE calling process.exit. Node's process.exit is synchronous
    // and cuts off any in-flight stdout writes when stdout is piped
    // (e.g. when execa or another parent captures the output). The
    // doctor's --full JSON exceeded the default pipe buffer somewhere
    // around 8KB and was being truncated mid-stream in the integration
    // test. Setting exitCode and ending stdout cleanly fixes the leak.
    process.exitCode = code;
    if (process.stdout.writableLength > 0) {
      // Wait for the pipe to drain, then exit. Cast through never for
      // the function-signature contract.
      process.stdout.once('drain', () => process.exit(code));
      // Belt-and-suspenders: if the drain event takes too long, force-
      // exit anyway so tests don't hang.
      setTimeout(() => process.exit(code), 100).unref();
      return undefined as never;
    }
    process.exit(code);
  },
};

export async function runDoctorCommand(options: DoctorOptions = {}, io: DoctorIO = DEFAULT_DOCTOR_IO): Promise<never> {
  const timeoutMs = parseTimeout(options.timeoutMs);
  const ctx = buildCheckContext({ timeoutMs });
  const checks = options.full === true ? ALL_CHECKS : ESSENTIAL_CHECKS;
  const report = await runChecks(checks, ctx);
  const exit = exitCodeForReport(report);

  let fixReport: FixReport | null = null;
  if (options.fix === true) {
    fixReport = await runFixPass();
  }

  if (options.json === true) {
    const merged = fixReport === null ? report : { ...report, fix: fixReport };
    io.writeStdout(`${formatJson(merged)}\n`);
  } else {
    io.writeStdout(`${formatHuman(report)}\n`);
    if (options.full !== true) {
      io.writeStdout(
        `${hintLine(`(${ESSENTIAL_CHECKS.length} essential checks shown. Run \`coodra doctor --full\` for the complete ${ALL_CHECKS.length}-check registry.)`)}\n`,
      );
    }
    if (fixReport !== null) {
      io.writeStdout(formatFixReportHuman(fixReport));
    }
    if (exit === 2) {
      io.writeStderr(`${paint.crimson('doctor: red findings present — fix the items above before continuing.')}\n`);
    }
  }
  return io.exit(exit);
}

/**
 * Phase A — `--fix` pass. Read-mostly: opens the local SQLite DB,
 * iterates every registered project, scans `<cwd>/.env` for stale
 * `COODRA_MODE` lines, and strips them. Idempotent — a project
 * with no stale line contributes a clean entry; nothing is rewritten.
 *
 * Why scope this narrow: the project `.env` `COODRA_MODE` line is
 * the single best-known drift condition (pre-Phase-A, it silently
 * demoted team-mode machines to solo via `loadHomeEnv`; the Phase A
 * carve-out neutralised the runtime effect but the stale line itself
 * remains misleading documentation). Other drift conditions (e.g.
 * mismatched LOCAL_HOOK_SECRET between config.json and home .env)
 * are surfaced by check 36 as warnings but NOT auto-fixed by --fix —
 * those require regenerating a secret which is a destructive
 * operation that belongs in `team setup` / `team join` proper.
 */
async function runFixPass(): Promise<FixReport> {
  const home = resolveCoodraHome();
  const dataDb = resolveCoodraDataDb(home);
  let handle: Awaited<ReturnType<typeof openLocalDb>>;
  try {
    handle = await openLocalDb(dataDb);
  } catch {
    // Data DB missing / unreadable — nothing to scan. Treat as clean.
    return { scanned: 0, stripped: [], skippedMissing: [] };
  }
  try {
    const projects = await listProjects(handle);
    const stripped: Array<{ cwd: string; envPath: string; removedLines: readonly string[] }> = [];
    const skippedMissing: string[] = [];
    let scanned = 0;
    for (const p of projects) {
      if (p.cwd === null) continue; // pre-0010 rows have no cwd; skip silently
      scanned += 1;
      const scan = scanProjectEnvForStaleMode(p.cwd);
      if (!scan.exists) {
        // Most projects don't have a per-project .env at all — that's
        // the clean state. Don't surface as drift.
        continue;
      }
      if (scan.staleModeValue === null) {
        // .env exists but has no COODRA_MODE line — clean.
        continue;
      }
      const result = stripStaleModeFromProjectEnv(scan.envPath);
      if (result.stripped) {
        stripped.push({ cwd: p.cwd, envPath: scan.envPath, removedLines: result.removedLines });
      } else {
        // Shouldn't happen — staleModeValue!=null implies stripped.
        // Surface as a skipped-missing for diagnostics.
        skippedMissing.push(scan.envPath);
      }
    }
    return { scanned, stripped, skippedMissing };
  } finally {
    handle.close();
  }
}

function formatFixReportHuman(fix: FixReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(style.bold(paint.ink('--fix pass')));
  if (fix.scanned === 0) {
    lines.push(`  ${paint.inkFar('No registered projects with a recorded cwd — nothing to scan.')}`);
    lines.push('');
    return `${lines.join('\n')}\n`;
  }
  if (fix.stripped.length === 0) {
    lines.push(`  ${checkGlyph('ok')} Scanned ${fix.scanned} project(s). No stale COODRA_MODE lines found.`);
    lines.push('');
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    `  ${paint.blue('✎')} Scanned ${fix.scanned} project(s); stripped stale COODRA_MODE from ${fix.stripped.length}:`,
  );
  for (const s of fix.stripped) {
    lines.push(`    ${paint.inkFar('-')} ${paint.inkDim(s.envPath)}`);
    for (const removed of s.removedLines) {
      lines.push(`      ${paint.inkFar('removed:')} ${paint.inkFar(removed)}`);
    }
  }
  if (fix.skippedMissing.length > 0) {
    lines.push(
      `  ${checkGlyph('warn')} ${fix.skippedMissing.length} file(s) reported drift but could not be rewritten:`,
    );
    for (const path of fix.skippedMissing) lines.push(`    ${paint.inkFar('-')} ${paint.inkDim(path)}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return 2000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 2000;
  return parsed;
}
