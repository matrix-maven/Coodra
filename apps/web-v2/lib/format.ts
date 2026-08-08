/**
 * Pure formatting helpers — used by server + client components alike.
 * No DOM dependencies; safe in Server Components.
 *
 * Combines the v2 editorial helpers (fmtClock, fmtRelative, fmtShortId)
 * with the legacy ones inherited from apps/web (relativeTime,
 * compactTimestamp, compactDuration) so copied queries / actions keep
 * working without rewrites.
 */

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/* ------------------------------------------------------------------ */
/*  v2 editorial helpers                                              */
/* ------------------------------------------------------------------ */

export function fmtClock(iso: string | Date | null): string {
  if (iso === null) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Time-of-day with seconds — plus the date, when `iso` isn't from today
 * (2026-08-08: this used to always omit the date, which read as "just
 * now" for a timestamp that was actually days old — misleading on any
 * page showing rows that can span more than a day, e.g. a run resumed
 * across sessions). `now` is injectable for tests; defaults to the real
 * clock.
 */
export function fmtClockSec(iso: string | Date | null, now: Date = new Date()): string {
  if (iso === null) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const time = `${hh}:${mm}:${ss}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return time;
  const yyyy = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mo}-${dd} ${time}`;
}

export function fmtRelative(iso: string | Date | null): string {
  if (iso === null) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const diffMs = Date.now() - d.getTime();
  const sec = Math.max(0, Math.round(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

export function fmtShortId(id: string): string {
  return id.slice(0, 8);
}

/* ------------------------------------------------------------------ */
/*  Legacy helpers (kept verbatim)                                    */
/* ------------------------------------------------------------------ */

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
  return date.toISOString().slice(0, 10);
}

export function compactTimestamp(date: Date, now: Date = new Date()): string {
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) return date.toISOString().slice(11, 19);
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`;
}

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
