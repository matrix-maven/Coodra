/**
 * `packages/cli/src/lib/doctor/index.ts` — library promotion of the
 * doctor registry + runner for in-process consumption by the web app
 * (M04 Phase 2 S8).
 *
 * The CLI command (`coodra doctor [--full]`) remains the single
 * source of truth for the check definitions; this surface re-exports
 * the same helpers behind a stable, ESM-friendly path so the web's
 * Server Components can render a doctor report without spawning a
 * subprocess.
 *
 * Intentional shape:
 *   - `runDoctorReport(opts)` is the only function callers need. It
 *     wraps `buildCheckContext` + `runChecks` and returns the full
 *     `DoctorReport`.
 *   - `essential` opt selects ESSENTIAL_CHECKS (M04 Phase 2 default —
 *     the 11 install-gate invariants); when omitted defaults to true.
 *   - The full registry is opt-in via `essential: false`; the web
 *     surface exposes both via a query-string toggle.
 */

import { type BuildCheckContextOptions, buildCheckContext } from '../../doctor/context.js';
import { ALL_CHECKS, ESSENTIAL_CHECKS } from '../../doctor/registry.js';
import { runChecks } from '../../doctor/run.js';
import type { DoctorReport } from '../../doctor/types.js';

export type {
  Check,
  CheckRunResult,
  CheckSeverity,
  CheckStatus,
  DoctorReport,
} from '../../doctor/types.js';

export interface RunDoctorReportOptions extends BuildCheckContextOptions {
  /** When true (default) runs only ESSENTIAL_CHECKS; false runs the full registry. */
  readonly essential?: boolean;
}

export async function runDoctorReport(options: RunDoctorReportOptions = {}): Promise<DoctorReport> {
  const { essential = true, ...contextOptions } = options;
  const ctx = buildCheckContext(contextOptions);
  const checks = essential ? ESSENTIAL_CHECKS : ALL_CHECKS;
  return runChecks(checks, ctx);
}

export const ESSENTIAL_CHECK_COUNT = ESSENTIAL_CHECKS.length;
export const ALL_CHECK_COUNT = ALL_CHECKS.length;
