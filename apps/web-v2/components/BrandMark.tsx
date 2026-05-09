/** ContextOS mark — circle, node, horizontal axis. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" width={size} height={size} aria-hidden="true">
      <circle cx="16" cy="16" r="14" stroke="#7dd87d" strokeWidth="1" />
      <circle cx="16" cy="16" r="2.2" fill="#7dd87d" />
      <line x1="2" y1="16" x2="30" y2="16" stroke="#e8e6e1" strokeWidth="0.6" strokeDasharray="2 3" />
    </svg>
  );
}
