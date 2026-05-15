/**
 * `src/doctor/output.ts` — human + JSON renderers for the doctor report.
 *
 * The human renderer speaks the Coodra terminal design system
 * (`src/ui/`): a command title, a styled check list where each row
 * carries a tone glyph, faint `↳` sub-detail lines, and a summary bar.
 * The doctor's checks are a flat registry, so this is a styled flat
 * list rather than `/NN` sections — the visual language is the design
 * system; the structure stays true to the registry.
 */

import {
  type CheckTone,
  checkGlyph,
  commandTitle,
  kvRow,
  noteLine,
  paint,
  rule,
  style,
  summaryBar,
  terminalWidth,
} from '../ui/index.js';
import type { CheckRunResult, CheckStatus, DoctorReport } from './types.js';

const STATUS_TONE: Record<CheckStatus, CheckTone> = {
  green: 'ok',
  yellow: 'warn',
  red: 'fail',
  timeout: 'timeout',
  skipped: 'skip',
};

export function formatHuman(report: DoctorReport): string {
  const width = terminalWidth();
  const lines: string[] = [];

  lines.push(commandTitle('Doctor', `health report · @coodra/cli ${report.version}`, { width, indent: 0 }));
  lines.push(kvRow({ key: 'coodra home', value: report.coodraHome }, { keyWidth: 16 }));
  lines.push(kvRow({ key: 'cwd', value: report.cwd }, { keyWidth: 16 }));
  lines.push('');

  for (const check of report.checks) {
    lines.push(formatCheckLine(check));
    if (check.detail !== undefined && check.status !== 'green') {
      lines.push(`     ${noteLine(check.detail)}`);
    }
    if (check.remediation !== undefined && check.status !== 'green') {
      lines.push(`     ${noteLine(`fix: ${check.remediation}`)}`);
    }
  }

  lines.push('');
  lines.push(rule({ width }));
  lines.push(
    summaryBar([
      { text: `${report.summary.ok} ok`, tone: 'phosphor', bold: true },
      { text: `${report.summary.warn} warn`, tone: 'amber' },
      { text: `${report.summary.fail} fail`, tone: 'crimson' },
      { text: `${report.summary.skipped} skipped`, tone: 'inkFar' },
    ]),
  );
  return lines.join('\n');
}

function formatCheckLine(check: CheckRunResult): string {
  const tone = STATUS_TONE[check.status];
  const glyph = checkGlyph(tone);
  const id = paint.inkFar(String(check.id).padStart(2, ' '));
  // Green checks recede (faint name); anything that needs attention is
  // bright ink so the eye lands on it.
  const name = check.status === 'green' ? paint.inkDim(check.name) : style.bold(paint.ink(check.name));
  return `${glyph}  ${id}  ${name}`;
}

export function formatJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}
