import { describe, expect, it } from 'vitest';
import { buildAutoSummary } from '../../src/lib/auto-context-pack.js';

/**
 * Locks the structured-summary contract used by SessionEnd
 * auto-save (decision dec_83ba10c1, 2026-05-02). The summary is
 * deterministic so future runs of the same fixture produce the
 * same Markdown — the contract is what Module 05 (NL Assembly)
 * will replace with an LLM-generated narrative.
 */
describe('buildAutoSummary', () => {
  it('lists files touched, classifies events, surfaces decisions', () => {
    const result = buildAutoSummary({
      runId: 'run:proj_x:sess:abcdefgh-1234-5678-9012-abcdefabcdef',
      events: [
        {
          id: 'evt-1',
          phase: 'pre',
          toolName: 'Write',
          toolUseId: 'tu1',
          toolInput: JSON.stringify({ file_path: '/repo/src/foo.ts' }),
          outcome: null,
          createdAt: new Date('2026-05-02T12:00:00Z'),
        },
        {
          id: 'evt-2',
          phase: 'post',
          toolName: 'Read',
          toolUseId: 'tu2',
          toolInput: JSON.stringify({ file_path: '/repo/src/bar.ts' }),
          outcome: 'ok',
          createdAt: new Date('2026-05-02T12:01:00Z'),
        },
        {
          id: 'evt-3',
          phase: 'pre',
          toolName: 'Bash',
          toolUseId: 'tu3',
          toolInput: JSON.stringify({ command: 'pnpm test' }),
          outcome: 'denied',
          createdAt: new Date('2026-05-02T12:02:00Z'),
        },
      ],
      decisions: [
        {
          id: 'dec-1',
          description: 'Bundle dists into the CLI tarball',
          rationale: 'Workspace packages are private',
          alternatives: JSON.stringify(['Publish all workspace packages', 'CDN postinstall']),
          createdAt: new Date('2026-05-02T12:03:00Z'),
        },
      ],
    });

    expect(result.title).toContain('Auto-saved session');
    expect(result.title.length).toBeLessThan(120);

    expect(result.content).toContain('# Auto-saved Context Pack');
    expect(result.content).toContain('## Run summary');
    expect(result.content).toContain('events recorded:** 3');
    expect(result.content).toContain('writes / edits:** 1');
    expect(result.content).toContain('reads / greps:** 1');
    expect(result.content).toContain('shell commands:** 1');
    expect(result.content).toContain('policy denies:** 1');
    expect(result.content).toContain('## Files touched');
    expect(result.content).toContain('/repo/src/foo.ts');
    expect(result.content).toContain('/repo/src/bar.ts');
    expect(result.content).toContain('## Decisions');
    expect(result.content).toContain('Bundle dists into the CLI tarball');
    expect(result.content).toContain('Workspace packages are private');
    expect(result.content).toContain('Publish all workspace packages');
  });

  it('produces a valid summary with zero events + zero decisions', () => {
    const result = buildAutoSummary({
      runId: 'run:empty:1:abc',
      events: [],
      decisions: [],
    });
    expect(result.content).toContain('events recorded:** 0');
    expect(result.content).not.toContain('## Files touched');
    expect(result.content).not.toContain('## Decisions');
  });
});
