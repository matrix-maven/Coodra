import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadGraph } from '@/lib/queries/graph';

/**
 * Unit tests for `apps/web/lib/queries/graph.ts` (M04 Phase 2 S10).
 *
 * Each test seeds a tmp graphify root, points
 * COODRA_GRAPHIFY_ROOT at it, and exercises one of the three
 * branches: missing / invalid / ok.
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cxos-s10-graph-'));
  process.env.COODRA_GRAPHIFY_ROOT = tmpRoot;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.COODRA_GRAPHIFY_ROOT;
});

describe('loadGraph', () => {
  it('returns missing when graph.json is absent', () => {
    const result = loadGraph('absent-project');
    expect(result.status).toBe('missing');
    if (result.status === 'missing') {
      expect(result.howToFix).toContain('graphify scan');
      expect(result.path).toContain('absent-project');
    }
  });

  it('returns invalid when graph.json is not JSON', () => {
    const dir = join(tmpRoot, 'broken-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'graph.json'), 'this is not json {');
    const result = loadGraph('broken-project');
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toContain('JSON parse failed');
    }
  });

  it('returns invalid when graph.json root is not an object', () => {
    const dir = join(tmpRoot, 'array-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'graph.json'), '[1,2,3]');
    const result = loadGraph('array-project');
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toContain('not an object');
    }
  });

  it('projects nodes via best-effort field probing', () => {
    const dir = join(tmpRoot, 'happy-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'graph.json'),
      JSON.stringify({
        nodes: [
          { id: 'sym-1', name: 'fooHandler', kind: 'function', path: 'src/handlers/foo.ts', community: 'A' },
          { id: 'sym-2', label: 'BarClass', type: 'class', file: 'src/lib/bar.ts', cluster: 'B' },
          { id: 42, name: 'numericId', kind: 'var', filePath: 'src/c.ts' },
          // shapeless node — fields fall through to defaults
          'string node ignored',
        ],
        edges: [
          { from: 'sym-1', to: 'sym-2' },
          { from: 'sym-2', to: 'sym-1' },
        ],
      }),
    );
    const result = loadGraph('happy-project');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.nodes).toHaveLength(4);
    expect(result.nodes[0]).toMatchObject({
      id: 'sym-1',
      name: 'fooHandler',
      kind: 'function',
      path: 'src/handlers/foo.ts',
      community: 'A',
    });
    expect(result.nodes[1]).toMatchObject({
      id: 'sym-2',
      name: 'BarClass',
      kind: 'class',
      path: 'src/lib/bar.ts',
      community: 'B',
    });
    expect(result.nodes[2]).toMatchObject({
      id: '42',
      name: 'numericId',
      kind: 'var',
      path: 'src/c.ts',
      community: null,
    });
    expect(result.nodes[3]).toMatchObject({ kind: '—', path: '—', community: null });
    expect(result.edgeCount).toBe(2);
  });

  it('treats missing nodes/edges arrays as empty', () => {
    const dir = join(tmpRoot, 'empty-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'graph.json'), JSON.stringify({ meta: 'no nodes here' }));
    const result = loadGraph('empty-project');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.nodes).toEqual([]);
    expect(result.edgeCount).toBe(0);
  });
});
