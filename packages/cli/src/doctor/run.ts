import { VERSION } from '../version.js';
import type { Check, CheckContext, CheckRunResult, CheckStatus, DoctorReport } from './types.js';

/**
 * Runs every registered check in parallel with a per-check timeout.
 *
 * - Checks that throw resolve as `red` with the error message in `detail`.
 * - Checks that exceed `context.timeoutMs` resolve as `timeout` (counted as
 *   `fail` in the summary — a check too slow to answer is a check that
 *   cannot certify the invariant).
 * - The order of `CheckRunResult[]` in the report matches the order of
 *   `checks` in the registry, regardless of completion order.
 */
export async function runChecks(checks: readonly Check[], context: CheckContext): Promise<DoctorReport> {
  const results = await Promise.all(checks.map((check) => runOne(check, context)));

  const summary = {
    ok: results.filter((r) => r.status === 'green').length,
    warn: results.filter((r) => r.status === 'yellow').length,
    fail: results.filter((r) => r.status === 'red' || r.status === 'timeout').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
  };

  return {
    version: VERSION,
    coodraHome: context.coodraHome,
    cwd: context.cwd,
    checks: results,
    summary,
  };
}

async function runOne(check: Check, context: CheckContext): Promise<CheckRunResult> {
  const started = Date.now();
  const timeoutMs = context.timeoutMs;
  let status: CheckStatus = 'red';
  let detail: string | undefined;
  let remediation: string | undefined;

  try {
    const result = await Promise.race([check.run(context), timeoutPromise(timeoutMs)]);
    status = result.status;
    detail = result.detail;
    remediation = result.remediation;
  } catch (err) {
    if (err instanceof TimeoutError) {
      status = 'timeout';
      detail = `Check exceeded ${timeoutMs}ms`;
      remediation = 'Re-run with `--timeout-ms` set higher, or investigate why the underlying probe is slow.';
    } else {
      status = 'red';
      detail = err instanceof Error ? err.message : String(err);
      remediation = 'Check threw — file an issue with the detail above.';
    }
  }

  return {
    id: check.id,
    name: check.name,
    severity: check.severity,
    status,
    ...(detail !== undefined ? { detail } : {}),
    ...(remediation !== undefined ? { remediation } : {}),
    durationMs: Date.now() - started,
  };
}

class TimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Check timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

function timeoutPromise(timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs).unref();
  });
}

/**
 * Convert a report into the exit-code contract per spec §4.5:
 *   - any `red` or `timeout` → 2
 *   - any `yellow` (and no reds) → 1
 *   - all `green`/`skipped` → 0
 */
export function exitCodeForReport(report: DoctorReport): 0 | 1 | 2 {
  if (report.summary.fail > 0) return 2;
  if (report.summary.warn > 0) return 1;
  return 0;
}
