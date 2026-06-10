import type { DbHandle } from '@coodra/db';
import { assertManifestDescriptionValid } from '@coodra/shared/test-utils';
import { describe, expect, it } from 'vitest';

import { createWikiSavePageToolRegistration } from '../../../src/tools/wiki-save-page/manifest.js';
import { wikiSavePageInputSchema, wikiSavePageOutputSchema } from '../../../src/tools/wiki-save-page/schema.js';
import { createWikiSaveStructureToolRegistration } from '../../../src/tools/wiki-save-structure/manifest.js';
import {
  wikiSaveStructureInputSchema,
  wikiSaveStructureOutputSchema,
} from '../../../src/tools/wiki-save-structure/schema.js';
import { createWikiStatusToolRegistration } from '../../../src/tools/wiki-status/manifest.js';
import { wikiStatusInputSchema, wikiStatusOutputSchema } from '../../../src/tools/wiki-status/schema.js';

/**
 * Unit tests for the three Module 10 Deep Wiki tools — manifest contract
 * (§24.3) + schema boundaries. The DB-backed handler behaviour (the full
 * structure → page → status flow + soft-failures) is covered in
 * `__tests__/integration/tools/wiki-flow.test.ts`.
 */

const fakeDb = { kind: 'sqlite', db: {}, raw: {}, close: () => {} } as unknown as DbHandle;

function validStructure() {
  return {
    schemaVersion: 1 as const,
    title: 'Coodra',
    description: 'An MCP coordination platform.',
    mode: 'comprehensive' as const,
    sections: [{ id: 'overview', title: 'Overview', pageIds: ['intro'], subsectionIds: [] }],
    pages: [
      {
        id: 'intro',
        title: 'Intro',
        description: 'what it is',
        importance: 'high' as const,
        parentId: null,
        relevantFiles: ['README.md'],
        relatedPageIds: [],
        wantsDiagram: true,
      },
    ],
  };
}

describe('wiki tools — manifest contracts (§24.3)', () => {
  it('wiki_save_structure satisfies every rule', () => {
    const reg = createWikiSaveStructureToolRegistration({ db: fakeDb });
    expect(() => assertManifestDescriptionValid(reg, { folderName: 'wiki-save-structure' })).not.toThrow();
    expect(reg.name).toBe('wiki_save_structure');
  });

  it('wiki_save_page satisfies every rule', () => {
    const reg = createWikiSavePageToolRegistration({ db: fakeDb });
    expect(() => assertManifestDescriptionValid(reg, { folderName: 'wiki-save-page' })).not.toThrow();
    expect(reg.name).toBe('wiki_save_page');
  });

  it('wiki_status satisfies every rule', () => {
    const reg = createWikiStatusToolRegistration({ db: fakeDb });
    expect(() => assertManifestDescriptionValid(reg, { folderName: 'wiki-status' })).not.toThrow();
    expect(reg.name).toBe('wiki_status');
  });

  it('wiki_save_structure + wiki_save_page are mutating; wiki_status is readonly', () => {
    const struct = createWikiSaveStructureToolRegistration({ db: fakeDb });
    const page = createWikiSavePageToolRegistration({ db: fakeDb });
    const status = createWikiStatusToolRegistration({ db: fakeDb });
    const ctx = { sessionId: 's', receivedAt: new Date(0) };
    expect(struct.idempotencyKey({ runId: 'r', slug: 'coodra', structure: validStructure() }, ctx).kind).toBe(
      'mutating',
    );
    expect(
      page.idempotencyKey(
        { runId: 'r', wikiId: 'w', pageId: 'intro', content: { contentMarkdown: 'x', citations: [] } },
        ctx,
      ).kind,
    ).toBe('mutating');
    const statusKey = status.idempotencyKey({ wikiId: 'w' }, ctx);
    expect(statusKey.kind).toBe('readonly');
    expect(statusKey.key.startsWith('readonly:')).toBe(true);
  });
});

