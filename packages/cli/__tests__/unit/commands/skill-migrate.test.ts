import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type FeatureIO, runFeatureMigrateCommand } from '../../../src/commands/feature.js';

/**
 * `coodra recipe migrate` — relocate legacy docs/skills/ and docs/features/
 * trees to .coodra/recipes/. Mirrors the "never relocate silently" principle:
 * per-slug merge, with refusal on a slug collision without --force.
 */

function captureIO(): { io: FeatureIO; out: () => string; err: () => string; code: () => number | null } {
  let outBuf = '';
  let errBuf = '';
  let exitCode: number | null = null;
  const io: FeatureIO = {
    writeStdout: (c) => {
      outBuf += c;
    },
    writeStderr: (c) => {
      errBuf += c;
    },
    exit: (code) => {
      exitCode = code;
      throw new Error(`__exit__:${code}`);
    },
  };
  return { io, out: () => outBuf, err: () => errBuf, code: () => exitCode };
}

async function run(fn: () => Promise<never>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith('__exit__:')) throw e;
  }
}

let cwd: string;

function writeSkill(dirName: 'features' | 'skills', slug: string, body = 'placeholder body'): void {
  const dir = join(cwd, 'docs', dirName, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'feature.md'),
    `---\nname: ${slug}\ndescription: Use this when working on ${slug}.\n---\n\n${body}\n`,
    'utf8',
  );
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'skill-migrate-'));
  mkdirSync(join(cwd, '.coodra'), { recursive: true });
  writeFileSync(join(cwd, '.coodra', 'config.json'), JSON.stringify({ version: 1, projectSlug: 'demo' }), 'utf8');
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe('runFeatureMigrateCommand', () => {
  it('greenfield (no docs/features or docs/skills) → nothing to migrate', async () => {
    const cap = captureIO();
    await run(() => runFeatureMigrateCommand({ cwd, json: true }, cap.io));
    const r = JSON.parse(cap.out());
    expect(r).toMatchObject({ ok: true, migrated: false, reason: 'nothing_to_migrate' });
    expect(cap.code()).toBe(0);
  });

  it('only docs/skills exists → migrates to .coodra/recipes and indexes', async () => {
    writeSkill('skills', 'auth');
    const cap = captureIO();
    await run(() => runFeatureMigrateCommand({ cwd, json: true }, cap.io));
    expect(JSON.parse(cap.out())).toMatchObject({ migrated: true });
    expect(existsSync(join(cwd, '.coodra', 'recipes', 'auth', 'feature.md'))).toBe(true);
    expect(existsSync(join(cwd, '.coodra', 'recipes', 'INDEX.json'))).toBe(true);
    expect(existsSync(join(cwd, 'docs', 'skills'))).toBe(false);
  });

  it('only legacy docs/features → migrates to .coodra/recipes and indexes', async () => {
    writeSkill('features', 'auth');
    writeSkill('features', 'payments');
    const cap = captureIO();
    await run(() => runFeatureMigrateCommand({ cwd, json: true }, cap.io));
    const r = JSON.parse(cap.out());
    expect(r.migrated).toBe(true);
    expect(r.movedSlugs.sort()).toEqual(['auth from docs/features/', 'payments from docs/features/']);
    expect(existsSync(join(cwd, '.coodra', 'recipes', 'auth', 'feature.md'))).toBe(true);
    expect(existsSync(join(cwd, '.coodra', 'recipes', 'payments', 'feature.md'))).toBe(true);
    expect(existsSync(join(cwd, 'docs', 'features'))).toBe(false);
    expect(existsSync(join(cwd, '.coodra', 'recipes', 'INDEX.json'))).toBe(true);
  });

  it('both legacy dirs exist, no slug collision → merges both into recipes and removes empty legacy dirs', async () => {
    writeSkill('skills', 'auth');
    writeSkill('features', 'billing');
    const cap = captureIO();
    await run(() => runFeatureMigrateCommand({ cwd, json: true }, cap.io));
    expect(JSON.parse(cap.out()).movedSlugs.sort()).toEqual(['auth from docs/skills/', 'billing from docs/features/']);
    expect(existsSync(join(cwd, '.coodra', 'recipes', 'auth', 'feature.md'))).toBe(true);
    expect(existsSync(join(cwd, '.coodra', 'recipes', 'billing', 'feature.md'))).toBe(true);
    expect(existsSync(join(cwd, 'docs', 'skills'))).toBe(false);
    expect(existsSync(join(cwd, 'docs', 'features'))).toBe(false);
  });

  it('both exist with a slug collision → refuses without --force, leaving both in place', async () => {
    writeSkill('skills', 'auth', 'SKILLS COPY');
    writeSkill('features', 'auth', 'LEGACY COPY');
    const cap = captureIO();
    await run(() => runFeatureMigrateCommand({ cwd, json: false }, cap.io));
    expect(cap.code()).toBe(1);
    expect(cap.err()).toMatch(/would collide/);
    // Neither copy was touched.
    expect(readFileSync(join(cwd, 'docs', 'skills', 'auth', 'feature.md'), 'utf8')).toContain('SKILLS COPY');
    expect(readFileSync(join(cwd, 'docs', 'features', 'auth', 'feature.md'), 'utf8')).toContain('LEGACY COPY');
  });

  it('--force resolves a collision by overwriting the earlier copy with the later legacy one', async () => {
    writeSkill('skills', 'auth', 'SKILLS COPY');
    writeSkill('features', 'auth', 'LEGACY COPY');
    const cap = captureIO();
    await run(() => runFeatureMigrateCommand({ cwd, force: true, json: true }, cap.io));
    expect(JSON.parse(cap.out()).movedSlugs).toEqual(['auth from docs/skills/', 'auth from docs/features/']);
    expect(readFileSync(join(cwd, '.coodra', 'recipes', 'auth', 'feature.md'), 'utf8')).toContain('LEGACY COPY');
    expect(existsSync(join(cwd, 'docs', 'skills'))).toBe(false);
    expect(existsSync(join(cwd, 'docs', 'features'))).toBe(false);
  });
});
