import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { seedFeaturePack } from '../../src/lib/init/feature-pack-seed.js';

/**
 * Locks Phase 3 Fix C (2026-05-02): `seedFeaturePack` writes all
 * four files (meta.json + spec.md + implementation.md +
 * techstack.md) so the MCP `get_feature_pack` Promise.all-on-read
 * does not throw ENOENT immediately after init.
 *
 * Phase 2 verification (2026-04-28) found that pre-Fix-C init
 * shipped only meta.json + spec.md, and `apps/mcp-server/src/lib/
 * feature-pack.ts:139-144` reads all four with Promise.all — every
 * fresh install had `get_feature_pack` broken until the user
 * hand-authored the missing files.
 */

describe('seedFeaturePack — file completeness (Phase 3 Fix C)', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-feature-pack-seed-'));
  });

  afterEach(() => {
    /* tmp cleaned by OS */
  });

  it('writes meta.json + spec.md + implementation.md + techstack.md', async () => {
    const outcomes = await seedFeaturePack({
      cwd,
      slug: 'sample-app',
      languages: ['typescript'],
      force: false,
      dryRun: false,
    });

    const dir = join(cwd, 'docs', 'feature-packs', 'sample-app');
    expect((await stat(join(dir, 'meta.json'))).isFile()).toBe(true);
    expect((await stat(join(dir, 'spec.md'))).isFile()).toBe(true);
    expect((await stat(join(dir, 'implementation.md'))).isFile()).toBe(true);
    expect((await stat(join(dir, 'techstack.md'))).isFile()).toBe(true);

    // Outcomes report all four writes.
    expect(outcomes).toHaveLength(4);
    for (const outcome of outcomes) {
      expect(outcome.action).toBe('wrote');
    }
  });

  it('implementation.md skeleton mentions the slug + has a build-order section', async () => {
    await seedFeaturePack({
      cwd,
      slug: 'my-feature',
      languages: ['typescript'],
      force: false,
      dryRun: false,
    });
    const body = await readFile(join(cwd, 'docs', 'feature-packs', 'my-feature', 'implementation.md'), 'utf8');
    expect(body).toContain('# my-feature — Implementation');
    expect(body).toMatch(/Build order/i);
  });

  it('techstack.md lists detected languages when present', async () => {
    await seedFeaturePack({
      cwd,
      slug: 'multi-lang',
      languages: ['typescript', 'python'],
      force: false,
      dryRun: false,
    });
    const body = await readFile(join(cwd, 'docs', 'feature-packs', 'multi-lang', 'techstack.md'), 'utf8');
    expect(body).toContain('typescript, python');
  });

  it('techstack.md falls back to a TODO when no languages detected', async () => {
    await seedFeaturePack({
      cwd,
      slug: 'no-lang',
      languages: [],
      force: false,
      dryRun: false,
    });
    const body = await readFile(join(cwd, 'docs', 'feature-packs', 'no-lang', 'techstack.md'), 'utf8');
    expect(body).toMatch(/TODO/);
  });

  it('idempotent re-run does not overwrite existing files (action: unchanged)', async () => {
    await seedFeaturePack({
      cwd,
      slug: 'sample-app',
      languages: ['typescript'],
      force: false,
      dryRun: false,
    });

    // User hand-edits implementation.md.
    const customBody = '# my custom impl notes\n';
    const implPath = join(cwd, 'docs', 'feature-packs', 'sample-app', 'implementation.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(implPath, customBody, 'utf8');

    const outcomes = await seedFeaturePack({
      cwd,
      slug: 'sample-app',
      languages: ['typescript'],
      force: false,
      dryRun: false,
    });
    for (const outcome of outcomes) {
      expect(outcome.action).toBe('unchanged');
    }
    const after = await readFile(implPath, 'utf8');
    expect(after).toBe(customBody);
  });

  it('--force overwrites existing files', async () => {
    await seedFeaturePack({
      cwd,
      slug: 'sample-app',
      languages: ['typescript'],
      force: false,
      dryRun: false,
    });

    const implPath = join(cwd, 'docs', 'feature-packs', 'sample-app', 'implementation.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(implPath, 'will be overwritten', 'utf8');

    const outcomes = await seedFeaturePack({
      cwd,
      slug: 'sample-app',
      languages: ['typescript'],
      force: true,
      dryRun: false,
    });
    for (const outcome of outcomes) {
      expect(outcome.action).toBe('forced');
    }
    const after = await readFile(implPath, 'utf8');
    expect(after).toContain('# sample-app — Implementation');
  });
});