describe('wiki_save_structure — input schema', () => {
  it('accepts a valid runId + slug + structure', () => {
    const ok = wikiSaveStructureInputSchema.safeParse({ runId: 'r', slug: 'coodra', structure: validStructure() });
    expect(ok.success).toBe(true);
  });

  it('rejects a non-kebab slug', () => {
    expect(
      wikiSaveStructureInputSchema.safeParse({ runId: 'r', slug: 'Coodra Wiki', structure: validStructure() }).success,
    ).toBe(false);
  });

  it('rejects a structure whose section points at a missing page (superRefine fires through the input schema)', () => {
    const bad = validStructure();
    bad.sections = [{ id: 'overview', title: 'O', pageIds: ['ghost'], subsectionIds: [] }];
    expect(wikiSaveStructureInputSchema.safeParse({ runId: 'r', slug: 'coodra', structure: bad }).success).toBe(false);
  });

  it('is strict — rejects unknown top-level keys', () => {
    expect(
      wikiSaveStructureInputSchema.safeParse({ runId: 'r', slug: 'coodra', structure: validStructure(), extra: 1 })
        .success,
    ).toBe(false);
  });
});

describe('wiki_save_structure — output schema', () => {
  it('parses the success branch', () => {
    expect(
      wikiSaveStructureOutputSchema.safeParse({
        ok: true,
        wikiId: 'wiki_1',
        slug: 'coodra',
        mode: 'comprehensive',
        pageCount: 1,
        status: 'created',
        pendingPageIds: ['intro'],
      }).success,
    ).toBe(true);
  });

  it('parses each soft-failure branch', () => {
    for (const error of ['run_not_found', 'auth_required'] as const) {
      expect(wikiSaveStructureOutputSchema.safeParse({ ok: false, error, howToFix: 'x' }).success).toBe(true);
    }
  });
});

describe('wiki_save_page — input + output schema', () => {
  it('accepts a valid page authoring payload', () => {
    expect(
      wikiSavePageInputSchema.safeParse({
        runId: 'r',
        wikiId: 'w',
        pageId: 'intro',
        content: { contentMarkdown: '# Intro', citations: [{ file: 'README.md' }] },
      }).success,
    ).toBe(true);
  });

  it('rejects empty content markdown', () => {
    expect(
      wikiSavePageInputSchema.safeParse({ runId: 'r', wikiId: 'w', pageId: 'intro', content: { contentMarkdown: '' } })
        .success,
    ).toBe(false);
  });

  it('parses all four soft-failure branches', () => {
    for (const error of ['run_not_found', 'auth_required', 'wiki_not_found', 'page_not_in_structure'] as const) {
      expect(wikiSavePageOutputSchema.safeParse({ ok: false, error, howToFix: 'x' }).success).toBe(true);
    }
  });
});

describe('wiki_status — input + output schema', () => {
  it('accepts a wikiId', () => {
    expect(wikiStatusInputSchema.safeParse({ wikiId: 'w' }).success).toBe(true);
  });

  it('rejects an empty wikiId', () => {
    expect(wikiStatusInputSchema.safeParse({ wikiId: '' }).success).toBe(false);
  });

  it('parses the success branch with pages', () => {
    expect(
      wikiStatusOutputSchema.safeParse({
        ok: true,
        wikiId: 'w',
        slug: 'coodra',
        title: 'Coodra',
        mode: 'comprehensive',
        pageCount: 2,
        authoredCount: 1,
        pendingCount: 1,
        pendingPageIds: ['mcp-server'],
        pages: [
          { pageId: 'intro', state: 'authored' },
          { pageId: 'mcp-server', state: 'pending' },
        ],
      }).success,
    ).toBe(true);
  });

  it('parses the wiki_not_found branch', () => {
    expect(wikiStatusOutputSchema.safeParse({ ok: false, error: 'wiki_not_found', howToFix: 'x' }).success).toBe(true);
  });
});
