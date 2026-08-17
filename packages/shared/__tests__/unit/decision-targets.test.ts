import { describe, expect, it } from 'vitest';

import { classifyImpactTarget, isElidedPath, looksLikeFilePath } from '../../src/decision-targets.js';

/**
 * COOD-90 — `impact` entries are classified, not blanket-labelled.
 *
 * The old writer stored every entry without a `graph_node:` /
 * `work_pack:` prefix as `target_type = 'file'`, so prose landed in the
 * index that COOD-86 gardening and COOD-88 teaching both read as paths.
 *
 * The asymmetry that sets the tuning: a false NEGATIVE files a real path
 * as `concept` and loses one freshness check. A false POSITIVE files
 * prose as `file` and produces a confident wrong answer about code that
 * never existed. Ambiguity must resolve toward `concept`.
 */

describe('looksLikeFilePath', () => {
  it('accepts workspace-rooted and package-relative paths', () => {
    expect(looksLikeFilePath('apps/mcp-server/src/tools/record-decision/handler.ts')).toBe(true);
    expect(looksLikeFilePath('packages/db/src/schema/sqlite.ts')).toBe(true);
    // Package-relative is genuinely ambiguous to RESOLVE, but it is
    // still a path. Resolution is the reader's problem; misfiling the
    // row would lose the information entirely.
    expect(looksLikeFilePath('src/run-diff-runner.ts')).toBe(true);
    expect(looksLikeFilePath('docs/PRD-memory-utilization.md')).toBe(true);
  });

  it('rejects the prose that actually appears in decision_edges today', () => {
    // Real target ids observed in this repo's own database.
    expect(looksLikeFilePath('identity')).toBe(false);
    expect(looksLikeFilePath('licensing')).toBe(false);
    expect(looksLikeFilePath('Navbar.tsx and the mobile drawer')).toBe(false);
  });

  it('rejects a bare filename with no separator', () => {
    // `handler.ts` names no location; a repo has many. Treating it as a
    // path invites a resolution that is right by luck or not at all.
    expect(looksLikeFilePath('handler.ts')).toBe(false);
  });

  it('rejects elisions, which are prose ABOUT a path', () => {
    expect(looksLikeFilePath('apps/.../handler.ts')).toBe(false);
    expect(looksLikeFilePath('apps/…/handler.ts')).toBe(false);
  });

  it('rejects a directory, which has no extension to end on', () => {
    expect(looksLikeFilePath('apps/mcp-server/src/tools')).toBe(false);
  });

  it('rejects a long trailing token that is not an extension', () => {
    // `.{1,6}` is the guard against sentences that happen to contain a
    // slash and a full stop.
    expect(looksLikeFilePath('see apps/foo and consider.everything')).toBe(false);
  });
});

describe('classifyImpactTarget', () => {
  it('keeps the explicit prefixes authoritative', () => {
    expect(classifyImpactTarget('graph_node:abc123')).toEqual({ targetType: 'graph_node', targetId: 'abc123' });
    expect(classifyImpactTarget('work_pack:cood-77')).toEqual({ targetType: 'work_pack', targetId: 'cood-77' });
  });

  it('classifies a path as file and prose as concept', () => {
    expect(classifyImpactTarget('packages/db/src/client.ts')).toEqual({
      targetType: 'file',
      targetId: 'packages/db/src/client.ts',
    });
    expect(classifyImpactTarget('licensing')).toEqual({ targetType: 'concept', targetId: 'licensing' });
  });

  it('records prose rather than discarding it', () => {
    // Classify, don't reject: rejecting would fail an agent mid-task for
    // describing impact the way the field's name invites, and would lose
    // the decision-to-area association entirely.
    expect(classifyImpactTarget('identity')).not.toBeNull();
  });

  it('trims before classifying', () => {
    expect(classifyImpactTarget('  packages/db/src/client.ts  ')).toEqual({
      targetType: 'file',
      targetId: 'packages/db/src/client.ts',
    });
  });

  it('returns null for entries that carry no target at all', () => {
    // A null must be skipped by the caller rather than written as an
    // edge pointing nowhere.
    expect(classifyImpactTarget('')).toBeNull();
    expect(classifyImpactTarget('   ')).toBeNull();
    expect(classifyImpactTarget('graph_node:')).toBeNull();
    expect(classifyImpactTarget('work_pack:  ')).toBeNull();
  });
});

describe('isElidedPath', () => {
  it('catches both ASCII and Unicode ellipses', () => {
    expect(isElidedPath('apps/.../x.ts')).toBe(true);
    expect(isElidedPath('apps/…/x.ts')).toBe(true);
    expect(isElidedPath('apps/mcp-server/x.ts')).toBe(false);
  });
});
