import { describe, expect, it } from 'vitest';

import { fmtClockSec } from '../../../lib/format';

describe('fmtClockSec', () => {
  const now = new Date('2026-08-08T14:00:00');

  it('omits the date for a timestamp from the same day as now', () => {
    const sameDay = new Date('2026-08-08T09:11:06');
    expect(fmtClockSec(sameDay, now)).toBe('09:11:06');
  });

  it('includes the date for a timestamp from a prior day — the bug this fixes', () => {
    // Reproduces the exact confusion this was found from: a run resumed
    // across days showed only "19:11:06" with no date, reading as
    // "just now" instead of "2 days ago".
    const twoDaysAgo = new Date('2026-08-06T19:11:06');
    expect(fmtClockSec(twoDaysAgo, now)).toBe('2026-08-06 19:11:06');
  });

  it('includes the date for a future-dated timestamp too (not just past)', () => {
    const tomorrow = new Date('2026-08-09T08:00:00');
    expect(fmtClockSec(tomorrow, now)).toBe('2026-08-09 08:00:00');
  });

  it('returns an em dash for null', () => {
    expect(fmtClockSec(null, now)).toBe('—');
  });

  it('accepts an ISO string same as a Date', () => {
    expect(fmtClockSec('2026-08-08T09:11:06', now)).toBe('09:11:06');
  });
});
