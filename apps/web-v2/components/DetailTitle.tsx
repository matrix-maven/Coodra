/**
 * Proportionate `<h1>` for detail pages (`/decisions/[id]`,
 * `/context-packs/[id]`, ...) showing arbitrary-length user content — a
 * decision description or a pack title. `.head__title` (88px, defined for
 * the short editorial taglines on list pages, e.g. "Every decision,
 * recorded.") reads as a broken hero page once the content is a full
 * sentence instead of a few words.
 */
export function DetailTitle({ children }: { children: React.ReactNode }) {
  return (
    <h1
      style={{
        fontFamily: 'var(--serif)',
        fontSize: 30,
        lineHeight: 1.3,
        fontWeight: 400,
        letterSpacing: '-0.01em',
        maxWidth: 820,
        margin: 0,
      }}
    >
      {children}
    </h1>
  );
}
