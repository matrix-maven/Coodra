import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureProjectConfig,
  projectConfigPath,
  readProjectConfig,
  writeProjectConfig,
} from '../../../src/lib/project-store/config.js';

/**
 * Locks the project-local identity contract: `.coodra/config.json` is the new
 * home, no root `.coodra.json` is written, creation is idempotent, and a
 * user-edited slug is preserved without --force.
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
  it('writeProjectConfig writes only .coodra/config.json', async () => {
    const outcomes = await writeProjectConfig({
      root,
      projectSlug: 'demo',
      mode: 'solo',
      force: false,
      dryRun: false,
      now: CLOCK,
    });
    expect(outcomes.map((o) => o.action)).toEqual(['wrote']);

    const fresh = JSON.parse(readFileSync(projectConfigPath(root), 'utf8'));
    expect(fresh).toMatchObject({
      version: 1,
      projectSlug: 'demo',
      mode: 'solo',
      createdAt: CLOCK(),
      updatedAt: CLOCK(),
    });
    expect(existsSync(join(root, '.coodra.json'))).toBe(false);
  });

  it('readProjectConfig reads .coodra/config.json', async () => {
    mkdirSync(join(root, '.coodra'), { recursive: true });
    writeFileSync(projectConfigPath(root), JSON.stringify({ version: 1, projectSlug: 'fresh' }));
    const cfg = await readProjectConfig(root);
    expect(cfg?.projectSlug).toBe('fresh');
  });

  it('readProjectConfig returns null when neither file exists', async () => {
    expect(await readProjectConfig(root)).toBeNull();
  });

  it('ensureProjectConfig creates the project config (createdConfig=true), idempotent on re-run', async () => {
    expect(existsSync(projectConfigPath(root))).toBe(false);

    const first = await ensureProjectConfig({
      root,
      projectSlug: 'demo',
      force: false,
      dryRun: false,
      now: CLOCK,
    });
    expect(first.createdConfig).toBe(true);
    expect(JSON.parse(readFileSync(projectConfigPath(root), 'utf8')).projectSlug).toBe('demo');

    const second = await ensureProjectConfig({
      root,
      projectSlug: 'demo',
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
  });
});
