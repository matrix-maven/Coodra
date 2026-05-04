import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Integration tests for `saveFeaturePackAction` (M04 Phase 2 S6).
 *
 * The action lives in `apps/web/lib/actions/packs.ts`. It uses
 * `redirect()` from `next/navigation` to signal both success and
 * failure paths — `redirect()` throws a special error in production,
 * but for tests we mock it as a normal throw so we can inspect the
 * destination URL.
 *
 * What we exercise:
 *   1. Successful save with marker contract intact → file is written +
 *      success redirect lands on the pack detail page with `?edited=`.
 *   2. Tampered-marker save → file is NOT written + redirect carries
 *      `error=markers_tampered`.
 *   3. Stale mtime → file is NOT written + redirect carries
 *      `error=concurrent_edit`.
 *   4. Non-existent pack → redirect carries `error=pack_not_found`.
 */

interface RedirectError extends Error {
  url: string;
}

function isRedirect(err: unknown): err is RedirectError {
  return err instanceof Error && 'url' in err && typeof (err as RedirectError).url === 'string';
}

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    const err = new Error(`REDIRECT:${url}`) as RedirectError;
    err.url = url;
    throw err;
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));

let tmpRoot: string;
let projectCwd: string;
let packDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cxos-s6-action-'));
  projectCwd = tmpRoot;
  packDir = join(tmpRoot, 'docs', 'feature-packs', 's6-action-test');
  mkdirSync(packDir, { recursive: true });
  writeFileSync(
    join(packDir, 'meta.json'),
    JSON.stringify({ slug: 's6-action-test', parentSlug: null, isActive: true }, null, 2),
  );
  writeFileSync(
    join(packDir, 'spec.md'),
    [
      '# spec.md',
      '',
      'Free intro.',
      '',
      '<!-- @auto:overview -->',
      '- foo',
      '- bar',
      '<!-- /@auto -->',
      '',
      'End.',
      '',
    ].join('\n'),
  );
  writeFileSync(join(packDir, 'implementation.md'), '# impl\n');
  writeFileSync(join(packDir, 'techstack.md'), '# tech\n');
  // Steer the queries/packs.ts resolver at the pack root we just created.
  process.env.CONTEXTOS_PACKS_ROOT = join(tmpRoot, 'docs', 'feature-packs');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.CONTEXTOS_PACKS_ROOT;
});

async function callSave(input: {
  projectSlug?: string;
  packSlug?: string;
  cwd?: string;
  fileName?: string;
  mtimeMs?: number;
  content: string;
}): Promise<RedirectError> {
  const { saveFeaturePackAction } = await import('@/lib/actions/packs');
  const fd = new FormData();
  fd.set('projectSlug', input.projectSlug ?? 's6-action-test');
  fd.set('packSlug', input.packSlug ?? 's6-action-test');
  fd.set('cwd', input.cwd ?? projectCwd);
  fd.set('fileName', input.fileName ?? 'spec.md');
  fd.set('mtimeMs', String(input.mtimeMs ?? Math.floor(statSync(join(packDir, input.fileName ?? 'spec.md')).mtimeMs)));
  fd.set('content', input.content);
  try {
    await saveFeaturePackAction(fd);
  } catch (err) {
    if (isRedirect(err)) return err;
    throw err;
  }
  throw new Error('saveFeaturePackAction did not redirect');
}

describe('saveFeaturePackAction', () => {
  it('writes the file and redirects on a marker-preserving edit', async () => {
    const onDisk = readFileSync(join(packDir, 'spec.md'), 'utf8');
    // Edit only the inner content of @auto:overview.
    const edited = onDisk.replace('- foo\n- bar', '- foo\n- bar\n- baz (added)');
    const redirected = await callSave({ content: edited });
    expect(redirected.url).toContain('/projects/s6-action-test/packs/s6-action-test');
    expect(redirected.url).toContain('edited=spec.md');
    const after = readFileSync(join(packDir, 'spec.md'), 'utf8');
    expect(after).toBe(edited);
    expect(after).toContain('- baz (added)');
  });

  it('refuses a tampered-marker save and leaves the file unchanged', async () => {
    const before = readFileSync(join(packDir, 'spec.md'), 'utf8');
    const tampered = before.replace(/<!-- @auto:overview -->[\s\S]*?<!-- \/@auto -->\n*/, '## (overview removed)\n\n');
    const redirected = await callSave({ content: tampered });
    expect(redirected.url).toContain('/edit');
    expect(redirected.url).toContain('error=markers_tampered');
    expect(readFileSync(join(packDir, 'spec.md'), 'utf8')).toBe(before);
  });

  it('refuses an add-marker save', async () => {
    const before = readFileSync(join(packDir, 'spec.md'), 'utf8');
    const augmented = `${before}\n<!-- @auto:newmarker -->\nbody\n<!-- /@auto -->\n`;
    const redirected = await callSave({ content: augmented });
    expect(redirected.url).toContain('error=markers_tampered');
    expect(readFileSync(join(packDir, 'spec.md'), 'utf8')).toBe(before);
  });

  it('rejects on stale mtime (concurrent edit)', async () => {
    const before = readFileSync(join(packDir, 'spec.md'), 'utf8');
    const edited = before.replace('- foo', '- foo (stale-mtime test)');
    const redirected = await callSave({ content: edited, mtimeMs: 0 });
    expect(redirected.url).toContain('error=concurrent_edit');
    expect(readFileSync(join(packDir, 'spec.md'), 'utf8')).toBe(before);
  });

  it('rejects when the pack does not exist', async () => {
    const redirected = await callSave({
      packSlug: 'nonexistent-pack',
      content: '# does not matter\n',
      mtimeMs: 0,
    });
    expect(redirected.url).toContain('error=pack_not_found');
  });

  it('rejects on raw parse error (unmatched close tag)', async () => {
    const before = readFileSync(join(packDir, 'spec.md'), 'utf8');
    const broken = `${before}\n<!-- /@auto -->\n`;
    const redirected = await callSave({ content: broken });
    expect(redirected.url).toContain('error=parse_failed');
    expect(readFileSync(join(packDir, 'spec.md'), 'utf8')).toBe(before);
  });
});
