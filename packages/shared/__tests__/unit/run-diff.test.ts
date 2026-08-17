import { describe, expect, it } from 'vitest';

import {
  MAX_UNIFIED_DIFF_BYTES,
  parseRunDiffFilesChanged,
  runDiffFileEntrySchema,
  truncateUnifiedDiff,
} from '../../src/run-diff.js';

describe('runDiffFileEntrySchema', () => {
  it('accepts a minimal valid entry', () => {
    const ok = runDiffFileEntrySchema.safeParse({
      path: 'src/foo.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a rename with oldPath', () => {
    const ok = runDiffFileEntrySchema.safeParse({
      path: 'src/new.ts',
      oldPath: 'src/old.ts',
      status: 'renamed',
      additions: 0,
      deletions: 0,
    });
    expect(ok.success).toBe(true);
  });

  it('rejects negative line counts', () => {
    const bad = runDiffFileEntrySchema.safeParse({
      path: 'src/foo.ts',
      status: 'modified',
      additions: -1,
      deletions: 0,
    });
    expect(bad.success).toBe(false);
  });

  it('rejects unknown status values', () => {
    const bad = runDiffFileEntrySchema.safeParse({
      path: 'src/foo.ts',
      status: 'patched',
      additions: 1,
      deletions: 0,
    });
    expect(bad.success).toBe(false);
  });
});

describe('parseRunDiffFilesChanged', () => {
  it('returns [] for null / undefined / empty', () => {
    expect(parseRunDiffFilesChanged(null)).toEqual([]);
    expect(parseRunDiffFilesChanged(undefined)).toEqual([]);
    expect(parseRunDiffFilesChanged('')).toEqual([]);
  });

  it('returns [] for non-JSON garbage', () => {
    expect(parseRunDiffFilesChanged('not-json {')).toEqual([]);
  });

  it('returns [] when shape mismatch', () => {
    expect(parseRunDiffFilesChanged(JSON.stringify({ not: 'an array' }))).toEqual([]);
    expect(parseRunDiffFilesChanged(JSON.stringify([{ wrong: 'shape' }]))).toEqual([]);
  });

  it('round-trips a valid entry', () => {
    const entries = [
      { path: 'a.ts', status: 'added', additions: 5, deletions: 0 },
      { path: 'b.ts', status: 'deleted', additions: 0, deletions: 12 },
    ];
    expect(parseRunDiffFilesChanged(JSON.stringify(entries))).toEqual(entries);
  });
});

describe('truncateUnifiedDiff', () => {
  it('returns the input unchanged when under cap', () => {
    const small = 'diff --git a/x b/x\n+ hello\n';
    const result = truncateUnifiedDiff(small);
    expect(result.text).toBe(small);
    expect(result.truncated).toBe(false);
  });

  it('truncates at a newline boundary when over cap', () => {
    const line = `${'a'.repeat(99)}\n`; // 100 bytes including newline
    const huge = line.repeat(3000); // ~300_000 bytes — well over 256 KiB
    const result = truncateUnifiedDiff(huge);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(MAX_UNIFIED_DIFF_BYTES);
    // Truncated output ends with a newline (boundary preserved).
    expect(result.text.endsWith('\n')).toBe(true);
  });

  it('honors the maxBytes override', () => {
    const text = 'line1\nline2\nline3\n';
    const result = truncateUnifiedDiff(text, 10);
    expect(result.truncated).toBe(true);
    // Should preserve exactly the first line ending with \n
    expect(result.text).toBe('line1\n');
  });

  it('handles input with no newlines past the cap', () => {
    // Edge: a 300KB single line. Should still truncate at the cap (no
    // newline to back up to — the function returns the byte cut as-is).
    const longLine = 'x'.repeat(MAX_UNIFIED_DIFF_BYTES + 100);
    const result = truncateUnifiedDiff(longLine);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(MAX_UNIFIED_DIFF_BYTES);
  });
});
