import { describe, expect, it } from 'vitest';

import { DurationParseError, parseDuration } from '../../../src/lib/duration.js';

/**
 * Module 08b S3 — duration parser unit tests.
 *
 * Every supported unit + composite shapes + every error code.
 * 100% line coverage on `lib/duration.ts`.
 */

describe('parseDuration', () => {
  it('Fixture 1 — single seconds: "30s" = 30_000ms', () => {
    expect(parseDuration('30s').ms).toBe(30_000);
    expect(parseDuration('30sec').ms).toBe(30_000);
    expect(parseDuration('30seconds').ms).toBe(30_000);
  });

  it('Fixture 2 — single minutes: "5m" = 300_000ms', () => {
    expect(parseDuration('5m').ms).toBe(300_000);
    expect(parseDuration('5min').ms).toBe(300_000);
    expect(parseDuration('5minutes').ms).toBe(300_000);
  });

  it('Fixture 3 — single hours: "1h" = 3_600_000ms; "24h" = 86_400_000ms', () => {
    expect(parseDuration('1h').ms).toBe(3_600_000);
    expect(parseDuration('24h').ms).toBe(86_400_000);
    expect(parseDuration('1hr').ms).toBe(3_600_000);
    expect(parseDuration('1hours').ms).toBe(3_600_000);
  });

  it('Fixture 4 — single days: "7d" = 604_800_000ms', () => {
    expect(parseDuration('7d').ms).toBe(604_800_000);
    expect(parseDuration('7day').ms).toBe(604_800_000);
    expect(parseDuration('7days').ms).toBe(604_800_000);
  });

  it('Fixture 5 — single weeks: "2w" = 1_209_600_000ms', () => {
    expect(parseDuration('2w').ms).toBe(1_209_600_000);
    expect(parseDuration('2wk').ms).toBe(1_209_600_000);
  });

  it('Fixture 6 — composite "1d6h" = 30 hours = 108_000_000ms', () => {
    expect(parseDuration('1d6h').ms).toBe(108_000_000);
    expect(parseDuration('1day6hours').ms).toBe(108_000_000);
  });

  it('Fixture 7 — composite with whitespace "1d 6h 30m" = 30.5 hours', () => {
    expect(parseDuration('1d 6h 30m').ms).toBe(108_000_000 + 30 * 60_000);
    expect(parseDuration('  1d   6h ').ms).toBe(108_000_000);
  });

  it('Fixture 8 — case-insensitive: "5M", "1H", "7D" parse identically to lowercase', () => {
    expect(parseDuration('5M').ms).toBe(300_000);
    expect(parseDuration('1H').ms).toBe(3_600_000);
    expect(parseDuration('7D').ms).toBe(604_800_000);
    expect(parseDuration('1D6H').ms).toBe(108_000_000);
  });

  it('Fixture 9 — zero is valid: "0s" = 0ms', () => {
    expect(parseDuration('0s').ms).toBe(0);
    expect(parseDuration('0d').ms).toBe(0);
  });

  it('Fixture 10 — empty/whitespace-only input throws empty error', () => {
    try {
      parseDuration('');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DurationParseError);
      expect((err as DurationParseError).code).toBe('empty');
    }
    try {
      parseDuration('   ');
      expect.fail('expected throw');
    } catch (err) {
      expect((err as DurationParseError).code).toBe('empty');
    }
  });

  it('Fixture 11 — bare integer (no unit) throws no_match', () => {
    try {
      parseDuration('123');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DurationParseError);
      expect((err as DurationParseError).code).toBe('no_match');
    }
  });

  it('Fixture 12 — unknown unit throws unknown_unit', () => {
    try {
      parseDuration('5x');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DurationParseError);
      expect((err as DurationParseError).code).toBe('unknown_unit');
      expect((err as DurationParseError).message).toContain('5x');
    }

    try {
      parseDuration('1d3y'); // y is not a unit
      expect.fail('expected throw');
    } catch (err) {
      expect((err as DurationParseError).code).toBe('unknown_unit');
    }
  });

  it('Fixture 13 — overflow throws overflow (caps near MAX_SAFE_INTEGER weeks)', () => {
    // 1e15 weeks exceeds Number.MAX_SAFE_INTEGER
    try {
      parseDuration('99999999999999999w');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DurationParseError);
      expect((err as DurationParseError).code).toBe('overflow');
    }
  });
});
