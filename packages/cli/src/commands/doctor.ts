import { stat } from 'node:fs/promises';
import { ensureDefaultPolicy, listProjects } from '@coodra/db';
import { buildCheckContext } from '../doctor/context.js';
import { formatHuman, formatJson } from '../doctor/output.js';
import { ALL_CHECKS, ESSENTIAL_CHECKS } from '../doctor/registry.js';
import { exitCodeForReport, runChecks } from '../doctor/run.js';
import { resolveCoodraDataDb, resolveCoodraHome } from '../lib/coodra-home.js';
import { openLocalDb } from '../lib/open-local-db.js';
import { scanProjectEnvForStaleMode, stripStaleModeFromProjectEnv } from '../lib/project-env-scan.js';
import { ensureProjectConfig, legacyConfigPath, projectConfigPath } from '../lib/project-store/index.js';
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
  readonly policy: PolicyBackfillReport;
  readonly configMigration: ConfigMigrationReport;
}

/**
 * Migration report for the project-local `.coodra/config.json` heal
 * (Phase 2). Projects wired before the new identity file existed carry only
 * the legacy `.coodra.json`; `doctor --fix` creates `.coodra/config.json`
 * beside it. Only projects that already have a legacy `.coodra.json` on disk
 * (i.e. real wired project dirs) are touched.
 */
interface ConfigMigrationReport {
  readonly migrated: ReadonlyArray<{ readonly slug: string; readonly cwd: string }>;
  readonly failed: ReadonlyArray<{ readonly slug: string; readonly cwd: string; readonly error: string }>;
}

/**
 * Backfill report for the default-policy heal (2026-07-18). A project
 * row with no `__default__` policy is fail-open — the MCP `check_policy`
 * evaluator returns `allow` for every tool because no rule matches. This
 * pass seeds/repairs the baseline policy for EVERY registered project so
 * `coodra doctor --fix` heals machines whose projects were minted by an
 * older `get_run_id`/bridge auto-create (which did not seed a policy).
 * `ensureDefaultPolicy` is idempotent + additive, so re-running is safe.
 */
interface PolicyBackfillReport {
  readonly scanned: number;
  /** Projects that had no `__default__` policy — a fresh one was inserted. */
  readonly seeded: ReadonlyArray<{ readonly slug: string; readonly projectId: string }>;
  /** Projects that had `__default__` but were missing baseline rules — rules added. */
  readonly repaired: ReadonlyArray<{
    readonly slug: string;
    readonly projectId: string;
    readonly rulesInserted: number;
  }>;
  /** Projects whose seed threw (logged, non-fatal). */
  readonly failed: ReadonlyArray<{ readonly slug: string; readonly projectId: string; readonly error: string }>;
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
    return {
      scanned: 0,
      stripped: [],
      skippedMissing: [],
      policy: emptyPolicyBackfill(),
      configMigration: { migrated: [], failed: [] },
    };
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
    const policy = await backfillDefaultPolicies(handle, projects);
    const configMigration = await migrateProjectConfigs(projects);
    return { scanned, stripped, skippedMissing, policy, configMigration };
  } finally {
    handle.close();
  }
}

/**
 * Create `.coodra/config.json` for every registered project that still has
 * only the legacy `.coodra.json`. Idempotent — projects already carrying the
 * new file (or without a legacy file on disk, i.e. not a wired project dir)
 * are skipped. Best-effort per project.
 */
