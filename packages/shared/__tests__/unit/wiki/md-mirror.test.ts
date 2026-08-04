import { describe, expect, it } from 'vitest';

import { parseWikiPageFrontmatter, scoreWikiCorpus, type WikiScorableEntry } from '../../../src/wiki/md-mirror.js';

describe('parseWikiPageFrontmatter', () => {
  it('round-trips a well-formed frontmatter + body', () => {
    const raw = ['---', 'type: wiki-page', 'pageId: mcp-server', 'title: MCP Server', '---', '', 'The body.'].join(
      '\n',
    );
    const { frontmatter, body } = parseWikiPageFrontmatter(raw);
    expect(frontmatter).toEqual({ type: 'wiki-page', pageId: 'mcp-server', title: 'MCP Server' });
    expect(body.trim()).toBe('The body.');
  });

  it('degrades gracefully (frontmatter: null) when there is no opening fence', () => {
    const raw = '# Just a heading\n\nNo frontmatter here.';
    const { frontmatter, body } = parseWikiPageFrontmatter(raw);
    expect(frontmatter).toBeNull();
    expect(body).toBe(raw);
  });

  it('degrades gracefully when the frontmatter block is never closed', () => {
    const raw = '---\ntitle: Oops\n\nNo closing fence.';
    const { frontmatter } = parseWikiPageFrontmatter(raw);
    expect(frontmatter).toBeNull();
  });

  it('degrades gracefully on invalid YAML instead of throwing', () => {
    const raw = '---\ntitle: [unterminated\n---\nbody';
    expect(() => parseWikiPageFrontmatter(raw)).not.toThrow();
    expect(parseWikiPageFrontmatter(raw).frontmatter).toBeNull();
  });

  it('degrades gracefully when the frontmatter is not a YAML mapping', () => {
    const raw = '---\n- just\n- a\n- list\n---\nbody';
    const { frontmatter } = parseWikiPageFrontmatter(raw);
    expect(frontmatter).toBeNull();
  });
});

describe('scoreWikiCorpus', () => {
  const entries: WikiScorableEntry[] = [
    {
      pageId: 'retries',
      title: 'Retry policy',
      description: 'How retries are configured.',
      body: 'Retry retry retry — the retry policy uses cockatiel with exponential backoff.',
    },
    {
      pageId: 'storage',
      title: 'Storage layout',
      description: 'Where files live on disk.',
      body: 'Storage briefly mentions retry once in passing.',
    },
    {
      pageId: 'unrelated',
      title: 'Unrelated page',
      description: 'Nothing to do with the query.',
      body: 'Completely unrelated content.',
    },
  ];

  it('ranks the denser title/body match first', () => {
    const results = scoreWikiCorpus(entries, 'retry');
    expect(results.map((r) => r.pageId)).toEqual(['retries', 'storage']);
    const [first, second] = results;
    expect(first?.score).toBeGreaterThan(second?.score ?? Number.NaN);
  });

  it('uses OR semantics with a coverage bonus, not strict AND', () => {
    // "storage" only appears on the storage page, "retry" appears on both —
    // a strict-AND scorer would return zero hits for "storage cockatiel"
    // (no single page has both words), but OR-with-bonus should still
    // surface the best partial match.
    const results = scoreWikiCorpus(entries, 'storage cockatiel');
    expect(results.length).toBeGreaterThan(0);
    expect(results.map((r) => r.pageId)).toContain('storage');
  });

  it('a page matching more distinct query terms outranks a single-term match with a similar raw count', () => {
    const twoTermEntries: WikiScorableEntry[] = [
      { pageId: 'both', title: 'x', description: 'alpha beta', body: '' },
      { pageId: 'one', title: 'x', description: 'alpha alpha', body: '' },
    ];
    const results = scoreWikiCorpus(twoTermEntries, 'alpha beta');
    expect(results[0]?.pageId).toBe('both');
  });

  it('extracts an excerpt around the first matched term in the body', () => {
    const results = scoreWikiCorpus(entries, 'cockatiel');
    expect(results[0]?.excerpt).toContain('cockatiel');
  });

  it('falls back to description, then body head, when there is no body match', () => {
    const noBodyMatch: WikiScorableEntry[] = [
      { pageId: 'p', title: 'widget rollout', description: 'a widget page', body: 'unrelated body text' },
    ];
    const results = scoreWikiCorpus(noBodyMatch, 'widget');
    expect(results[0]?.excerpt.length).toBeGreaterThan(0);
  });

  it('respects the limit option', () => {
    const results = scoreWikiCorpus(entries, 'retry storage unrelated', { limit: 1 });
    expect(results).toHaveLength(1);
  });

  it('returns [] for an empty query', () => {
    expect(scoreWikiCorpus(entries, '')).toEqual([]);
    expect(scoreWikiCorpus(entries, '   ')).toEqual([]);
  });

  it('returns [] when nothing matches', () => {
    expect(scoreWikiCorpus(entries, 'zzzznomatchzzzz')).toEqual([]);
  });

  it('matching is case-insensitive', () => {
    const results = scoreWikiCorpus(entries, 'RETRY');
    expect(results.map((r) => r.pageId)).toContain('retries');
  });
});
