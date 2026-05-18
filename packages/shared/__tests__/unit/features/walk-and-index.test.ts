import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateFeaturesIndex, renderIndexMd } from '../../../src/features/index-gen.js';
import { renderFeatureMd } from '../../../src/features/parse.js';
import { featuresRoot, readFeatureRow, walkFeatures } from '../../../src/features/walk.js';

/**
 * Phase A unit tests — filesystem walker + INDEX generator.
 *
 * These tests use real tmp directories (not mocks) because the walker's
 * whole job is to interact correctly with the filesystem: stat readings,
 * directory recursion, hidden-file skipping, slug-regex validation,
 * mtime aggregation. Mocking that layer would test our mocks rather
 * than the behaviour the bridge / CLI / web actually depend on.
 */

let projectCwd: string;

beforeEach(() => {
  projectCwd = mkdtempSync(join(tmpdir(), 'cos-features-'));
});

afterEach(() => {
  rmSync(projectCwd, { recursive: true, force: true });
});

function writeFeature(slug: string, body: string, files: Record<string, string> = {}): void {
  const dir = join(featuresRoot(projectCwd), slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'feature.md'), body, 'utf8');
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
}

describe('walkFeatures', () => {
  it('returns an empty array when docs/features/ does not exist', () => {
    expect(walkFeatures(projectCwd)).toEqual([]);
  });

  it('returns an empty array when docs/features/ exists but contains no features', () => {
    mkdirSync(featuresRoot(projectCwd), { recursive: true });
    expect(walkFeatures(projectCwd)).toEqual([]);
  });

  it('lists every direct child directory with a parseable feature.md', () => {
    writeFeature(
      'auth',
      renderFeatureMd({
        frontmatter: { name: 'auth', description: 'Use this when working on `login` and JWT validation.' },
        body: '# Auth\n',
      }),
    );
    writeFeature(
      'payments-flow',
      renderFeatureMd({
        frontmatter: {
          name: 'payments-flow',
          description: 'Use this when working on Stripe `charge` / `refund` flows.',
        },
        body: '# Payments\n',
      }),
    );
    const rows = walkFeatures(projectCwd);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.slug)).toEqual(['auth', 'payments-flow']); // sorted
    expect(rows[0]?.frontmatter.name).toBe('auth');
  });

  it('skips dotfile entries, INDEX files, and slug-regex misses', () => {
    mkdirSync(featuresRoot(projectCwd), { recursive: true });
    // INDEX siblings
    writeFileSync(join(featuresRoot(projectCwd), 'INDEX.md'), '# stale', 'utf8');
    writeFileSync(join(featuresRoot(projectCwd), 'INDEX.json'), '{}', 'utf8');
    // dotfile
    writeFileSync(join(featuresRoot(projectCwd), '.gitkeep'), '', 'utf8');
    // illegal slug
    mkdirSync(join(featuresRoot(projectCwd), 'NotAValidSlug'));
    // valid feature
    writeFeature(
      'good',
      renderFeatureMd({
        frontmatter: { name: 'good', description: 'Use this when calling the `good` handler in /src/good.ts.' },
        body: 'body\n',
      }),
    );
    const rows = walkFeatures(projectCwd);
    expect(rows.map((r) => r.slug)).toEqual(['good']);
  });

  it('lists supporting files recursively, depth-capped, with feature.md excluded', () => {
    writeFeature(
      'with-files',
      renderFeatureMd({
        frontmatter: { name: 'with-files', description: 'Use this when calling the `withFiles` handler in /src/x.ts.' },
        body: 'body\n',
      }),
      {
        'examples/refund.ts': 'export const x = 1;\n',
        'examples/charge.ts': 'export const y = 2;\n',
        'reference.md': '# ref\n',
      },
    );
    const rows = walkFeatures(projectCwd);
    expect(rows).toHaveLength(1);
    const f = rows[0];
    if (f === undefined) throw new Error('expected one row');
    expect(f.files.map((x) => x.path).sort()).toEqual(['examples/charge.ts', 'examples/refund.ts', 'reference.md']);
    // feature.md is metadata, not a supporting file
    expect(f.files.every((x) => x.path !== 'feature.md')).toBe(true);
  });

  it('surfaces parse errors as warnings instead of dropping the row', () => {
    const slug = 'broken';
    const dir = join(featuresRoot(projectCwd), slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'feature.md'), '# no frontmatter\n\njust a body\n', 'utf8');
    const rows = walkFeatures(projectCwd);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.warnings.some((w) => /frontmatter_missing_open_fence/.test(w))).toBe(true);
  });

  it('warns on slug/name mismatch', () => {
    writeFeature(
      'cart',
      renderFeatureMd({
        frontmatter: {
          name: 'cart-checkout', // mismatch with directory `cart`
          description: 'Use this when working on /src/cart/checkout.ts and the `Cart` component.',
        },
        body: 'body\n',
      }),
    );
    const rows = walkFeatures(projectCwd);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.warnings.some((w) => /frontmatter_name_mismatch/.test(w))).toBe(true);
  });
});

