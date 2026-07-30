import { mkdtempSync, rmSync } from 'node:fs';
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
      entries: [entry('.mcp.json'), entry('.cursorrules', { owner: 'agent:cursor' })],
      dryRun: false,
      now: CLOCK,
    });
    const m = await readManifest(root);
    expect(m?.projectSlug).toBe('demo');
    expect(m?.entries.map((e) => e.path)).toEqual(['.cursorrules', '.mcp.json']);
    expect(m?.entries.every((e) => e.updatedAt === CLOCK())).toBe(true);
  });

  it('is idempotent — re-recording a path updates in place (no duplicates)', async () => {
    await recordManifestEntries({
      root,
      projectSlug: 'demo',
      entries: [entry('.mcp.json', { kind: 'mcp-config' })],
      dryRun: false,
      now: CLOCK,
    });
    await recordManifestEntries({
      root,
      projectSlug: 'demo',
      entries: [entry('.mcp.json', { kind: 'updated-kind' })],
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
      entries: [entry('.mcp.json'), entry('.cursorrules'), entry('.coodra/config.json', { cleanup: 'preserve' })],
      dryRun: false,
      now: CLOCK,
    });
    const removed = await pruneManifestEntries(root, ['.mcp.json', '.not-there'], { dryRun: false });
    expect(removed).toEqual(['.mcp.json']);
    const m = await readManifest(root);
    expect(m?.entries.map((e) => e.path).sort()).toEqual(['.coodra/config.json', '.cursorrules']);
  });

  it('--dry-run records nothing to disk', async () => {
    await recordManifestEntries({ root, projectSlug: 'demo', entries: [entry('.mcp.json')], dryRun: true, now: CLOCK });
    expect(await readManifest(root)).toBeNull();
  });
});

describe('project-store manifest — classifyGeneratedPath', () => {
  it('classifies project files by kind + cleanup policy', () => {
    const cases: Array<[string, { owner: string; kind: string; cleanup: string; scope: string }]> = [
      ['.coodra/config.json', { owner: 'coodra', kind: 'project-config', cleanup: 'preserve', scope: 'project' }],
      ['.mcp.json', { owner: 'coodra', kind: 'mcp-config', cleanup: 'ask', scope: 'project' }],
      ['.env', { owner: 'coodra', kind: 'env', cleanup: 'preserve', scope: 'project' }],
      ['data.db', { owner: 'coodra', kind: 'sqlite-db', cleanup: 'preserve', scope: 'project' }],
      ['logs', { owner: 'coodra', kind: 'logs-dir', cleanup: 'preserve', scope: 'project' }],
      ['pids', { owner: 'coodra', kind: 'pids-dir', cleanup: 'preserve', scope: 'project' }],
      ['.cursor/mcp.json', { owner: 'agent:cursor', kind: 'mcp-config', cleanup: 'ask', scope: 'project' }],
      ['.cursorrules', { owner: 'agent:cursor', kind: 'instruction-file', cleanup: 'ask', scope: 'project' }],
      ['.codex/config.toml', { owner: 'agent:codex', kind: 'mcp-config', cleanup: 'ask', scope: 'project' }],
      ['AGENTS.md', { owner: 'agent:codex', kind: 'instruction-file', cleanup: 'ask', scope: 'project' }],
      ['CLAUDE.md', { owner: 'agent:claude', kind: 'instruction-file', cleanup: 'ask', scope: 'project' }],
      ['.windsurfrules', { owner: 'agent:windsurf', kind: 'instruction-file', cleanup: 'ask', scope: 'project' }],
      [
        'docs/feature-packs/x/spec.md',
        { owner: 'coodra', kind: 'feature-pack', cleanup: 'preserve', scope: 'project' },
      ],
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

    const windsurf = '/Users/someone/.codeium/windsurf/mcp_config.json';
    const w = classifyGeneratedPath(windsurf, root, 'coodra agent add devin');
    expect(w.scope).toBe('global');
    expect(w.owner).toBe('agent:windsurf');
    expect(w.cleanup).toBe('preserve');
  });
});
