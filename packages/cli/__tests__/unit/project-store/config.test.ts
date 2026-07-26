import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureProjectConfig,
  legacyConfigPath,
  projectConfigPath,
  readProjectConfig,
  writeProjectConfig,
} from '../../../src/lib/project-store/config.js';

/**
 * Locks the project-local identity contract: `.coodra/config.json` is the new
 * home, `.coodra.json` is the legacy fallback + dual-write target, migration is
 * idempotent, and a user-edited slug is preserved without --force.
 */

let root: string;
const CLOCK = () => '2026-07-19T00:00:00.000Z';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coodra-cfg-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('project-store config', () => {
  it('writeProjectConfig dual-writes .coodra/config.json (rich) + .coodra.json (legacy)', async () => {
    const outcomes = await writeProjectConfig({
      root,
      projectSlug: 'demo',
      mode: 'solo',
      force: false,
      dryRun: false,
      now: CLOCK,
    });
    expect(outcomes.map((o) => o.action)).toEqual(['wrote', 'wrote']);

    const fresh = JSON.parse(readFileSync(projectConfigPath(root), 'utf8'));
    expect(fresh).toMatchObject({
      version: 1,
      projectSlug: 'demo',
      mode: 'solo',
      createdAt: CLOCK(),
      updatedAt: CLOCK(),
    });
    const legacy = JSON.parse(readFileSync(legacyConfigPath(root), 'utf8'));
    expect(legacy).toEqual({ projectSlug: 'demo' });
  });

  it('readProjectConfig prefers .coodra/config.json over the legacy file', async () => {
    mkdirSync(join(root, '.coodra'), { recursive: true });
    writeFileSync(projectConfigPath(root), JSON.stringify({ version: 1, projectSlug: 'fresh' }));
    writeFileSync(legacyConfigPath(root), JSON.stringify({ projectSlug: 'legacy' }));
    const cfg = await readProjectConfig(root);
    expect(cfg?.projectSlug).toBe('fresh');
  });

  it('readProjectConfig falls back to legacy .coodra.json when the new file is absent', async () => {
    writeFileSync(legacyConfigPath(root), JSON.stringify({ projectSlug: 'legacy-only' }));
    const cfg = await readProjectConfig(root);
    expect(cfg).toEqual({ version: 1, projectSlug: 'legacy-only' });
  });

  it('readProjectConfig returns null when neither file exists', async () => {
    expect(await readProjectConfig(root)).toBeNull();
  });

  it('ensureProjectConfig migrates a legacy-only project (createdConfig=true), idempotent on re-run', async () => {
    writeFileSync(legacyConfigPath(root), JSON.stringify({ projectSlug: 'to-migrate' }));
    expect(existsSync(projectConfigPath(root))).toBe(false);

    const first = await ensureProjectConfig({
      root,
      projectSlug: 'to-migrate',
      force: false,
      dryRun: false,
      now: CLOCK,
    });
    expect(first.createdConfig).toBe(true);
    expect(JSON.parse(readFileSync(projectConfigPath(root), 'utf8')).projectSlug).toBe('to-migrate');

    const second = await ensureProjectConfig({
      root,
      projectSlug: 'to-migrate',
      force: false,
      dryRun: false,
      now: CLOCK,
    });
    expect(second.createdConfig).toBe(false);
  });

  it('preserves createdAt + unknown fields on a merge write, bumps updatedAt', async () => {
    mkdirSync(join(root, '.coodra'), { recursive: true });
    writeFileSync(
      projectConfigPath(root),
      JSON.stringify({
        version: 1,
        projectSlug: 'demo',
        createdAt: '2020-01-01T00:00:00.000Z',
        projectId: 'proj_keepme',
      }),
    );
    await writeProjectConfig({ root, projectSlug: 'demo', mode: 'team', force: false, dryRun: false, now: CLOCK });
    const cfg = JSON.parse(readFileSync(projectConfigPath(root), 'utf8'));
    expect(cfg.createdAt).toBe('2020-01-01T00:00:00.000Z'); // preserved
    expect(cfg.updatedAt).toBe(CLOCK()); // bumped
    expect(cfg.projectId).toBe('proj_keepme'); // unknown field retained
    expect(cfg.mode).toBe('team');
  });

  it('does NOT overwrite a user-edited slug without --force (drift preserved)', async () => {
    mkdirSync(join(root, '.coodra'), { recursive: true });
    writeFileSync(projectConfigPath(root), JSON.stringify({ version: 1, projectSlug: 'user-chosen' }));
    const outcomes = await writeProjectConfig({
      root,
      projectSlug: 'different',
      force: false,
      dryRun: false,
      now: CLOCK,
    });
    expect(outcomes[0]?.action).toBe('unchanged');
    expect(JSON.parse(readFileSync(projectConfigPath(root), 'utf8')).projectSlug).toBe('user-chosen');
  });

  it('--force overwrites a drifted slug', async () => {
    mkdirSync(join(root, '.coodra'), { recursive: true });
    writeFileSync(projectConfigPath(root), JSON.stringify({ version: 1, projectSlug: 'user-chosen' }));
    const outcomes = await writeProjectConfig({ root, projectSlug: 'forced', force: true, dryRun: false, now: CLOCK });
    expect(outcomes[0]?.action).toBe('forced');
    expect(JSON.parse(readFileSync(projectConfigPath(root), 'utf8')).projectSlug).toBe('forced');
  });

  it('--dry-run writes nothing', async () => {
    await writeProjectConfig({ root, projectSlug: 'demo', force: false, dryRun: true, now: CLOCK });
    expect(existsSync(projectConfigPath(root))).toBe(false);
    expect(existsSync(legacyConfigPath(root))).toBe(false);
  });
});
