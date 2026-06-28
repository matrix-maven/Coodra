import { describe, expect, it } from 'vitest';

import { DEFAULT_ROI_CONSTANTS } from '../../../src/roi/constants.js';
import {
  buildMethodology,
  computeRoi,
  computeRoiBand,
  estimateTokensFromChars,
  type RoiMeasuredInputs,
  scaleConstantsForScenario,
} from '../../../src/roi/model.js';

const INPUTS: RoiMeasuredInputs = {
  totalRuns: 10,
  completedRuns: 8,
  toolCalls: 100,
  reuseReads: 5,
  assetsAuthored: 4,
  governedActions: 200,
  blockedActions: 2,
  assetContentChars: 40_000,
};

describe('estimateTokensFromChars', () => {
  it('divides chars by the configured ratio', () => {
    expect(estimateTokensFromChars(40_000, 4)).toBe(10_000);
  });
  it('returns 0 for non-positive or non-finite input', () => {
    expect(estimateTokensFromChars(0, 4)).toBe(0);
    expect(estimateTokensFromChars(-100, 4)).toBe(0);
    expect(estimateTokensFromChars(Number.NaN, 4)).toBe(0);
  });
  it('never divides by less than 1', () => {
    expect(estimateTokensFromChars(100, 0)).toBe(100);
  });
});

describe('computeRoi — base scenario (opus defaults)', () => {
  const r = computeRoi(INPUTS, DEFAULT_ROI_CONSTANTS);

  it('computes the compression token lever: runs × (discovery − injected)', () => {
    // 10 × (12000 − 4000) = 80000
    expect(r.tokensSaved.compression).toBe(80_000);
  });
  it('computes the reuse token lever: reuseReads × rederivation', () => {
    // 5 × 6000 = 30000
    expect(r.tokensSaved.reuse).toBe(30_000);
  });
  it('computes the net cache token lever (read discount − write premium)', () => {
    // cachedTurns = 100 − 10 = 90; gross = 90×4000×0.9 = 324000;
    // writePenalty = 10×4000×0.25 = 10000; net = 314000
    expect(r.tokensSaved.cache).toBe(314_000);
  });
  it('computes the loop-prevention token lever: blocks × tokens/loop', () => {
    // 2 × 40000 = 80000
    expect(r.tokensSaved.loopPrevented).toBe(80_000);
  });
  it('sums total tokens saved', () => {
    expect(r.tokensSaved.total).toBe(80_000 + 30_000 + 314_000 + 80_000);
  });

  it('prices credits at the opus input rate ($5/MTok)', () => {
    expect(r.creditsSavedUsd.compression).toBeCloseTo(0.4, 6);
    expect(r.creditsSavedUsd.reuse).toBeCloseTo(0.15, 6);
    expect(r.creditsSavedUsd.cache).toBeCloseTo(1.57, 6);
    expect(r.creditsSavedUsd.loopPrevented).toBeCloseTo(0.4, 6);
    expect(r.creditsSavedUsd.total).toBeCloseTo(2.52, 6);
  });

  it('computes time reclaimed from Parnin minutes × DX hourly', () => {
    // (5×12 + 2×15)/60 = 1.5h × $78 = $117
    expect(r.timeReclaimed.minutes).toBe(90);
    expect(r.timeReclaimed.hours).toBeCloseTo(1.5, 6);
    expect(r.timeReclaimed.usd).toBeCloseTo(117, 6);
  });

  it('computes the authoring investment denominator', () => {
    // 4 × 6 / 60 = 0.4h × $78 = $31.2
    expect(r.investment.authoringHours).toBeCloseTo(0.4, 6);
    expect(r.investment.authoringUsd).toBeCloseTo(31.2, 6);
  });

  it('estimates knowledge captured tokens from content chars', () => {
    expect(r.knowledgeCapturedTokens).toBe(10_000);
  });

  it('rolls up the ROI primitives (net value, BCR, ROI%)', () => {
    expect(r.totalBenefitUsd).toBeCloseTo(119.52, 6); // 2.52 + 117
    expect(r.netValueUsd).toBeCloseTo(88.32, 6); // 119.52 − 31.2
    expect(r.benefitCostRatio).toBeCloseTo(119.52 / 31.2, 6);
    expect(r.roiPct).toBeCloseTo((88.32 / 31.2) * 100, 6);
  });
});

