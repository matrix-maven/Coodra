import { compactTimestamp, relativeTime } from '@/lib/format';

/**
 * Renders a Date as a relative-time caption with the absolute ISO
 * timestamp on hover. Server-rendered by default — `now` is computed
 * at render time on the server. The hover title is a native `title=`
 * attribute so it's accessible without JS and doesn't ship a tooltip
 * library.
 */
export interface RelativeTimeProps {
  readonly date: Date;
  readonly mode?: 'relative' | 'compact';
}

export function RelativeTime({ date, mode = 'relative' }: RelativeTimeProps) {
  const display = mode === 'compact' ? compactTimestamp(date) : relativeTime(date);
  return (
    <time dateTime={date.toISOString()} title={date.toISOString()} className="font-mono">
      {display}
    </time>
  );
}
