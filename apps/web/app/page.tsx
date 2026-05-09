import { ProjectsHub, type SystemStatus } from '@/components/ProjectsHub';
import { getDoctorReport } from '@/lib/queries/doctor';
import { fetchPickerSnapshot } from '@/lib/queries/picker';

/**
 * `/` — Project picker hub. Server fetches the picker snapshot + the
 * doctor report (for the "All systems operational" pill) and hands
 * the combined data to the client-side <ProjectsHub /> shell, which
 * owns the search/sort/filter UX.
 */

export const dynamic = 'force-dynamic';

export default async function ProjectPickerPage() {
  const [snapshot, doctorReport] = await Promise.all([fetchPickerSnapshot(), safeDoctor()]);

  const systemStatus = deriveSystemStatus(doctorReport);

  return (
    <ProjectsHub
      projects={snapshot.projects}
      mode={snapshot.mode}
      fetchedAt={snapshot.fetchedAt}
      systemStatus={systemStatus}
    />
  );
}

async function safeDoctor() {
  try {
    return await getDoctorReport('essential');
  } catch {
    return null;
  }
}

function deriveSystemStatus(report: Awaited<ReturnType<typeof getDoctorReport>> | null): SystemStatus {
  if (report === null) {
    return { tone: 'warning', label: 'Status unknown', hint: 'Doctor report could not run' };
  }
  const total = report.checks.length;
  const { ok, warn, fail } = report.summary;
  if (fail > 0) {
    return {
      tone: 'error',
      label: `${fail} check${fail === 1 ? '' : 's'} failing`,
      hint: `${ok}/${total} green · ${warn} yellow · ${fail} red`,
    };
  }
  if (warn > 0) {
    return {
      tone: 'warning',
      label: `${warn} warning${warn === 1 ? '' : 's'}`,
      hint: `${ok}/${total} green · ${warn} yellow`,
    };
  }
  return { tone: 'success', label: 'All systems operational', hint: `${ok}/${total} doctor checks green` };
}
