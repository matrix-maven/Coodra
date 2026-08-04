import { describe, expect, it } from 'vitest';

import {
  WIKI_DOCS_DIRNAME,
  WIKI_JOB_RELPATH,
  wikiDir,
  wikiDocsRoot,
  wikiJobPath,
  wikiMdDir,
  wikiMdIndexPath,
  wikiPageMdPath,
  wikiStructurePath,
} from '../../../src/wiki/paths.js';

const ROOT = '/repo';

describe('wiki paths', () => {
  it('computes the docs root', () => {
    expect(wikiDocsRoot(ROOT)).toBe(`/repo/${WIKI_DOCS_DIRNAME}`);
  });

  it('computes a per-wiki dir', () => {
    expect(wikiDir(ROOT, 'coodra')).toBe('/repo/.coodra/wiki/coodra');
  });

  it('computes the structure path', () => {
    expect(wikiStructurePath(ROOT, 'coodra')).toBe('/repo/.coodra/wiki/coodra/structure.json');
  });

  it('computes the connected-Markdown dir', () => {
    expect(wikiMdDir(ROOT, 'coodra')).toBe('/repo/.coodra/wiki/coodra/md');
  });

  it('computes a page md path from a kebab page id', () => {
    expect(wikiPageMdPath(ROOT, 'coodra', 'mcp-server')).toBe('/repo/.coodra/wiki/coodra/md/mcp-server.md');
  });

  it('computes the md index path', () => {
    expect(wikiMdIndexPath(ROOT, 'coodra')).toBe('/repo/.coodra/wiki/coodra/md/index.md');
  });

  it('computes the job path', () => {
    expect(wikiJobPath(ROOT)).toBe(`/repo/${WIKI_JOB_RELPATH}`);
  });
});
