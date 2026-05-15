import { describe, expect, it } from 'vitest';
import { buildCheckContext } from '../../../src/doctor/context.js';
import { exitCodeForReport, runChecks } from '../../../src/doctor/run.js';
import type { Check, CheckContext, CheckResult } from '../../../src/doctor/types.js';

function fakeContext(overrides: Partial<CheckContext> = {}): CheckContext {
  return { ...buildCheckContext({ env: {}, coodraHomeOverride: '/tmp/__doctor-test__' }), ...overrides };
}

const greenCheck = (id: number): Check => ({
  id,
  name: `green-${id}`,
  severity: 'red',
  async run() {
    return { status: 'green' };
  },
});
const yellowCheck = (id: number): Check => ({
  id,
  name: `yellow-${id}`,
  severity: 'yellow',
  async run() {
    return { status: 'yellow', detail: 'warn', remediation: 'fix it' };
  },
});
const redCheck = (id: number): Check => ({
  id,
  name: `red-${id}`,
  severity: 'red',
  async run() {
    return { status: 'red', detail: 'broken', remediation: 'fix it' };
  },
});
const throwingCheck = (id: number): Check => ({
  id,
  name: `throws-${id}`,
  severity: 'red',
  async run() {
    throw new Error('boom');
  },
});
const slowCheck = (id: number, ms: number): Check => ({
  id,
  name: `slow-${id}`,
  severity: 'red',
  async run() {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { status: 'green' } as CheckResult;
  },
});

describe('runChecks', () => {
  it('preserves registry order in the report', async () => {
    const checks = [greenCheck(1), yellowCheck(2), redCheck(3)];
    const report = await runChecks(checks, fakeContext());
    expect(report.checks.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it('summarises ok/warn/fail/skipped correctly', async () => {
    const checks = [greenCheck(1), greenCheck(2), yellowCheck(3), redCheck(4), throwingCheck(5)];
    const report = await runChecks(checks, fakeContext());
    expect(report.summary).toEqual({ ok: 2, warn: 1, fail: 2, skipped: 0 });
  });

  it('converts thrown errors into red CheckRunResults', async () => {
    const report = await runChecks([throwingCheck(99)], fakeContext());
    expect(report.checks[0]?.status).toBe('red');
    expect(report.checks[0]?.detail).toBe('boom');
  });

  it('marks slow checks as timeout and counts them in fail', async () => {
    const ctx = fakeContext({ timeoutMs: 50 });
    const report = await runChecks([slowCheck(1, 200)], ctx);
    expect(report.checks[0]?.status).toBe('timeout');
    expect(report.summary.fail).toBe(1);
  });
});

describe('exitCodeForReport', () => {
  it('returns 2 when there are reds', () => {
    const report = {
      version: 'x',
      coodraHome: '/x',
      cwd: '/x',
      checks: [],
      summary: { ok: 0, warn: 1, fail: 1, skipped: 0 },
    };
    expect(exitCodeForReport(report)).toBe(2);
  });
  it('returns 1 when there are yellows but no reds', () => {
    const report = {
      version: 'x',
      coodraHome: '/x',
      cwd: '/x',
      checks: [],
      summary: { ok: 5, warn: 1, fail: 0, skipped: 0 },
    };
    expect(exitCodeForReport(report)).toBe(1);
  });
  it('returns 0 when all green', () => {
    const report = {
      version: 'x',
      coodraHome: '/x',
      cwd: '/x',
      checks: [],
      summary: { ok: 5, warn: 0, fail: 0, skipped: 2 },
    };
    expect(exitCodeForReport(report)).toBe(0);
  });
});
