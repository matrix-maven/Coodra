/**
 * Turns a raw, untrusted search string into a safe SQLite FTS5 MATCH
 * query. FTS5's MATCH syntax has meaningful special characters (`"`,
 * `*`, `AND`, `OR`, `NOT`, `-`, parens) that would otherwise let
 * arbitrary agent/user input change query semantics or throw a syntax
 * error. Each whitespace-separated token is individually wrapped in
 * double quotes (FTS5 phrase-token syntax, immune to operator
 * interpretation), with any literal `"` in the token escaped by
 * doubling it per FTS5 convention, then joined with explicit `AND` —
 * every term must appear, closest match to a natural "search box" feel
 * without introducing prefix/boolean operators the caller didn't ask for.
 *
 * Postgres doesn't need an equivalent helper: `plainto_tsquery('english', ...)`
 * already takes a plain string and ANDs its terms safely with no
 * caller-side escaping required.
 */
export function toSqliteFtsQuery(raw: string): string {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replace(/"/g, '""')}"`);
  return tokens.length > 0 ? tokens.join(' AND ') : '""';
}
