import Link from 'next/link';

/**
 * 404 page. Renders for both the runtime "not found" thrown from a
 * route handler AND for routes that 404 in solo mode (e.g. /auth/* and
 * /settings/team per OQ-3 + spec §9).
 */
export default function NotFound() {
  const mode = process.env.CONTEXTOS_MODE ?? 'solo';
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
      <div className="font-display text-6xl font-black tracking-tight text-(--color-text-primary)">404</div>
      <div className="h-px w-16 bg-(--color-border-default)" />
      <p className="font-display text-lg font-light uppercase tracking-wider text-(--color-text-secondary)">
        Not found{mode === 'solo' ? ' in solo mode' : ''}.
      </p>
      <Link
        href="/"
        className="font-display text-sm font-bold uppercase tracking-wider text-(--color-brand) hover:text-(--color-brand-hover)"
      >
        ◂ Return to dashboard
      </Link>
    </div>
  );
}