describe('computeRoi — guards', () => {
  it('returns null BCR/ROI% when there is no authoring investment', () => {
    const r = computeRoi({ ...INPUTS, assetsAuthored: 0 }, DEFAULT_ROI_CONSTANTS);
    expect(r.investment.authoringUsd).toBe(0);
    expect(r.benefitCostRatio).toBeNull();
    expect(r.roiPct).toBeNull();
  });
  it('returns null knowledgeCapturedTokens when content size is omitted', () => {
    const { assetContentChars: _omit, ...withoutChars } = INPUTS;
    const r = computeRoi(withoutChars, DEFAULT_ROI_CONSTANTS);
    expect(r.knowledgeCapturedTokens).toBeNull();
  });
  it('never produces negative token levers', () => {
    // toolCalls < runs → cachedTurns clamps to 0; discovery < injected clamps compression to 0.
    const r = computeRoi(
      { ...INPUTS, toolCalls: 0, totalRuns: 5 },
      { ...DEFAULT_ROI_CONSTANTS, baselineDiscoveryTokensPerSession: 1_000, injectedPrefixTokens: 4_000 },
    );
    expect(r.tokensSaved.compression).toBe(0);
    expect(r.tokensSaved.cache).toBe(0);
    expect(r.tokensSaved.total).toBeGreaterThanOrEqual(0);
  });
});

describe('computeRoiBand — conservative ≤ base ≤ optimistic', () => {
  const band = computeRoiBand(INPUTS, DEFAULT_ROI_CONSTANTS);
  it('orders net value monotonically across scenarios', () => {
    expect(band.conservative.netValueUsd).toBeLessThan(band.base.netValueUsd);
    expect(band.base.netValueUsd).toBeLessThan(band.optimistic.netValueUsd);
  });
  it('keeps the cost denominator fixed across scenarios (cost-side not scaled)', () => {
    expect(band.conservative.investment.authoringUsd).toBeCloseTo(band.optimistic.investment.authoringUsd, 6);
  });
  it('echoes the inputs + base constants used', () => {
    expect(band.inputs).toEqual(INPUTS);
    expect(band.constants).toEqual(DEFAULT_ROI_CONSTANTS);
  });
});

describe('scaleConstantsForScenario', () => {
  it('halves benefit levers for conservative, leaves cost levers untouched', () => {
    const c = scaleConstantsForScenario(DEFAULT_ROI_CONSTANTS, 'conservative');
    expect(c.baselineDiscoveryTokensPerSession).toBe(6_000);
    expect(c.rederivationTokensPerReuse).toBe(3_000);
    expect(c.minutesReclaimedPerReuse).toBe(6);
    // cost-side untouched:
    expect(c.minutesPerAssetAuthored).toBe(DEFAULT_ROI_CONSTANTS.minutesPerAssetAuthored);
    expect(c.injectedPrefixTokens).toBe(DEFAULT_ROI_CONSTANTS.injectedPrefixTokens);
    expect(c.blendedHourlyUsd).toBe(DEFAULT_ROI_CONSTANTS.blendedHourlyUsd);
  });
});

describe('buildMethodology', () => {
  const r = computeRoi(INPUTS, DEFAULT_ROI_CONSTANTS);
  const rows = buildMethodology(INPUTS, DEFAULT_ROI_CONSTANTS, r);
  it('produces a row per lever with a formula and a source', () => {
    const ids = rows.map((row) => row.id);
    expect(ids).toEqual(
      expect.arrayContaining(['pricing', 'compression', 'reuse', 'cache', 'loop', 'time', 'investment']),
    );
    for (const row of rows) {
      expect(row.formula.length).toBeGreaterThan(0);
      expect(row.source.length).toBeGreaterThan(0);
      expect(['high', 'medium', 'low']).toContain(row.confidence);
    }
  });
});
