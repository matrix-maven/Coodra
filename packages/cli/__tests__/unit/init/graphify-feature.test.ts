import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFeatureMd } from '@coodra/shared/features';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  GRAPHIFY_SEED_FEATURE_SLUG,
  renderGraphifySeedPacksFeature,
  seedGraphifySeedPacksFeature,
} from '../../../src/lib/init/graphify-feature.js';

/**
 * Locks the Module 09 Track 9B `graphify-seed-packs` Feature recipe —
 * the bundled skill that drives the Graphify→Coodra fusion. The recipe
 * is embedded (no asset file); the seeder writes it idempotently into
 * `docs/features/` and regenerates the features index.
 */

const FEATURE_MD = join('docs', 'features', GRAPHIFY_SEED_FEATURE_SLUG, 'feature.md');
const INDEX_JSON = join('docs', 'features', 'INDEX.json');

describe('renderGraphifySeedPacksFeature', () => {
  it('is deterministic — two renders are byte-identical', () => {
    expect(renderGraphifySeedPacksFeature()).toBe(renderGraphifySeedPacksFeature());
  });

  it('renders a feature.md that parses cleanly with no errors or quality warnings', () => {
    const parsed = parseFeatureMd(renderGraphifySeedPacksFeature());
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.frontmatter).not.toBeNull();
    expect(parsed.frontmatter?.name).toBe('graphify-seed-packs');
    expect(parsed.frontmatter?.maturity).toBe('beta');
  });

  it('names the seed tool + the graph artifact in the body', () => {
    const rendered = renderGraphifySeedPacksFeature();
    expect(rendered).toContain('coodra__seed_feature_packs_from_graph');
    expect(rendered).toContain('graphify-out/graph.json');
  });
});

describe('seedGraphifySeedPacksFeature', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-graphify-feature-'));
  });

  it('greenfield: writes feature.md and regenerates the index', async () => {
    const result = await seedGraphifySeedPacksFeature({ cwd, projectSlug: 'demo', force: false, dryRun: false });
    expect(result.action).toBe('wrote');
    const featureMd = await readFile(join(cwd, FEATURE_MD), 'utf8');
    expect(featureMd).toContain('name: graphify-seed-packs');
    const index = JSON.parse(await readFile(join(cwd, INDEX_JSON), 'utf8'));
    expect(index.projectSlug).toBe('demo');
    expect(index.features.map((f: { slug: string }) => f.slug)).toContain(GRAPHIFY_SEED_FEATURE_SLUG);
  });

  it('is idempotent — a second seed is unchanged', async () => {
    await seedGraphifySeedPacksFeature({ cwd, projectSlug: 'demo', force: false, dryRun: false });
    const second = await seedGraphifySeedPacksFeature({ cwd, projectSlug: 'demo', force: false, dryRun: false });
    expect(second.action).toBe('unchanged');
    expect(second.notes).toContain('already up to date');
  });

  it('preserves a user-edited feature.md without --force', async () => {
    const dir = join(cwd, 'docs', 'features', GRAPHIFY_SEED_FEATURE_SLUG);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'feature.md'),
      '---\nname: graphify-seed-packs\ndescription: my edits\n---\n\nmine\n',
      'utf8',
    );
    const result = await seedGraphifySeedPacksFeature({ cwd, projectSlug: 'demo', force: false, dryRun: false });
    expect(result.action).toBe('unchanged');
    expect(result.notes).toContain('--force');
    expect(await readFile(join(cwd, FEATURE_MD), 'utf8')).toContain('my edits');
  });

  it('--force overwrites a user-edited feature.md', async () => {
    const dir = join(cwd, 'docs', 'features', GRAPHIFY_SEED_FEATURE_SLUG);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'feature.md'),
      '---\nname: graphify-seed-packs\ndescription: my edits\n---\n\nmine\n',
      'utf8',
    );
    const result = await seedGraphifySeedPacksFeature({ cwd, projectSlug: 'demo', force: true, dryRun: false });
    expect(result.action).toBe('forced');
    expect(await readFile(join(cwd, FEATURE_MD), 'utf8')).toContain('coodra__seed_feature_packs_from_graph');
  });

  it('--dry-run writes nothing to disk', async () => {
    const result = await seedGraphifySeedPacksFeature({ cwd, projectSlug: 'demo', force: false, dryRun: true });
    expect(result.action).toBe('wrote');
    await expect(readFile(join(cwd, FEATURE_MD), 'utf8')).rejects.toThrow();
  });
});