async function migrateProjectConfigs(
  projects: Awaited<ReturnType<typeof listProjects>>,
): Promise<ConfigMigrationReport> {
  const migrated: Array<{ slug: string; cwd: string }> = [];
  const failed: Array<{ slug: string; cwd: string; error: string }> = [];
  for (const p of projects) {
    if (p.cwd === null) continue;
    if (await pathExists(projectConfigPath(p.cwd))) continue; // already migrated
    if (!(await pathExists(legacyConfigPath(p.cwd)))) continue; // not a wired project dir
    try {
      await ensureProjectConfig({ root: p.cwd, projectSlug: p.slug, force: false, dryRun: false });
      migrated.push({ slug: p.slug, cwd: p.cwd });
    } catch (err) {
      failed.push({ slug: p.slug, cwd: p.cwd, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { migrated, failed };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function emptyPolicyBackfill(): PolicyBackfillReport {
  return { scanned: 0, seeded: [], repaired: [], failed: [] };
}

/**
 * Seed/repair the `__default__` policy for every registered project.
 * This is the productized heal for the fail-open gap: projects minted by
 * an older `get_run_id`/bridge auto-create carry no policy, so the
 * evaluator waved through every tool call. Unlike the env-strip pass
 * above, this covers projects with a null `cwd` too (policy is keyed on
 * projectId, not the filesystem). Best-effort per project — one seed
 * failure is recorded and the loop continues.
 */
export async function backfillDefaultPolicies(
  handle: Awaited<ReturnType<typeof openLocalDb>>,
  projects: Awaited<ReturnType<typeof listProjects>>,
): Promise<PolicyBackfillReport> {
  const seeded: Array<{ slug: string; projectId: string }> = [];
  const repaired: Array<{ slug: string; projectId: string; rulesInserted: number }> = [];
  const failed: Array<{ slug: string; projectId: string; error: string }> = [];
  for (const p of projects) {
    // The `__global__` sentinel is infrastructure, not an agent-facing
    // project — it never runs agents, so it needs no enforcement policy.
    if (p.slug === '__global__') continue;
    try {
      const result = await ensureDefaultPolicy(handle, p.id);
      if (result.created) {
        seeded.push({ slug: p.slug, projectId: p.id });
      } else if (result.rulesInserted > 0) {
        repaired.push({ slug: p.slug, projectId: p.id, rulesInserted: result.rulesInserted });
      }
    } catch (err) {
      failed.push({ slug: p.slug, projectId: p.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { scanned: projects.length, seeded, repaired, failed };
}

function formatFixReportHuman(fix: FixReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(style.bold(paint.ink('--fix pass')));

  // Section 1: stale COODRA_MODE strip (env drift).
  if (fix.scanned === 0) {
    lines.push(`  ${paint.inkFar('No registered projects with a recorded cwd — nothing to scan.')}`);
  } else if (fix.stripped.length === 0) {
    lines.push(`  ${checkGlyph('ok')} Scanned ${fix.scanned} project(s). No stale COODRA_MODE lines found.`);
  } else {
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
  }

  // Section 2: default-policy backfill (fail-open heal, 2026-07-18).
  const pol = fix.policy;
  const healed = pol.seeded.length + pol.repaired.length;
  if (pol.scanned === 0) {
    // no-op — no projects to seed; env section already covered the empty case
  } else if (healed === 0 && pol.failed.length === 0) {
    lines.push(`  ${checkGlyph('ok')} Default policy present on all ${pol.scanned} project(s) — enforcement is live.`);
  } else {
    if (pol.seeded.length > 0) {
      lines.push(
        `  ${paint.blue('✎')} Seeded a default policy on ${pol.seeded.length} fail-open project(s) (were unguarded):`,
      );
      for (const s of pol.seeded) lines.push(`    ${paint.inkFar('-')} ${paint.inkDim(s.slug)}`);
    }
    if (pol.repaired.length > 0) {
      lines.push(`  ${paint.blue('✎')} Repaired missing baseline rules on ${pol.repaired.length} project(s):`);
      for (const r of pol.repaired) {
        lines.push(`    ${paint.inkFar('-')} ${paint.inkDim(r.slug)} ${paint.inkFar(`(+${r.rulesInserted} rules)`)}`);
      }
    }
    if (pol.failed.length > 0) {
      lines.push(`  ${checkGlyph('warn')} ${pol.failed.length} project(s) could not be seeded:`);
      for (const f of pol.failed)
        lines.push(`    ${paint.inkFar('-')} ${paint.inkDim(f.slug)} ${paint.inkFar(f.error)}`);
    }
  }

  // Section 3: project-local .coodra/config.json migration (Phase 2).
  const cm = fix.configMigration;
  if (cm.migrated.length > 0) {
    lines.push(`  ${paint.blue('✎')} Created .coodra/config.json for ${cm.migrated.length} legacy project(s):`);
    for (const m of cm.migrated) lines.push(`    ${paint.inkFar('-')} ${paint.inkDim(m.slug)}`);
  }
  if (cm.failed.length > 0) {
    lines.push(`  ${checkGlyph('warn')} ${cm.failed.length} project(s) could not be migrated:`);
    for (const f of cm.failed) lines.push(`    ${paint.inkFar('-')} ${paint.inkDim(f.slug)} ${paint.inkFar(f.error)}`);
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
