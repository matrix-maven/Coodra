import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyGeneratedPath,
  type ManifestEntryInput,
  pruneManifestEntries,
  readManifest,
  recordManifestEntries,
} from '../../../src/lib/project-store/manifest.js';

let root: string;
const CLOCK = () => '2026-07-19T00:00:00.000Z';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coodra-mf-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function entry(path: string, over: Partial<ManifestEntryInput> = {}): ManifestEntryInput {
  return {
    path,
    scope: 'project',
    owner: 'coodra',
    kind: 'generated',
    createdBy: 'test',
    cleanup: 'ask',
    safeToDelete: true,
    ...over,
  };
}

describe('project-store manifest — record/read/prune', () => {
  it('records entries + reads them back, sorted by (scope, path)', async () => {
    await recordManifestEntries({
      root,
      projectSlug: 'demo',
      entries: [entry('.codex/config.toml'), entry('AGENTS.md', { owner: 'agent:codex' })],
      dryRun: false,
      now: CLOCK,
    });
    const m = await readManifest(root);
    expect(m?.projectSlug).toBe('demo');
    expect(m?.entries.map((e) => e.path)).toEqual(['.codex/config.toml', 'AGENTS.md']);
    expect(m?.entries.every((e) => e.updatedAt === CLOCK())).toBe(true);
  });

  it('is idempotent — re-recording a path updates in place (no duplicates)', async () => {
    await recordManifestEntries({
      root,
      projectSlug: 'demo',
      entries: [entry('.codex/config.toml', { kind: 'mcp-config' })],
      dryRun: false,
      now: CLOCK,
    });
    await recordManifestEntries({
      root,
      projectSlug: 'demo',
      entries: [entry('.codex/config.toml', { kind: 'updated-kind' })],
      dryRun: false,
      now: CLOCK,
    });
    const m = await readManifest(root);
    expect(m?.entries).toHaveLength(1);
    expect(m?.entries[0]?.kind).toBe('updated-kind');
  });

  it('prune removes only the named paths, returns what was present', async () => {
    await recordManifestEntries({
      root,
      projectSlug: 'demo',
      entries: [entry('.codex/config.toml'), entry('AGENTS.md'), entry('.coodra/config.json', { cleanup: 'preserve' })],
      dryRun: false,
      now: CLOCK,
    });
    const removed = await pruneManifestEntries(root, ['.codex/config.toml', '.not-there'], { dryRun: false });
    expect(removed).toEqual(['.codex/config.toml']);
    const m = await readManifest(root);
    expect(m?.entries.map((e) => e.path).sort()).toEqual(['.coodra/config.json', 'AGENTS.md']);
  });

  it('--dry-run records nothing to disk', async () => {
    await recordManifestEntries({
      root,
      projectSlug: 'demo',
      entries: [entry('.codex/config.toml')],
      dryRun: true,
      now: CLOCK,
    });
    expect(await readManifest(root)).toBeNull();
  });

  it('drops hostile project paths when reading a hand-edited manifest', async () => {
    await mkdir(join(root, '.coodra'), { recursive: true });
    await writeFile(
      join(root, '.coodra', 'manifest.json'),
      JSON.stringify({
        version: 1,
        projectSlug: 'demo',
        entries: [
          entry('safe/generated.txt'),
          entry('/tmp/outside.txt'),
          entry('../outside.txt'),
          entry('nested/../outside.txt'),
          entry('C:\\outside.txt'),
        ],
      }),
      'utf8',
    );
    const m = await readManifest(root);
    expect(m?.entries.map((e) => e.path)).toEqual(['safe/generated.txt']);
  });

  it('refuses to record absolute or dot-dot project paths', async () => {
    await expect(
      recordManifestEntries({
        root,
        projectSlug: 'demo',
        entries: [entry('/tmp/outside.txt')],
        dryRun: false,
        now: CLOCK,
      }),
    ).rejects.toThrow();
    await expect(
      recordManifestEntries({
        root,
        projectSlug: 'demo',
        entries: [entry('../outside.txt')],
        dryRun: false,
        now: CLOCK,
      }),
    ).rejects.toThrow();
  });
});

describe('project-store manifest — classifyGeneratedPath', () => {
  it('classifies project files by kind + cleanup policy', () => {
    const cases: Array<[string, { owner: string; kind: string; cleanup: string; scope: string }]> = [
      ['.coodra/config.json', { owner: 'coodra', kind: 'project-config', cleanup: 'preserve', scope: 'project' }],
      ['.env', { owner: 'coodra', kind: 'env', cleanup: 'preserve', scope: 'project' }],
      ['data.db', { owner: 'coodra', kind: 'sqlite-db', cleanup: 'preserve', scope: 'project' }],
      ['logs', { owner: 'coodra', kind: 'logs-dir', cleanup: 'preserve', scope: 'project' }],
      ['pids', { owner: 'coodra', kind: 'pids-dir', cleanup: 'preserve', scope: 'project' }],
      ['.codex/config.toml', { owner: 'agent:codex', kind: 'mcp-config', cleanup: 'ask', scope: 'project' }],
      ['AGENTS.md', { owner: 'agent:codex', kind: 'instruction-file', cleanup: 'ask', scope: 'project' }],
      ['CLAUDE.md', { owner: 'agent:claude', kind: 'instruction-file', cleanup: 'ask', scope: 'project' }],
    ];
    for (const [rel, expected] of cases) {
      const e = classifyGeneratedPath(join(root, rel), root, 'coodra init');
      expect({ owner: e.owner, kind: e.kind, cleanup: e.cleanup, scope: e.scope }, rel).toMatchObject(expected);
      expect(e.path).toBe(rel); // project-relative, posix
    }
  });

  it('classifies GLOBAL files (outside root) as scope=global, always preserve', () => {
    const settings = '/Users/someone/.claude/settings.json';
    const e = classifyGeneratedPath(settings, root, 'coodra agent add claude');
    expect(e.scope).toBe('global');
    expect(e.path).toBe(settings); // absolute preserved
    expect(e.owner).toBe('agent:claude');
    expect(e.cleanup).toBe('preserve');
    expect(e.safeToDelete).toBe(false);
  });
});
