import { describe, expect, it } from 'vitest';

import { decodeVerifiedAgainstFiles, evaluateStaleness } from '../../src/memory-freshness.js';

/**
 * COOD-85 — freshness as computed state.
 *
 * COOD-58 gave decisions a supersede edge, but an edge only exists when
 * an agent volunteers one. Nothing ever checked whether a pack still
 * described how the code actually behaves — which is why packs
 * referencing `apps/hooks-bridge` stayed authoritative for weeks after
 * COOD-67 deleted it.
 *
 * The distinctions these tests lock:
 *
 *   - `unverified` is NOT `fresh`. Claiming a freshness never
 *     established is the error the field exists to prevent — the same
 *     line COOD-81 drew between `unknown` and `stale` for graph drift.
 *   - A DELETED dependency is a stronger signal than a modified one,
 *     and gardening needs to tell them apart when proposing a fix.
 *   - Staleness is not supersession. Nothing here reads or writes
 *     `decision_edges`.
 */

describe('evaluateStaleness', () => {
  it('reports unverified when there is nothing to check against', () => {
    // No recorded dependencies is not evidence of freshness.
    const result = evaluateStaleness({ verifiedAgainstFiles: [], changedFiles: ['src/a.ts'] });
    expect(result.status).toBe('unverified');
    expect(result.staleReason).toBeNull();
  });

  it('reports fresh when no dependency changed', () => {
    const result = evaluateStaleness({
      verifiedAgainstFiles: ['src/store.ts', 'src/policy.ts'],
      changedFiles: ['README.md', 'src/unrelated.ts'],
    });
    expect(result.status).toBe('fresh');
  });

  it('reports stale, naming the changed dependency', () => {
    const result = evaluateStaleness({
      verifiedAgainstFiles: ['src/store.ts'],
      changedFiles: ['src/store.ts', 'README.md'],
    });
    expect(result.status).toBe('stale');
    expect(result.staleReason).toBe('files_changed:src/store.ts');
  });

  it('distinguishes a deleted dependency from a merely changed one', () => {
    // A pack describing a file that no longer exists is a stronger
    // signal than one whose file moved on — gardening should be able to
    // propose different fixes for the two.
    const result = evaluateStaleness({
      verifiedAgainstFiles: ['apps/hooks-bridge/src/index.ts'],
      changedFiles: ['apps/hooks-bridge/src/index.ts'],
      deletedFiles: ['apps/hooks-bridge/src/index.ts'],
    });
    expect(result.status).toBe('stale');
    expect(result.staleReason).toMatch(/^files_deleted:/);
  });

  it('bounds the reason so one sprawling change cannot bloat the row', () => {
    const many = Array.from({ length: 40 }, (_v, i) => `src/f${i}.ts`);
    const result = evaluateStaleness({ verifiedAgainstFiles: many, changedFiles: many });
    expect(result.staleReason?.split(',').length).toBeLessThanOrEqual(5);
  });
});

describe('decodeVerifiedAgainstFiles', () => {
  it('round-trips a JSON string array', () => {
    expect(decodeVerifiedAgainstFiles('["a.ts","b.ts"]')).toEqual(['a.ts', 'b.ts']);
  });

  it('degrades to empty rather than throwing on malformed input', () => {
    // A corrupt column must not take down a gardening pass mid-sweep.
    expect(decodeVerifiedAgainstFiles('not json')).toEqual([]);
    expect(decodeVerifiedAgainstFiles(null)).toEqual([]);
    expect(decodeVerifiedAgainstFiles('{"not":"an array"}')).toEqual([]);
  });

  it('drops non-string entries instead of trusting them', () => {
    expect(decodeVerifiedAgainstFiles('["a.ts",42,null,"b.ts"]')).toEqual(['a.ts', 'b.ts']);
  });
});
