/**
 * `apps/web/components/ui/StatusDot.tsx` — colored circle indicator.
 *
 * Two variants: a bare dot (decorative, sits beside text) and an
 * inline pill ({ label } prop) where the dot + label form a single
 * accessible chip. Used everywhere a status needs a quick glance:
 * doctor checks, sync queue, project picker rows.
 */

export type StatusTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

export interface StatusDotProps {
  readonly tone: StatusTone;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly label?: string;
  readonly title?: string;
}

const TONE_BG: Record<StatusTone, string> = {
  success: 'bg-status-success',
  warning: 'bg-status-warning',
  error: 'bg-status-error',
  info: 'bg-status-info',
  neutral: 'bg-text-muted',
};

const SIZE_CLASS: Record<NonNullable<StatusDotProps['size']>, string> = {
  sm: 'h-1.5 w-1.5',
  md: 'h-2 w-2',
  lg: 'h-2.5 w-2.5',
};

export function StatusDot({ tone, size = 'md', label, title }: StatusDotProps) {
  const dot = (
    <span
      aria-hidden={label === undefined ? 'true' : undefined}
      title={label === undefined ? title : undefined}
      className={`inline-block shrink-0 rounded-full ${SIZE_CLASS[size]} ${TONE_BG[tone]}`}
    />
  );
  if (label === undefined) return dot;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
      {dot}
      <span className="font-mono">{label}</span>
    </span>
  );
}
