import { describe, expect, it } from 'vitest';

import {
  compareMarkerSets,
  deltaIsEmpty,
  describeDelta,
  parseAutoSections,
  summarizeParseErrors,
} from '@/lib/feature-pack-markers';

/**
 * Unit tests for `apps/web/lib/feature-pack-markers.ts` (M04 Phase 2 S6).
 *
 * The CLI auto-marker library has its own deep test suite under
 * `packages/cli/__tests__/`. We only re-test the *web-specific* behaviours
 * here: the `compareMarkerSets` delta + the `summarizeParseErrors`
 * formatting. Anything that would test the parser is left to the CLI
 * package — re-testing here would be duplication that drifts.
 */

const FIXTURE_BASE = `# spec.md

Free intro.

<!-- @auto:dependencies -->
- foo
- bar
<!-- /@auto -->

Some prose.

<!-- @auto:tree -->
\`\`\`
src/
  index.ts
\`\`\`
<!-- /@auto -->

End.
`;

describe('parseAutoSections (re-export)', () => {
  it('finds both auto sections in the fixture', () => {
    const result = parseAutoSections(FIXTURE_BASE);
    expect(result.errors).toHaveLength(0);
    expect(result.sections.map((s) => s.name)).toEqual(['dependencies', 'tree']);
  });

  it('reports missing close tag', () => {
    const broken = '<!-- @auto:foo -->\nbody\n';
    const result = parseAutoSections(broken);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('missing_close_tag');
  });
});

describe('compareMarkerSets', () => {
  it('returns empty delta when only inner content changed', () => {
    const before = parseAutoSections(FIXTURE_BASE);
    const edited = FIXTURE_BASE.replace('- foo\n- bar\n', '- foo\n- bar\n- baz\n');
    const after = parseAutoSections(edited);
    const delta = compareMarkerSets(before, after);
    expect(deltaIsEmpty(delta)).toBe(true);
    expect(describeDelta(delta)).toBe('no changes');
  });

  it('detects removed sections', () => {
    const before = parseAutoSections(FIXTURE_BASE);
    // Strip out the second section entirely (markers + body).
    const stripped = FIXTURE_BASE.replace(/<!-- @auto:tree -->[\s\S]*?<!-- \/@auto -->/, '');
    const after = parseAutoSections(stripped);
    const delta = compareMarkerSets(before, after);
    expect(delta.removed).toEqual(['tree']);
    expect(delta.added).toEqual([]);
    expect(deltaIsEmpty(delta)).toBe(false);
  });

  it('detects added sections', () => {
    const before = parseAutoSections(FIXTURE_BASE);
    const augmented = `${FIXTURE_BASE}\n<!-- @auto:newsection -->\nbody\n<!-- /@auto -->\n`;
    const after = parseAutoSections(augmented);
    const delta = compareMarkerSets(before, after);
    expect(delta.added).toEqual(['newsection']);
    expect(delta.removed).toEqual([]);
  });

  it('detects renames as add+remove (rename = remove old + add new)', () => {
    const before = parseAutoSections(FIXTURE_BASE);
    const renamed = FIXTURE_BASE.replace('@auto:tree', '@auto:tree-renamed');
    const after = parseAutoSections(renamed);
    const delta = compareMarkerSets(before, after);
    expect(delta.removed).toEqual(['tree']);
    expect(delta.added).toEqual(['tree-renamed']);
  });

  it('detects reorder when section moved without rename', () => {
    const before = parseAutoSections(FIXTURE_BASE);
    // Build a new doc where `tree` appears BEFORE `dependencies`.
    const reordered = `# spec.md

<!-- @auto:tree -->
\`\`\`
src/
  index.ts
\`\`\`
<!-- /@auto -->

<!-- @auto:dependencies -->
- foo
- bar
<!-- /@auto -->
`;
    const after = parseAutoSections(reordered);
    const delta = compareMarkerSets(before, after);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
    expect(delta.reordered.length).toBeGreaterThan(0);
    expect(describeDelta(delta)).toContain('reordered');
  });
});

describe('summarizeParseErrors', () => {
  it('returns empty string for no errors', () => {
    expect(summarizeParseErrors([])).toBe('');
  });

  it('formats one error compactly', () => {
    const summary = summarizeParseErrors([
      { code: 'missing_close_tag', line: 7, message: 'open tag for "x" has no matching close' },
    ]);
    expect(summary).toBe('line 7: missing_close_tag — open tag for "x" has no matching close');
  });

  it('truncates after the first three errors', () => {
    const errors = [1, 2, 3, 4, 5].map((line) => ({
      code: 'unmatched_close_tag' as const,
      line,
      message: 'x',
    }));
    const summary = summarizeParseErrors(errors);
    expect(summary).toContain('+2 more');
    expect(summary.split(' | ').length).toBe(3); // first three then the trailer is appended
  });
});
