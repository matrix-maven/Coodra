import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolContext } from '../../../src/framework/tool-context.js';

const lookupProjectBySlugMock = vi.hoisted(() => vi.fn());

vi.mock('@coodra/db', () => ({
  lookupProjectBySlug: lookupProjectBySlugMock,
}));

const { createGetFeatureFileHandler } = await import('../../../src/tools/get-recipe-file/handler.js');

let projectCwd: string;
let outsideFile: string;

beforeEach(() => {
  projectCwd = mkdtempSync(join(tmpdir(), 'coodra-get-recipe-file-'));
  outsideFile = join(tmpdir(), `coodra-get-recipe-outside-${Date.now()}.txt`);
  lookupProjectBySlugMock.mockReset();
  lookupProjectBySlugMock.mockResolvedValue({ cwd: projectCwd });
});

afterEach(() => {
  rmSync(projectCwd, { recursive: true, force: true });
  rmSync(outsideFile, { force: true });
  lookupProjectBySlugMock.mockReset();
});

function recipeDir(slug: string): string {
  return join(projectCwd, '.coodra', 'recipes', slug);
}

describe('get_recipe_file handler', () => {
  it('reads a normal text file inside the recipe directory', async () => {
    const dir = recipeDir('safe');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.md'), '# Safe\n', 'utf8');

    const handler = createGetFeatureFileHandler({ db: {} as never });
    const out = await handler({ projectSlug: 'demo', slug: 'safe', path: 'notes.md' }, {} as ToolContext);
    expect(out).toMatchObject({ ok: true, path: 'notes.md', content: '# Safe\n' });
  });

  it('rejects symlinked files that point outside the recipe directory', async () => {
    const dir = recipeDir('unsafe');
    mkdirSync(dir, { recursive: true });
    writeFileSync(outsideFile, 'secret\n', 'utf8');
    symlinkSync(outsideFile, join(dir, 'leak.md'));

    const handler = createGetFeatureFileHandler({ db: {} as never });
    const out = await handler({ projectSlug: 'demo', slug: 'unsafe', path: 'leak.md' }, {} as ToolContext);
    expect(out).toMatchObject({ ok: false, error: 'path_escape' });
  });
});
