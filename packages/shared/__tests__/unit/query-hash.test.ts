import { describe, expect, it } from 'vitest';

import { hashQueryText, queryHashForTool } from '../../src/query-hash.js';

/**
 * COOD-102 — the diagnostic the PRD specified and nothing ever wrote.
 *
 * Without a query hash, `/memory` can report that the wiki returned
 * nothing 40 times but not whether that is 40 different questions or the
 * same one asked 40 times. Those have opposite fixes: broad gaps mean
 * the wiki is thin, one repeated question means there is a single hole
 * someone keeps walking into. Only the second is directly actionable and
 * it was completely invisible.
 */

describe('hashQueryText', () => {
  it('is stable for the same text', () => {
    expect(hashQueryText('where is the outbox worker?')).toBe(hashQueryText('where is the outbox worker?'));
  });

  it('groups the same question typed differently', () => {
    // The point: repeats must land in one family or the metric cannot
    // distinguish "one hole" from "many".
    const base = hashQueryText('Where is the outbox worker?');
    expect(hashQueryText('  where is the   outbox worker?  ')).toBe(base);
    expect(hashQueryText('WHERE IS THE OUTBOX WORKER?')).toBe(base);
  });

  it('keeps genuinely different questions apart', () => {
    // Normalisation stops at whitespace and case on purpose. Stemming or
    // stopword removal would merge distinct questions with no way to
    // tell afterwards that it happened.
    expect(hashQueryText('where is the outbox worker')).not.toBe(hashQueryText('where is the rollup worker'));
    expect(hashQueryText('is the graph fresh')).not.toBe(hashQueryText('is the graph stale'));
  });

  it('returns null rather than hashing nothing', () => {
    // A hash of the empty string is a real hex value that would look
    // like a question family in the data.
    expect(hashQueryText('')).toBeNull();
    expect(hashQueryText('   ')).toBeNull();
    expect(hashQueryText(undefined)).toBeNull();
    expect(hashQueryText(null)).toBeNull();
    expect(hashQueryText(42)).toBeNull();
  });

  it('emits a hex sha-256, never the text', () => {
    const hash = hashQueryText('secret question about the auth token');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('auth');
  });
});

describe('queryHashForTool', () => {
  it('reads the question field each tool actually uses', () => {
    expect(queryHashForTool('search_packs_nl', { query: 'outbox' })).toBe(hashQueryText('outbox'));
    expect(queryHashForTool('wiki_ask', { question: 'how does sync work' })).toBe(hashQueryText('how does sync work'));
    expect(queryHashForTool('query_decisions', { query: 'storage' })).toBe(hashQueryText('storage'));
    expect(queryHashForTool('query_decisions_by_file', { filePath: 'src/a.ts' })).toBe(hashQueryText('src/a.ts'));
  });

  it('returns null for tools that carry no question', () => {
    // read_context_pack takes an id, not a question. Hashing an id would
    // add a diagnostic saying nothing the memory_id column does not
    // already say in the clear, while implying the id was sensitive.
    expect(queryHashForTool('read_context_pack', { packId: 'cp_1' })).toBeNull();
    expect(queryHashForTool('list_recipes', {})).toBeNull();
    expect(queryHashForTool('not_a_tool', { query: 'x' })).toBeNull();
  });

  it('survives junk input rather than throwing on the hot path', () => {
    // This runs inside a fire-and-forget recorder; a throw here would be
    // a telemetry bug taking out a successful tool call.
    expect(queryHashForTool('search_packs_nl', null)).toBeNull();
    expect(queryHashForTool('search_packs_nl', 'a string')).toBeNull();
    expect(queryHashForTool('search_packs_nl', ['q'])).toBeNull();
    expect(queryHashForTool('search_packs_nl', { query: 123 })).toBeNull();
  });
});