describe('readFeatureRow', () => {
  it('returns null when feature.md is missing', () => {
    const dir = join(featuresRoot(projectCwd), 'no-md');
    mkdirSync(dir, { recursive: true });
    expect(readFeatureRow('no-md', dir)).toBeNull();
  });
});

describe('generateFeaturesIndex', () => {
  it('creates docs/features/ if missing and writes an empty-state INDEX', () => {
    const result = generateFeaturesIndex({ projectCwd, projectSlug: 'widget-shop' });
    expect(result.changed).toBe(true);
    expect(result.index.features).toEqual([]);
    const md = readFileSync(result.indexMdPath, 'utf8');
    expect(md).toContain('no features yet');
    expect(md).toContain('widget-shop');
    const json = JSON.parse(readFileSync(result.indexJsonPath, 'utf8'));
    expect(json.version).toBe(1);
    expect(json.features).toEqual([]);
  });

  it('writes a complete INDEX.json + INDEX.md when features exist', () => {
    writeFeature(
      'auth',
      renderFeatureMd({
        frontmatter: {
          name: 'auth',
          description: 'Use this when working on `login` flows or JWT validation.',
          maturity: 'stable',
          tags: ['auth', 'security'],
        },
        body: '# Auth\n',
      }),
    );
    writeFeature(
      'payments',
      renderFeatureMd({
        frontmatter: {
          name: 'payments',
          description: 'Use this when working on `Stripe.charge` and refund webhooks.',
          maturity: 'beta',
        },
        body: '# Payments\n',
      }),
      { 'reference.md': 'ref\n' },
    );
    const result = generateFeaturesIndex({ projectCwd, projectSlug: 'shop' });
    expect(result.changed).toBe(true);
    expect(result.index.features.map((f) => f.slug)).toEqual(['auth', 'payments']);
    const md = readFileSync(result.indexMdPath, 'utf8');
    expect(md).toContain('## auth');
    expect(md).toContain('## payments');
    expect(md).toContain('Use this when working on `Stripe.charge`');
    // The beta feature's maturity should surface:
    expect(md).toContain('_beta_');
  });

  it('is idempotent — second run with no changes does not rewrite', () => {
    writeFeature(
      'foo',
      renderFeatureMd({
        frontmatter: { name: 'foo', description: 'Use this when working on `foo` operations.' },
        body: 'body\n',
      }),
    );
    const a = generateFeaturesIndex({ projectCwd, projectSlug: 'shop' });
    expect(a.changed).toBe(true);
    const b = generateFeaturesIndex({ projectCwd, projectSlug: 'shop' });
    expect(b.changed).toBe(false);
    // Same byte content
    const aMd = readFileSync(a.indexMdPath, 'utf8');
    const bMd = readFileSync(b.indexMdPath, 'utf8');
    expect(aMd).toBe(bMd);
  });

  it('is deterministic — same input produces byte-identical output', () => {
    const fixedNow = new Date('2026-05-08T12:00:00Z');
    writeFeature(
      'foo',
      renderFeatureMd({
        frontmatter: { name: 'foo', description: 'Use this when working on `foo` operations.' },
        body: 'body\n',
      }),
    );
    const a = generateFeaturesIndex({ projectCwd, projectSlug: 'shop', forceWrite: true, nowOverride: fixedNow });
    const b = generateFeaturesIndex({ projectCwd, projectSlug: 'shop', forceWrite: true, nowOverride: fixedNow });
    expect(a.index).toEqual(b.index);
  });

  it('reports slugs with warnings so the UI can show a fix-me badge', () => {
    writeFeature(
      'unfortunate',
      renderFeatureMd({
        frontmatter: { name: 'unfortunate', description: 'Implements stuff.' }, // short + no imperative + no concrete signal
        body: 'body\n',
      }),
    );
    const result = generateFeaturesIndex({ projectCwd, projectSlug: 'shop' });
    expect(result.slugsWithWarnings).toEqual(['unfortunate']);
    expect(result.index.features[0]?.hasWarnings).toBe(true);
  });
});

describe('renderIndexMd', () => {
  it('renders a stable empty-state when there are no features', () => {
    const md = renderIndexMd({
      version: 1,
      projectSlug: 'shop',
      generatedAt: '2026-05-08T00:00:00.000Z',
      indexerSourceMtime: 0,
      features: [],
    });
    expect(md).toContain('no features yet');
    expect(md).toContain('shop');
  });

  it('emits a Load via line for every feature so agents see the canonical MCP call', () => {
    const md = renderIndexMd({
      version: 1,
      projectSlug: 'shop',
      generatedAt: '2026-05-08T00:00:00.000Z',
      indexerSourceMtime: 0,
      features: [
        {
          slug: 'auth',
          name: 'auth',
          description: 'Use this when working on `login` flows.',
          whenNotToUse: null,
          maturity: 'stable',
          owners: [],
          tags: [],
          fileCount: 1,
          totalBytes: 512,
          lastUpdatedAt: '2026-05-08T00:00:00.000Z',
          hasWarnings: false,
        },
      ],
    });
    expect(md).toContain('coodra__get_feature({slug:"auth"})');
  });
});
