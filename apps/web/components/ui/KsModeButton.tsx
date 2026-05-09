import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * `apps/web/components/ui/KsModeButton.tsx` — three-up mode selector.
 *
 * Used for kill-switch mode (Soft / Hard / Read-only) and settings
 * mode (Solo / Team / Org). Active state lifts to phosphor border +
 * soft phosphor fill. Disabled state dims the chip.
 *
 * Use `<em>...</em>` inside `title` for italic phosphor emphasis.
 */

export interface KsModeButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'> {
  readonly title: ReactNode;
  readonly sub: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
}

export function KsModeButton({ title, sub, active = false, disabled = false, className, ...rest }: KsModeButtonProps) {
  const stateClass = active
    ? 'border-accent bg-accent-glow'
    : disabled
      ? 'border-rule-strong opacity-50 cursor-not-allowed'
      : 'border-rule-strong hover:border-text-primary';
  return (
    <button
      type="button"
      disabled={disabled}
      className={`flex flex-col items-center gap-1.5 border bg-transparent px-3 py-4 text-center transition-colors duration-200 ${stateClass}${
        className !== undefined ? ` ${className}` : ''
      }`}
      aria-pressed={active}
      {...rest}
    >
      <span className="heading-display text-[22px] text-text-primary">{title}</span>
      <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-text-muted">{sub}</span>
    </button>
  );
}
