import { describe, expect, it } from 'vitest';
import { activeBlockerTitles } from '../../../src/commands/status.js';

/**
 * `coodra status` used to preview the raw first bytes of
 * `context_memory/blockers.md` as a "pending blocker" — which surfaced the
 * file's explanatory header as a phantom amber warning on projects whose
 * blockers were all resolved. The fix counts `## ` entry sections and skips
 * resolved (✅ / RESOLVED) titles.
 */
describe('activeBlockerTitles', () => {
  it('returns [] for an empty file', () => {
    expect(activeBlockerTitles('')).toEqual([]);
  });

  it('returns [] for a header-only file (boilerplate is not a blocker)', () => {
    const raw = [
      '# Blockers',
      '',
      'Things actively preventing progress right now. Keep minimal.',
      '',
      'Format:',
      '',
      '```',
      '## YYYY-MM-DD HH:mm — <short title>',
      '```',
    ].join('\n');
    // The format example lives inside a ``` fence — documentation, not an
    // entry. It must not read as an active blocker.
    expect(activeBlockerTitles(raw)).toEqual([]);
  });

  it('skips ✅-retitled and RESOLVED entries, keeps active ones', () => {
    const raw = [
      '# Blockers',
      '',
      '## 2026-05-02 14:51 — turbo cycle — RESOLVED',
      'body',
      '## ✅ 2026-05-02 14:55 — tsbuildinfo poisoning',
      'body',
      '## 2026-07-24 10:00 — docker daemon down',
      '**Blocks:** integration tests',
    ].join('\n');
    expect(activeBlockerTitles(raw)).toEqual(['2026-07-24 10:00 — docker daemon down']);
  });

  it('is case-insensitive on RESOLVED and ignores ### subsections', () => {
    const raw = ['## 2026-01-01 — thing (resolved)', '### not an entry heading', '## 2026-01-02 — live one'].join('\n');
    expect(activeBlockerTitles(raw)).toEqual(['2026-01-02 — live one']);
  });
});
