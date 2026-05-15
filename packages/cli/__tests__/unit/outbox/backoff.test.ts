import { describe, expect, it } from 'vitest';

import {
  computeBackoff,
  MAX_ATTEMPTS_DEFAULT,
  RETRY_DELAYS_MS,
  shouldGiveUp,
} from '../../../src/lib/outbox/backoff.js';

/**
 * Locks the OQ3-approved retry schedule (Module 03.1, 2026-04-27).
 * Any change to this curve must be paired with an update to the
 * doctor dead-letter check (S4) thresholds and the Module 03.1
 * spec.
 */
describe('@coodra/cli outbox/backoff', () => {
  it('encodes the 1s/5s/30s/5min/30min schedule and 6 max attempts', () => {
    expect(RETRY_DELAYS_MS).toEqual([1_000, 5_000, 30_000, 5 * 60_000, 30 * 60_000]);
    expect(MAX_ATTEMPTS_DEFAULT).toBe(6);
    expect(computeBackoff(1)).toBe(1_000);
    expect(computeBackoff(2)).toBe(5_000);
    expect(computeBackoff(3)).toBe(30_000);
    expect(computeBackoff(4)).toBe(5 * 60_000);
    expect(computeBackoff(5)).toBe(30 * 60_000);
  });

  it('shouldGiveUp returns true at or past maxAttempts', () => {
    expect(shouldGiveUp(5)).toBe(false);
    expect(shouldGiveUp(6)).toBe(true);
    expect(shouldGiveUp(7)).toBe(true);
    // Custom cap honoured.
    expect(shouldGiveUp(2, 3)).toBe(false);
    expect(shouldGiveUp(3, 3)).toBe(true);
  });

  it('computeBackoff is monotonically non-decreasing across the schedule and rejects out-of-range', () => {
    let prev = -1;
    for (let attempts = 1; attempts <= RETRY_DELAYS_MS.length; attempts += 1) {
      const delay = computeBackoff(attempts);
      expect(delay).toBeGreaterThanOrEqual(prev);
      prev = delay;
    }
    expect(() => computeBackoff(0)).toThrow(/attempts must be >= 1/);
    expect(() => computeBackoff(RETRY_DELAYS_MS.length + 1)).toThrow(/no backoff defined/);
  });
});
