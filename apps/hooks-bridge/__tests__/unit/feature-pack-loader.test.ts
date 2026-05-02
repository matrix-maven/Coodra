import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadFeaturePackForSession } from '../../src/lib/feature-pack-loader.js';

/**
 * Locks the slim feature-pack reader contract (decision dec_83ba10c1,
 * 2026-05-02). The bridge SessionStart handler depends on these
 * guarantees:
 *
 *   1. spec.md is required; if it's missing the loader returns null
 *      so the handler skips `additionalContext` injection.
 *   2. implementation.md and techstack.md are optional — the loader
 *      still returns the spec body when either is missing.
 *   3. The returned content is a single Markdown blob with H1
 *      sections so the agent can scan section headers.
 *   4. Path-traversal slugs are refused (defence-in-depth: a
 *      malicious `.contextos.json` cannot make the loader read
 *      `../../etc/passwd`).
 */
describe('loadFeaturePackForSession', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'contextos-fp-loader-test-'));
  });
  afterEach(() => {
    /* tmp cleaned by OS */
  });

  it('returns null when spec.md is missing', async () => {
    const slug = 'no-spec';
    await mkdir(join(cwd, 'docs', 'feature-packs', slug), { recursive: true });
    // implementation/techstack present but no spec.md.
    await writeFile(join(cwd, 'docs', 'feature-packs', slug, 'implementation.md'), 'i', 'utf8');

    const result = await loadFeaturePackForSession({ cwd, projectSlug: slug });
    expect(result).toBeNull();
  });

  it('returns the spec when implementation + techstack are missing', async () => {
    const slug = 'spec-only';
    await mkdir(join(cwd, 'docs', 'feature-packs', slug), { recursive: true });
    await writeFile(join(cwd, 'docs', 'feature-packs', slug, 'spec.md'), '# Spec body', 'utf8');

    const result = await loadFeaturePackForSession({ cwd, projectSlug: slug });
    expect(result).not.toBeNull();
    expect(result?.slug).toBe('spec-only');
    expect(result?.content).toContain('# ContextOS Feature Pack — spec-only');
    expect(result?.content).toContain('## spec.md');
    expect(result?.content).toContain('# Spec body');
    expect(result?.content).not.toContain('## implementation.md');
    expect(result?.content).not.toContain('## techstack.md');
  });

  it('concatenates spec → implementation → techstack with section headers', async () => {
    const slug = 'all-three';
    await mkdir(join(cwd, 'docs', 'feature-packs', slug), { recursive: true });
    await writeFile(join(cwd, 'docs', 'feature-packs', slug, 'spec.md'), 'spec body', 'utf8');
    await writeFile(join(cwd, 'docs', 'feature-packs', slug, 'implementation.md'), 'impl body', 'utf8');
    await writeFile(join(cwd, 'docs', 'feature-packs', slug, 'techstack.md'), 'tech body', 'utf8');

    const result = await loadFeaturePackForSession({ cwd, projectSlug: slug });
    expect(result).not.toBeNull();
    const order = result?.content.indexOf('spec body') ?? -1;
    const orderImpl = result?.content.indexOf('impl body') ?? -1;
    const orderTech = result?.content.indexOf('tech body') ?? -1;
    expect(order).toBeGreaterThan(0);
    expect(orderImpl).toBeGreaterThan(order);
    expect(orderTech).toBeGreaterThan(orderImpl);
  });

  it('refuses path-traversal slugs (escape attempt returns null)', async () => {
    const result = await loadFeaturePackForSession({ cwd, projectSlug: '../../../../etc' });
    expect(result).toBeNull();
  });
});
