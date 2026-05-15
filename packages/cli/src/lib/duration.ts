/**
 * `packages/cli/src/lib/duration` — pure parser for human-readable
 * duration strings used by `coodra pause --expires-in <duration>`
 * (M08b S3) and `coodra logs --since <duration>` (M08b S4).
 *
 * Grammar (case-insensitive):
 *
 *   duration   := part+
 *   part       := integer unit
 *   unit       := 's' | 'sec' | 'm' | 'min' | 'h' | 'hr' | 'd' | 'day' | 'w' | 'wk'
 *
 * Whitespace is allowed between parts but not within a part. Examples:
 *
 *   "5m"       → 5 minutes
 *   "1h"       → 60 minutes
 *   "24h"      → 1 day
 *   "7d"       → 7 days
 *   "1d6h"     → 30 hours
 *   "1d 6h"    → 30 hours
 *   "0s"       → 0
 *
 * The function throws on any invalid input — there is NO fallback to
 * 0, no silent skip of unknown units, no negative numbers. Callers
 * (the CLI commands) catch and surface a remediation message.
 *
 * Pure: no I/O, no clock dependency. Returns ms.
 */

const UNIT_TO_MS: ReadonlyMap<string, number> = new Map([
  ['s', 1_000],
  ['sec', 1_000],
  ['secs', 1_000],
  ['second', 1_000],
  ['seconds', 1_000],
  ['m', 60_000],
  ['min', 60_000],
  ['mins', 60_000],
  ['minute', 60_000],
  ['minutes', 60_000],
  ['h', 3_600_000],
  ['hr', 3_600_000],
  ['hrs', 3_600_000],
  ['hour', 3_600_000],
  ['hours', 3_600_000],
  ['d', 86_400_000],
  ['day', 86_400_000],
  ['days', 86_400_000],
  ['w', 604_800_000],
  ['wk', 604_800_000],
  ['week', 604_800_000],
  ['weeks', 604_800_000],
]);

const PART_PATTERN = /^(\d+)([a-zA-Z]+)$/;

export interface ParsedDuration {
  readonly ms: number;
}

export class DurationParseError extends Error {
  readonly code: 'empty' | 'no_match' | 'unknown_unit' | 'overflow';
  constructor(code: 'empty' | 'no_match' | 'unknown_unit' | 'overflow', message: string) {
    super(message);
    this.name = 'DurationParseError';
    this.code = code;
  }
}

export function parseDuration(input: string): ParsedDuration {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new DurationParseError('empty', `duration string is empty (expected e.g. "5m", "1h", "7d", "1d6h")`);
  }

  // Split on whitespace OR on the boundary between a unit letter and a digit
  // (so "1d6h" parses the same as "1d 6h").
  const collapsed = trimmed.toLowerCase().replace(/\s+/g, '');
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < collapsed.length) {
    const slice = collapsed.slice(cursor);
    const match = slice.match(/^(\d+)([a-z]+)/);
    if (!match || match[0].length === 0) {
      throw new DurationParseError(
        'no_match',
        `duration parse failed at position ${cursor} of "${input}" (expected <integer><unit>; example: "5m" or "1d6h")`,
      );
    }
    parts.push(match[0]);
    cursor += match[0].length;
  }
  if (parts.length === 0) {
    throw new DurationParseError('no_match', `duration "${input}" did not parse to any <integer><unit> parts`);
  }

  let totalMs = 0;
  for (const part of parts) {
    const matched = part.match(PART_PATTERN);
    if (!matched) {
      throw new DurationParseError('no_match', `duration part "${part}" is not <integer><unit>`);
    }
    const intStr = matched[1];
    const unit = matched[2];
    if (intStr === undefined || unit === undefined) {
      throw new DurationParseError('no_match', `duration part "${part}" is not <integer><unit>`);
    }
    const unitMs = UNIT_TO_MS.get(unit);
    if (unitMs === undefined) {
      throw new DurationParseError(
        'unknown_unit',
        `unknown duration unit "${unit}" in "${input}" (allowed: s/sec, m/min, h/hr, d/day, w/wk)`,
      );
    }
    const n = Number(intStr);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new DurationParseError(
        'overflow',
        `duration integer "${intStr}" in "${input}" is not a non-negative safe integer`,
      );
    }
    const partMs = n * unitMs;
    if (!Number.isSafeInteger(partMs)) {
      throw new DurationParseError('overflow', `duration part "${part}" overflows safe-integer range`);
    }
    totalMs += partMs;
    if (!Number.isSafeInteger(totalMs)) {
      throw new DurationParseError('overflow', `duration "${input}" overflows safe-integer range when summing parts`);
    }
  }
  return { ms: totalMs };
}
