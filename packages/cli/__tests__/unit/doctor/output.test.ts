import { describe, expect, it } from 'vitest';
import { formatHuman, formatJson } from '../../../src/doctor/output.js';
import type { DoctorReport } from '../../../src/doctor/types.js';

const sampleReport: DoctorReport = {
  version: '0.0.0-test',
  coodraHome: '/tmp/coodra',
  cwd: '/tmp/work/myapp',
  checks: [
    { id: 1, name: 'Node', severity: 'red', status: 'green', durationMs: 5 },
    {
      id: 2,
      name: 'Bridge',
      severity: 'yellow',
      status: 'yellow',
      detail: 'down',
      remediation: 'start it',
      durationMs: 12,
    },
    { id: 3, name: 'Mig', severity: 'red', status: 'red', detail: 'behind', remediation: 'init', durationMs: 8 },
  ],
  summary: { ok: 1, warn: 1, fail: 1, skipped: 0 },
};

/** Strip ANSI so assertions read the visible content regardless of colour TTY state. */
function plain(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR escapes.
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('formatHuman', () => {
  it('includes the design-system title, per-check lines, remediations, and a summary bar', () => {
    const out = plain(formatHuman(sampleReport));
    // command title carries the version; header rows carry home + cwd.
    expect(out).toContain('Doctor');
    expect(out).toContain('@coodra/cli 0.0.0-test');
    expect(out).toContain('/tmp/coodra');
    expect(out).toContain('/tmp/work/myapp');
    // each check renders by id + name.
    expect(out).toMatch(/1\s+Node/);
    expect(out).toMatch(/2\s+Bridge/);
    expect(out).toMatch(/3\s+Mig/);
    // non-green checks surface their remediation as a faint sub-line.
    expect(out).toContain('fix: start it');
    expect(out).toContain('fix: init');
    // summary bar reports the tallies.
    expect(out).toContain('1 ok');
    expect(out).toContain('1 warn');
    expect(out).toContain('1 fail');
  });
});

describe('formatJson', () => {
  it('emits a structured object that round-trips JSON.parse', () => {
    const json = formatJson(sampleReport);
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe('0.0.0-test');
    expect(parsed.checks).toHaveLength(3);
    expect(parsed.summary.fail).toBe(1);
  });
});
