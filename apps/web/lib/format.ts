/**
 * Pure formatting helpers — used by server + client components alike.
 * No DOM dependencies; safe in Server Components.
 */

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/**
 * Renders a Date as a relative time vs `now` ("2 minutes ago", "in 3 days").
 * Uses native `Intl.RelativeTimeFormat`. Defaults to seconds for very small
 * deltas; falls back to absolute ISO string for deltas > 30 days.
 */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return RTF.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return RTF.format(minutes, 'minute');
  const hours = Math.round(seconds / 3600);
  if (Math.abs(hours) < 24) return RTF.format(hours, 'hour');
  const days = Math.round(seconds / 86_400);
  if (Math.abs(days) < 30) return RTF.format(days, 'day');
  // Beyond 30 days: render an absolute date for clarity.
  return date.toISOString().slice(0, 10);
}

/**
 * Renders an ISO timestamp as "HH:mm:ss" if the date is on `now`'s
 * calendar day, otherwise "YYYY-MM-DD HH:mm". Used in run-list tables
 * where same-day runs read tighter and prior-day runs need disambiguation.
 */
export function compactTimestamp(date: Date, now: Date = new Date()): string {
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) {
    return date.toISOString().slice(11, 19);
  }
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`;
}

/**
 * Renders the duration between `start` and `end` as a compact string
 * ("1.2s", "47s", "12m 34s", "2h 18m"). Used in run detail "running for"
 * and "ended in" affordances.
 */
export function compactDuration(startMs: number, endMs: number): string {
  const ms = Math.max(0, endMs - startMs);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${remMin}m`;
}
