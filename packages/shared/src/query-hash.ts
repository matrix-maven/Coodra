import { createHash } from 'node:crypto';

/**
 * `@coodra/shared/query-hash` — COOD-102.
 *
 * The PRD specified `query_hash` / `trigger_text_hash` as "hashed by
 * default (§9)" and the columns shipped, but nothing ever wrote them.
 * So `/memory` could count that the wiki returned nothing 40 times and
 * had no way to tell whether that was 40 different questions or the same
 * one asked 40 times — which is the difference between "the wiki has
 * broad gaps" and "the wiki has ONE gap someone keeps walking into".
 * Only the second is directly fixable, and it was invisible.
 *
 * ## Normalisation
 *
 * Trim, collapse internal whitespace, lowercase. Enough that the same
 * question typed twice with different spacing or capitalisation lands in
 * one family, and deliberately no more: stemming or stopword removal
 * would merge genuinely different questions and there is no way to tell
 * afterwards that it happened.
 *
 * ## What hashing does and does not buy
 *
 * Stated plainly because "hashed" invites more confidence than it earns.
 * A SHA-256 of a short question is NOT anonymisation against someone who
 * can guess the question — they can hash their guess and compare. What
 * it does prevent is casual disclosure and bulk reading: nobody browsing
 * the table learns what anyone asked, and an exported rollup carries no
 * prose. That is the property §9 wants, and it is the reason plaintext
 * capture stays an explicit opt-in rather than the default.
 */

/** Hex SHA-256 of the normalised text; null when there is nothing to hash. */
export function hashQueryText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const normalized = text.trim().replace(/\s+/g, ' ').toLowerCase();
  if (normalized.length === 0) return null;
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * The input field that represents "what was asked" for each pull tool.
 *
 * Adapter-shaped, matching `PULL_ADAPTERS`: only fields that carry a
 * QUESTION are listed. Ids and slugs are deliberately absent — hashing
 * `packId` would produce a diagnostic that says nothing the `memory_id`
 * column does not already say in the clear, while implying the id was
 * sensitive enough to hide.
 */
const QUERY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  search_packs_nl: ['query'],
  wiki_ask: ['question'],
  query_decisions: ['query'],
  query_decisions_by_file: ['filePath'],
};

/** Extract and hash the question a pull tool was given, if it has one. */
export function queryHashForTool(toolName: string, input: unknown): string | null {
  const fields = QUERY_FIELDS[toolName];
  if (fields === undefined) return null;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const field of fields) {
    const hash = hashQueryText(record[field]);
    if (hash !== null) return hash;
  }
  return null;
}
