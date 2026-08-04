import { parse as parseYaml } from 'yaml';

/**
 * `@coodra/shared/wiki/md-mirror` — parsing + ranking over the
 * connected-Markdown corpus at `.coodra/wiki/<slug>/md/` (see
 * `packages/shared/src/wiki/paths.ts`'s `wikiMdDir`/`wikiPageMdPath`).
 *
 * `coodra wiki ask` is a pure retrieval tool — Coodra runs no LLM of its
 * own, so this never synthesizes an answer. It ranks candidate pages and
 * hands excerpts back to the calling coding agent, which reads the
 * winning files and composes the actual answer.
 *
 * `scoreWikiCorpus` is shared between two callers that produce the same
 * `WikiScorableEntry` shape from different sources: `coodra wiki ask`'s
 * local-file path (parsed frontmatter + body straight off disk) and its
 * DB-fallback path (title/description parsed out of `wikis.structureJson`,
 * body from `wikiPages.contentMarkdown`) — ranking behaves identically
 * regardless of where the corpus came from.
 *
 * No SQL engine is available over plain files, so this can't reuse the
 * SQLite FTS5/Postgres tsvector BM25 infra `search_packs_nl` uses — it's
 * a hand-rolled, dependency-free scorer instead.
 */

export interface ParsedWikiPageMd {
  readonly frontmatter: Record<string, unknown> | null;
  readonly body: string;
}

/** Length cap on the frontmatter block, mirrors `@coodra/shared/features/parse.ts`. */
const MAX_FRONTMATTER_BYTES = 32 * 1024;

/**
 * Parse a connected-Markdown wiki page into frontmatter + body. Always
 * returns a result; never throws.
 *
 * Deliberately lenient, unlike `parseFeatureMd` (which is an authoring-time
 * validation gate with a structured `errors[]`): this is a read-time
 * best-effort parse over agent-authored, non-transactional mirror files.
 * A malformed or missing frontmatter block degrades to
 * `{ frontmatter: null, body: <raw content> }` rather than failing, so
 * `wiki ask` can skip one bad file and keep ranking the rest of the
 * corpus.
 */
export function parseWikiPageFrontmatter(raw: string): ParsedWikiPageMd {
  // Strip an optional leading BOM — mirrors parseFeatureMd's handling.
  const content = raw.replace(/^﻿/, '');

  const fenceRe = /^---[ \t]*\r?\n/;
  const fenceMatch = content.match(fenceRe);
  if (fenceMatch === null) return { frontmatter: null, body: content };

  const afterOpen = content.slice(fenceMatch[0].length);
  const closeRe = /\r?\n---[ \t]*(\r?\n|$)/;
  const closeMatch = afterOpen.match(closeRe);
  if (closeMatch === null || closeMatch.index === undefined) return { frontmatter: null, body: content };

  const yamlBlock = afterOpen.slice(0, closeMatch.index);
  if (yamlBlock.length > MAX_FRONTMATTER_BYTES) return { frontmatter: null, body: content };

  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);

  let yamlValue: unknown;
  try {
    yamlValue = parseYaml(yamlBlock);
  } catch {
    return { frontmatter: null, body };
  }
  if (yamlValue === null || typeof yamlValue !== 'object' || Array.isArray(yamlValue)) {
    return { frontmatter: null, body };
  }
  return { frontmatter: yamlValue as Record<string, unknown>, body };
}

export interface WikiScorableEntry {
  readonly pageId: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
}

export interface WikiAskResult {
  readonly pageId: string;
  readonly title: string;
  readonly score: number;
  readonly excerpt: string;
}

const TITLE_WEIGHT = 5;
const DESCRIPTION_WEIGHT = 3;
const BODY_WEIGHT = 1;
const EXCERPT_RADIUS = 100;
const DEFAULT_LIMIT = 8;

function tokenize(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
  return [...new Set(tokens)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(haystack: string, token: string): number {
  if (haystack.length === 0 || token.length === 0) return 0;
  const matches = haystack.match(new RegExp(`\\b${escapeRegExp(token)}\\b`, 'gi'));
  return matches === null ? 0 : matches.length;
}

function buildExcerpt(entry: WikiScorableEntry, firstMatchIndex: number): string {
  if (firstMatchIndex >= 0) {
    const start = Math.max(0, firstMatchIndex - EXCERPT_RADIUS);
    const end = Math.min(entry.body.length, firstMatchIndex + EXCERPT_RADIUS);
    const slice = entry.body.slice(start, end).trim();
    return `${start > 0 ? '…' : ''}${slice}${end < entry.body.length ? '…' : ''}`;
  }
  if (entry.description.length > 0) return entry.description.slice(0, 200);
  return entry.body.slice(0, 200).trim();
}

/**
 * Rank `entries` against `query`, best match first.
 *
 * OR semantics with a coverage bonus, not strict AND (the opposite
 * tradeoff from `search_packs_nl`'s `toSqliteFtsQuery`, which explicitly
 * ANDs every term): `search_packs_nl` callers hand-write short deliberate
 * keywords against a large cross-project corpus, where AND avoids
 * drowning in noise. `wiki ask` questions are natural-language prose
 * ("how does the mcp server register tools?") against a small per-repo
 * corpus — requiring every token to land on one page would frequently
 * return zero hits. Any entry matching at least one token qualifies;
 * matching more of the query's distinct tokens multiplies the score up,
 * so fuller matches still outrank partial ones.
 */
export function scoreWikiCorpus(
  entries: ReadonlyArray<WikiScorableEntry>,
  query: string,
  opts?: { readonly limit?: number },
): WikiAskResult[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const limit = opts?.limit ?? DEFAULT_LIMIT;

  const results: WikiAskResult[] = [];
  for (const entry of entries) {
    let rawScore = 0;
    let distinctMatched = 0;
    let firstMatchIndex = -1;
    const lowerBody = entry.body.toLowerCase();
    for (const token of tokens) {
      const tokenScore =
        countOccurrences(entry.title, token) * TITLE_WEIGHT +
        countOccurrences(entry.description, token) * DESCRIPTION_WEIGHT +
        countOccurrences(entry.body, token) * BODY_WEIGHT;
      if (tokenScore <= 0) continue;
      distinctMatched += 1;
      rawScore += tokenScore;
      if (firstMatchIndex === -1) {
        const idx = lowerBody.indexOf(token);
        if (idx !== -1) firstMatchIndex = idx;
      }
    }
    if (rawScore <= 0) continue;
    const coverageBonus = 1 + distinctMatched / tokens.length;
    results.push({
      pageId: entry.pageId,
      title: entry.title,
      score: rawScore * coverageBonus,
      excerpt: buildExcerpt(entry, firstMatchIndex),
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
