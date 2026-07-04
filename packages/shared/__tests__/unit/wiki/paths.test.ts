import { describe, expect, it } from 'vitest';

import {
  WIKI_DOCS_DIRNAME,
  WIKI_JOB_RELPATH,
  wikiDir,
  wikiDocsRoot,
  wikiJobPath,
  wikiPagePath,
  wikiStructurePath,
} from '../../../src/wiki/paths.js';

const ROOT = '/repo';

describe('wiki paths', () => {
  it('computes the docs root', () => {
    expect(wikiDocsRoot(ROOT)).toBe(`/repo/${WIKI_DOCS_DIRNAME}`);
  });

  it('computes a per-wiki dir', () => {
    expect(wikiDir(ROOT, 'coodra')).toBe('/repo/docs/wiki/coodra');
  });

  it('computes the structure path', () => {
    expect(wikiStructurePath(ROOT, 'coodra')).toBe('/repo/docs/wiki/coodra/structure.json');
  });

  it('computes a page path from a kebab page id', () => {
    expect(wikiPagePath(ROOT, 'coodra', 'mcp-server')).toBe('/repo/docs/wiki/coodra/mcp-server.md');
  });

  it('computes the job path', () => {
    expect(wikiJobPath(ROOT)).toBe(`/repo/${WIKI_JOB_RELPATH}`);
  });
});
