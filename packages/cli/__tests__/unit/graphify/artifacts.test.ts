import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countGraph,
  detectGraphifyLayout,
  LEGACY_PATHS,
  MANAGED_PATHS,
  readGraphifyRecord,
  resolveGraphifyPaths,
  scanGraphifyArtifacts,
  writeGraphifyRecord,
} from '../../../src/lib/graphify/artifacts.js';

/**
 * Locks the Graphify artifact contract: the managed vs legacy layout choice,
 * the `.coodra/graphify.json` record, and NetworkX node-link counting (edge key
 * is `links`, not `edges` — see the reference doc gotcha).
 */

let root: string;
const CLOCK = () => '2026-07-19T00:00:00.000Z';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coodra-gfx-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeGraph(relDir: string, graph: unknown): void {
  mkdirSync(join(root, relDir), { recursive: true });
  writeFileSync(join(root, relDir, 'graph.json'), JSON.stringify(graph));
}

describe('graphify artifacts — countGraph (NetworkX node-link)', () => {
  it('counts nodes, `links`, and distinct Leiden communities', () => {
    const counts = countGraph({
      nodes: [
        { id: 'a', community: 0 },
        { id: 'b', community: 1 },
        { id: 'c', community: 1 },
      ],
      links: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
    });
    expect(counts).toEqual({ nodes: 3, links: 2, communities: 2 });
  });

  it('falls back to an `edges` key when present (Graphify loader bridges it)', () => {
    expect(countGraph({ nodes: [{ id: 'a' }], edges: [{ source: 'a', target: 'a' }] })).toEqual({
      nodes: 1,
      links: 1,
      communities: 0,
    });
  });

  it('returns null for non-node-link shapes rather than throwing', () => {
    expect(countGraph({ notAGraph: true })).toBeNull();
    expect(countGraph(null)).toBeNull();
    expect(countGraph('nope')).toBeNull();
  });
});

describe('graphify artifacts — record + path resolution', () => {
  it('greenfield (no record, no legacy on disk) → the Coodra-managed layout', async () => {
    const paths = await resolveGraphifyPaths(root);
    expect(paths.outputDir).toBe(MANAGED_PATHS.outputDir);
    expect(paths.managedByCoodra).toBe(true);
  });

  it('an existing graphify-out/ with no record → KEEPS legacy (never relocates silently)', async () => {
    // This precedence must match `coodra graphify enable`, or build/open/clean
    // would disagree with the wired MCP entry about where the graph lives.
    writeGraph('graphify-out', { nodes: [], links: [] });
    const paths = await resolveGraphifyPaths(root);
    expect(paths.outputDir).toBe(LEGACY_PATHS.outputDir);
    expect(paths.managedByCoodra).toBe(false);
  });

  it('round-trips a managed record and resolves to it', async () => {
    await writeGraphifyRecord(root, MANAGED_PATHS, { dryRun: false, now: CLOCK });
    const record = await readGraphifyRecord(root);
    expect(record).toMatchObject({
      version: 1,
      outputDir: '.coodra/graphify/out',
      graphJson: '.coodra/graphify/out/graph.json',
      managedByCoodra: true,
      updatedAt: CLOCK(),
    });
    const paths = await resolveGraphifyPaths(root);
    expect(paths.managedByCoodra).toBe(true);
    expect(paths.graphHtml).toBe('.coodra/graphify/out/graph.html');
  });

  it('--dry-run writes no record', async () => {
    await writeGraphifyRecord(root, MANAGED_PATHS, { dryRun: true, now: CLOCK });
    expect(await readGraphifyRecord(root)).toBeNull();
  });
});

describe('graphify artifacts — layout detection', () => {
  it('reports which layouts exist on disk', async () => {
    expect(await detectGraphifyLayout(root)).toMatchObject({
      recorded: null,
      managedPresent: false,
      legacyPresent: false,
    });

    writeGraph('graphify-out', { nodes: [], links: [] });
    expect(await detectGraphifyLayout(root)).toMatchObject({ legacyPresent: true, managedPresent: false });

    writeGraph('.coodra/graphify/out', { nodes: [], links: [] });
    expect(await detectGraphifyLayout(root)).toMatchObject({ legacyPresent: true, managedPresent: true });
  });
});

describe('graphify artifacts — scan', () => {
  it('reports absent artifacts without counts', async () => {
    const scan = await scanGraphifyArtifacts(root, MANAGED_PATHS);
    expect(scan.graphJson.exists).toBe(false);
    expect(scan.counts).toBeNull();
  });

  it('reports size/mtime + counts for a real graph.json, and html/report presence', async () => {
    writeGraph('.coodra/graphify/out', {
      nodes: [
        { id: 'a', community: 3 },
        { id: 'b', community: 3 },
      ],
      links: [{ source: 'a', target: 'b' }],
    });
    writeFileSync(join(root, '.coodra/graphify/out/graph.html'), '<html>');

    const scan = await scanGraphifyArtifacts(root, MANAGED_PATHS);
    expect(scan.graphJson.exists).toBe(true);
    expect(scan.graphJson.sizeBytes).toBeGreaterThan(0);
    expect(scan.graphJson.modifiedAt).toBeTypeOf('string');
    expect(scan.counts).toEqual({ nodes: 2, links: 1, communities: 1 });
    expect(scan.graphHtml.exists).toBe(true);
    expect(scan.report.exists).toBe(false);
  });

  it('degrades gracefully on an unparseable graph.json', async () => {
    mkdirSync(join(root, '.coodra/graphify/out'), { recursive: true });
    writeFileSync(join(root, '.coodra/graphify/out/graph.json'), '{ not json');
    const scan = await scanGraphifyArtifacts(root, MANAGED_PATHS);
    expect(scan.graphJson.exists).toBe(true);
    expect(scan.counts).toBeNull();
    expect(scan.countsSkippedReason).toContain('unreadable');
  });
});
