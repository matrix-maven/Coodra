/**
 * `apps/web/components/ui/StatusDot.tsx` — colored circle indicator
 * (M04 Phase 2 UI).
 *
 * Replaces the 4 hand-rolled "colored span" implementations across
 * doctor, workspace settings, project picker (ProjectCard), sync, and
 * project home. One palette, three sizes, optional inline label.
 *
 * The `tone` prop maps to brand status colors. The optional `label`
 * makes the dot self-describing for screen readers — when omitted the
 * dot becomes purely decorative (aria-hidden) and the surrounding
 * text owns the semantics.
 */

export type StatusTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

export interface StatusDotProps {
  readonly tone: StatusTone;
  readonly size?: 'sm' | 'md' | 'lg';
  /** When set, renders the dot + the label inline; the label is the accessible name. */
  readonly label?: string;
  /** When set without a label, applies as the title attribute (tooltip). */
  readonly title?: string;
}

const TONE_BG: Record<StatusTone, string> = {
  success: 'bg-(--color-status-success)',
  warning: 'bg-(--color-status-warning)',
  error: 'bg-(--color-status-error)',
  info: 'bg-(--color-status-info)',
  neutral: 'bg-(--color-text-tertiary)',
};

const SIZE_CLASS: Record<NonNullable<StatusDotProps['size']>, string> = {
  sm: 'h-2 w-2',
  md: 'h-3 w-3',
  lg: 'h-4 w-4',
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
    <span className="inline-flex items-center gap-2">
      {dot}
      <span className="font-mono text-xs text-(--color-text-secondary)">{label}</span>
    </span>
  );
}
