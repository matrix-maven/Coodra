import { type DoctorReport, runDoctorReport } from '@coodra/contextos-cli/lib/doctor';

/**
 * `apps/web/lib/queries/doctor.ts` — server-only thin wrapper around
 * the CLI doctor library promotion (M04 Phase 2 S8).
 *
 * Why a wrapper rather than calling `runDoctorReport` directly: it
 * pins the `cwd` to the project root so every web caller produces a
 * deterministic report scoped to the repo the dev server is running
 * from. A future refinement (per the spec) is per-project scoping
 * via `projectScoped: true, slug` — the doctor checks themselves
 * don't yet honour a project-scope filter, so for now both the
 * `/projects/[slug]/doctor` page and the project-home tile run the
 * same essential set against the same cwd.
 */

export type DoctorScope = 'essential' | 'full';

export async function getDoctorReport(scope: DoctorScope = 'essential'): Promise<DoctorReport> {
  return runDoctorReport({ essential: scope === 'essential' });
}

export interface DoctorTileSummary {
  readonly ok: number;
  readonly warn: number;
  readonly fail: number;
  readonly skipped: number;
  readonly total: number;
}

export function summarizeReport(report: DoctorReport): DoctorTileSummary {
  return {
    ...report.summary,
    total: report.checks.length,
  };
}

export type { DoctorReport };
