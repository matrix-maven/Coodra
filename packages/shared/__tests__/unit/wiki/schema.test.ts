import { describe, expect, it } from 'vitest';

import {
  WIKI_SCHEMA_VERSION,
  type WikiPage,
  type WikiStructure,
  wikiCitationSchema,
  wikiPageContentSchema,
  wikiPageSchema,
  wikiStructureSchema,
} from '../../../src/wiki/schema.js';

/** Build a complete WikiPage from partial overrides (avoids unsafe index-spreads). */
function page(over: Partial<WikiPage> & { id: string }): WikiPage {
  return {
    title: 't',
    description: 'd',
    importance: 'low',
    parentId: null,
    relevantFiles: [],
    relatedPageIds: [],
    wantsDiagram: false,
    ...over,
  };
}

/** A minimal valid two-page comprehensive structure. */
function validStructure(): WikiStructure {
  return {
    schemaVersion: WIKI_SCHEMA_VERSION,
    title: 'Coodra',
    description: 'An MCP coordination platform for AI coding agents.',
    mode: 'comprehensive',
    sections: [
      { id: 'overview', title: 'Overview', pageIds: ['intro'], subsectionIds: ['internals'] },
      { id: 'internals', title: 'Internals', pageIds: ['mcp-server'], subsectionIds: [] },
    ],
    pages: [
      {
        id: 'intro',
        title: 'Introduction',
        description: 'What Coodra is and the problem it solves.',
        importance: 'high',
        parentId: null,
        relevantFiles: ['README.md'],
        relatedPageIds: ['mcp-server'],
        wantsDiagram: true,
      },
      {
        id: 'mcp-server',
        title: 'MCP Server',
        description: 'The tool manifest and request lifecycle.',
        importance: 'medium',
        parentId: 'intro',
        relevantFiles: ['apps/mcp-server/src/index.ts'],
        relatedPageIds: [],
        wantsDiagram: false,
        graphCommunityId: 12,
      },
    ],
  };
}

describe('wikiPageSchema', () => {
  it('accepts a minimal page and applies array defaults', () => {
    const parsed = wikiPageSchema.parse({
      id: 'intro',
      title: 'Intro',
      description: 'x',
      importance: 'low',
      parentId: null,
    });
    expect(parsed.relevantFiles).toEqual([]);
    expect(parsed.relatedPageIds).toEqual([]);
    expect(parsed.wantsDiagram).toBe(false);
  });

  it('rejects a non-kebab id', () => {
    const bad = wikiPageSchema.safeParse({
      id: 'Intro Page',
      title: 'x',
      description: 'x',
      importance: 'low',
      parentId: null,
    });
    expect(bad.success).toBe(false);
  });

  it('rejects an unknown importance', () => {
    const bad = wikiPageSchema.safeParse({
      id: 'intro',
      title: 'x',
      description: 'x',
      importance: 'critical',
      parentId: null,
    });
    expect(bad.success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    const bad = wikiPageSchema.safeParse({
      id: 'intro',
      title: 'x',
      description: 'x',
      importance: 'low',
      parentId: null,
      extra: true,
    });
    expect(bad.success).toBe(false);
  });
});

describe('wikiStructureSchema — happy path', () => {
  it('accepts a valid comprehensive structure', () => {
    const ok = wikiStructureSchema.safeParse(validStructure());
    expect(ok.success).toBe(true);
  });

  it('accepts a flat concise structure with no sections', () => {
    const concise: WikiStructure = {
      ...validStructure(),
      mode: 'concise',
      sections: [],
    };
    const ok = wikiStructureSchema.safeParse(concise);
    expect(ok.success).toBe(true);
  });

  it('requires at least one page', () => {
    const bad = wikiStructureSchema.safeParse({ ...validStructure(), pages: [] });
    expect(bad.success).toBe(false);
  });

  it('rejects a wrong schemaVersion', () => {
    const bad = wikiStructureSchema.safeParse({ ...validStructure(), schemaVersion: 2 });
    expect(bad.success).toBe(false);
  });
});

describe('wikiStructureSchema — referential integrity (superRefine)', () => {
  it('rejects a duplicate page id', () => {
    const s = validStructure();
    s.sections = [];
    s.pages = [page({ id: 'intro' }), page({ id: 'intro', title: 'dup' })];
    const bad = wikiStructureSchema.safeParse(s);
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('duplicate page id'))).toBe(true);
    }
  });

  it('rejects a parentId that does not match any page', () => {
    const s = validStructure();
    s.sections = [];
    s.pages = [page({ id: 'intro', parentId: 'ghost' })];
    const bad = wikiStructureSchema.safeParse(s);
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('does not match any page id'))).toBe(true);
    }
  });

  it('rejects a self-parenting page', () => {
    const s = validStructure();
    s.sections = [];
    s.pages = [page({ id: 'intro', parentId: 'intro' })];
    const bad = wikiStructureSchema.safeParse(s);
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('cannot be its own parent'))).toBe(true);
    }
  });

  it('rejects a dangling relatedPageId', () => {
    const s = validStructure();
    s.sections = [];
    s.pages = [page({ id: 'intro', relatedPageIds: ['ghost'] })];
    const bad = wikiStructureSchema.safeParse(s);
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('relatedPageIds'))).toBe(true);
    }
  });

  it('rejects a section pointing at a non-existent page', () => {
    const s = validStructure();
    s.pages = [page({ id: 'intro' })];
    s.sections = [{ id: 'overview', title: 'Overview', pageIds: ['ghost'], subsectionIds: [] }];
    const bad = wikiStructureSchema.safeParse(s);
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('section pageIds'))).toBe(true);
    }
  });

  it('rejects a section pointing at a non-existent subsection', () => {
    const s = validStructure();
    s.pages = [page({ id: 'intro' })];
    s.sections = [{ id: 'overview', title: 'Overview', pageIds: ['intro'], subsectionIds: ['ghost'] }];
    const bad = wikiStructureSchema.safeParse(s);
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('subsectionIds'))).toBe(true);
    }
  });

  it('rejects a duplicate section id', () => {
    const s = validStructure();
    s.pages = [page({ id: 'intro' })];
    s.sections = [
      { id: 'overview', title: 'A', pageIds: ['intro'], subsectionIds: [] },
      { id: 'overview', title: 'B', pageIds: [], subsectionIds: [] },
    ];
    const bad = wikiStructureSchema.safeParse(s);
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('duplicate section id'))).toBe(true);
    }
  });
});

describe('wikiCitationSchema', () => {
  it('accepts a file-only citation', () => {
    expect(wikiCitationSchema.safeParse({ file: 'src/a.ts' }).success).toBe(true);
  });

  it('accepts a valid line span', () => {
    expect(wikiCitationSchema.safeParse({ file: 'src/a.ts', startLine: 10, endLine: 20 }).success).toBe(true);
  });

  it('rejects an inverted line span', () => {
    const bad = wikiCitationSchema.safeParse({ file: 'src/a.ts', startLine: 20, endLine: 10 });
    expect(bad.success).toBe(false);
  });
});

describe('wikiPageContentSchema', () => {
  it('accepts markdown with no citations and defaults citations to []', () => {
    const parsed = wikiPageContentSchema.parse({ contentMarkdown: '# Hello\n\n```mermaid\ngraph TD; A-->B;\n```' });
    expect(parsed.citations).toEqual([]);
  });

  it('rejects empty markdown', () => {
    expect(wikiPageContentSchema.safeParse({ contentMarkdown: '' }).success).toBe(false);
  });
});
