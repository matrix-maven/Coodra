import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MANAGED_PATHS, readGraphSummary, summarizeGraph } from '../../../src/lib/graphify/artifacts.js';

/**
 * Locks `summarizeGraph` — the one level above `countGraph` that both the web
 * `/graphify` page and the wiki grounding path consume.
 *
 * The fixture is a REAL graphify 0.8.27 `graph.json` (captured from a two-file
 * probe repo), not a hand-invented shape: `links` as the edge key, `community`
 * as a number, `source_file` / `label` / `norm_label` on nodes. If Graphify
 * changes its node-link shape, this fixture is what should fail first.
 */

const REAL_GRAPH = {
  directed: false,
  multigraph: false,
  graph: {},
  nodes: [
    { label: 'a.py', file_type: 'code', source_file: 'src/a.py', source_location: 'L1', id: 'src_a', community: 0 },
    {
      label: 'main()',
      file_type: 'code',
      source_file: 'src/a.py',
      source_location: 'L2',
      id: 'src_a_main',
      community: 0,
    },
    { label: 'b.py', file_type: 'code', source_file: 'src/b.py', source_location: 'L1', id: 'src_b', community: 1 },
    {
      label: 'helper()',
      file_type: 'code',
      source_file: 'src/b.py',
      source_location: 'L1',
      id: 'src_b_helper',
      community: 1,
    },
  ],
  links: [
    { relation: 'contains', confidence: 'EXTRACTED', source: 'src_a', target: 'src_a_main', weight: 1.0 },
    { relation: 'calls', confidence: 'INFERRED', source: 'src_a_main', target: 'src_b_helper', weight: 1.0 },
    { relation: 'contains', confidence: 'EXTRACTED', source: 'src_b', target: 'src_b_helper', weight: 1.0 },
  ],
  hyperedges: [],
};

describe('summarizeGraph', () => {
  it('derives counts, community buckets and degree-ranked hubs from a real graph.json', () => {
    const summary = summarizeGraph(REAL_GRAPH);
    expect(summary).not.toBeNull();
    if (summary === null) return;

    expect(summary.counts).toEqual({ nodes: 4, links: 3, communities: 2 });

    // Both communities hold 2 nodes; the tie breaks on id so the order is
    // deterministic run-to-run (the page renders it as a list).
    expect(summary.communities.map((c) => c.id)).toEqual(['0', '1']);
    expect(summary.communities[0]?.size).toBe(2);
    expect(summary.communities[0]?.sampleLabels).toEqual(['a.py', 'main()']);
    expect(summary.communities[0]?.files).toEqual(['src/a.py']);

    // main() and helper() each have degree 2; a.py and b.py have degree 1.
    expect(summary.hubs.map((h) => `${h.label}:${h.degree}`)).toEqual(['main():2', 'helper():2', 'a.py:1', 'b.py:1']);
    expect(summary.hubs[0]?.community).toBe('0');
    expect(summary.hubs[0]?.sourceFile).toBe('src/a.py');
  });

  it('accepts `edges` as the edge key (Graphify loader bridges it)', () => {
    const summary = summarizeGraph({
      nodes: [
        { id: 'x', label: 'X', community: 3 },
        { id: 'y', label: 'Y', community: 3 },
      ],
      edges: [{ source: 'x', target: 'y' }],
    });
    expect(summary?.counts).toEqual({ nodes: 2, links: 1, communities: 1 });
    expect(summary?.hubs).toHaveLength(2);
  });

  it('respects the maxCommunities / maxHubs caps so a 10k-node graph stays bounded', () => {
    const nodes = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, label: `N${i}`, community: i % 40 }));
    const links = Array.from({ length: 199 }, (_, i) => ({ source: `n${i}`, target: `n${i + 1}` }));
    const summary = summarizeGraph({ nodes, links }, { maxCommunities: 5, maxHubs: 3 });
    expect(summary?.counts.communities).toBe(40);
    expect(summary?.communities).toHaveLength(5);
    expect(summary?.hubs).toHaveLength(3);
  });

  it('omits zero-degree nodes from hubs — an isolated node is not a hub', () => {
    const summary = summarizeGraph({
      nodes: [
        { id: 'connected', label: 'C', community: 0 },
        { id: 'other', label: 'O', community: 0 },
        { id: 'island', label: 'I', community: 1 },
      ],
      links: [{ source: 'connected', target: 'other' }],
    });
    expect(summary?.hubs.map((h) => h.id)).toEqual(['connected', 'other']);
  });

  it('tolerates nodes with no community and no label without dropping the graph', () => {
    const summary = summarizeGraph({
      nodes: [{ id: 'bare' }, { id: 'labelled', label: 'L', community: 'alpha' }],
      links: [{ source: 'bare', target: 'labelled' }],
    });
    expect(summary?.counts.nodes).toBe(2);
    expect(summary?.communities.map((c) => c.id)).toEqual(['alpha']);
    // A node with no `label` falls back to its id rather than rendering blank.
    expect(summary?.hubs.find((h) => h.id === 'bare')?.label).toBe('bare');
  });

  it('returns null on a non-node-link payload rather than throwing', () => {
    expect(summarizeGraph(null)).toBeNull();
    expect(summarizeGraph('not a graph')).toBeNull();
    expect(summarizeGraph({ nodes: 'nope' })).toBeNull();
  });
});

describe('readGraphSummary', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'coodra-gfx-sum-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads and summarizes the managed graph.json', async () => {
    mkdirSync(join(root, '.coodra/graphify/out'), { recursive: true });
    writeFileSync(join(root, '.coodra/graphify/out/graph.json'), JSON.stringify(REAL_GRAPH));
    const summary = await readGraphSummary(root, MANAGED_PATHS);
    expect(summary?.counts).toEqual({ nodes: 4, links: 3, communities: 2 });
  });

  it('returns null when graph.json is absent', async () => {
    expect(await readGraphSummary(root, MANAGED_PATHS)).toBeNull();
  });

  it('returns null on an unparseable graph.json instead of throwing', async () => {
    mkdirSync(join(root, '.coodra/graphify/out'), { recursive: true });
    writeFileSync(join(root, '.coodra/graphify/out/graph.json'), '{ truncated');
    expect(await readGraphSummary(root, MANAGED_PATHS)).toBeNull();
  });
});
