import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';

/**
 * `lib/graphify/artifacts.ts` — where Graphify's build output lives and what's
 * in it.
 *
 * Two supported layouts:
 *
 *   - **managed** — `<root>/.coodra/graphify/out/` (Coodra sets `GRAPHIFY_OUT`
 *     to this). Keeps the repo root clean and puts the artifacts under the
 *     project-local Coodra folder alongside the manifest.
 *   - **legacy / unmanaged** — `<root>/graphify-out/`, Graphify's own default.
 *
 * The choice is the USER's and is recorded in `<root>/.coodra/graphify.json`,
 * because it has a real consequence: Graphify intends `graphify-out/` to be
 * COMMITTED to git (it ships a merge driver so `graph.json` union-merges), while
 * `.coodra/` is typically gitignored. Moving the output under `.coodra/` trades
 * "shared with the team via git" for "clean repo root". We never relocate an
 * existing `graphify-out/` silently — see `resolveGraphifyPaths` below.
 *
 * `graph.json` is NetworkX **node-link** format: nodes carry `id`/`label`/
 * `community` (Leiden cluster) and the edge array is keyed **`links`**, NOT
 * `edges` (Graphify's own loader bridges an `edges` key when present, so we
 * accept either). See `External api and library reference.md → Graphify CLI`.
 */

export const MANAGED_OUT_REL = '.coodra/graphify/out' as const;
export const LEGACY_OUT_REL = 'graphify-out' as const;
export const GRAPHIFY_RECORD_REL = '.coodra/graphify.json' as const;

/** Skip counting for absurdly large graphs so `status` never hangs the CLI. */
const MAX_GRAPH_JSON_BYTES_FOR_COUNTS = 64 * 1024 * 1024;

export function graphifyRecordPath(root: string): string {
  return join(root, '.coodra', 'graphify.json');
}

const graphifyRecordSchema = z
  .object({
    version: z.literal(1),
    /** Output dir, project-relative (or absolute if the user pinned one). */
    outputDir: z.string().min(1),
    graphJson: z.string().min(1),
    graphHtml: z.string().min(1),
    report: z.string().min(1),
    /** True when the output lives under `.coodra/` and Coodra sets GRAPHIFY_OUT. */
    managedByCoodra: z.boolean(),
    updatedAt: z.string().optional(),
  })
  .loose();

export type GraphifyRecord = z.infer<typeof graphifyRecordSchema>;

export interface GraphifyPaths {
  /** Project-relative (or absolute) output directory. */
  readonly outputDir: string;
  readonly graphJson: string;
  readonly graphHtml: string;
  readonly report: string;
  readonly managedByCoodra: boolean;
}

/** Build the standard path set for an output directory. */
export function pathsForOutputDir(outputDir: string, managedByCoodra: boolean): GraphifyPaths {
  const j = (name: string) => (isAbsolute(outputDir) ? join(outputDir, name) : `${outputDir}/${name}`);
  return {
    outputDir,
    graphJson: j('graph.json'),
    graphHtml: j('graph.html'),
    report: j('GRAPH_REPORT.md'),
    managedByCoodra,
  };
}

export const MANAGED_PATHS: GraphifyPaths = pathsForOutputDir(MANAGED_OUT_REL, true);
export const LEGACY_PATHS: GraphifyPaths = pathsForOutputDir(LEGACY_OUT_REL, false);

export async function readGraphifyRecord(root: string): Promise<GraphifyRecord | null> {
  let raw: string;
  try {
    raw = await readFile(graphifyRecordPath(root), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = graphifyRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeGraphifyRecord(
  root: string,
  paths: GraphifyPaths,
  opts: { readonly dryRun: boolean; readonly now?: () => string },
): Promise<GraphifyRecord> {
  const now = opts.now ?? (() => new Date().toISOString());
  const record: GraphifyRecord = {
    version: 1,
    outputDir: paths.outputDir,
    graphJson: paths.graphJson,
    graphHtml: paths.graphHtml,
    report: paths.report,
    managedByCoodra: paths.managedByCoodra,
    updatedAt: now(),
  };
  if (!opts.dryRun) {
    const path = graphifyRecordPath(root);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.coodra.tmp`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
  }
  return record;
}

/**
 * The effective paths for this project. Precedence — shared by
 * `build`/`open`/`clean`/`status` so they never disagree about where the
 * graph lives:
 *
 *   1. a recorded choice in `.coodra/graphify.json` — honour it;
 *   2. an existing `graphify-out/graph.json` — keep it where it is (that
 *      directory is meant to be git-committed; never relocate silently);
 *   3. otherwise (greenfield) — the Coodra-managed layout.
 */
export async function resolveGraphifyPaths(root: string): Promise<GraphifyPaths> {
  const record = await readGraphifyRecord(root);
  if (record !== null) {
    return {
      outputDir: record.outputDir,
      graphJson: record.graphJson,
      graphHtml: record.graphHtml,
      report: record.report,
      managedByCoodra: record.managedByCoodra,
    };
  }
  const legacy = await statFile(absOf(root, LEGACY_PATHS.graphJson));
  return legacy.exists ? LEGACY_PATHS : MANAGED_PATHS;
}

export function absOf(root: string, relOrAbs: string): string {
  return isAbsolute(relOrAbs) ? relOrAbs : join(root, relOrAbs);
}

export interface FileStat {
  readonly exists: boolean;
  readonly sizeBytes?: number;
  readonly modifiedAt?: string;
}

async function statFile(path: string): Promise<FileStat> {
  try {
    const s = await stat(path);
    return { exists: true, sizeBytes: s.size, modifiedAt: s.mtime.toISOString() };
  } catch {
    return { exists: false };
  }
}

export interface GraphCounts {
  readonly nodes: number;
  readonly links: number;
  readonly communities: number;
}

export interface GraphifyArtifactScan {
  readonly paths: GraphifyPaths;
  readonly graphJson: FileStat;
  readonly graphHtml: FileStat;
  readonly report: FileStat;
  /** Null when graph.json is absent, too large to parse, or unparseable. */
  readonly counts: GraphCounts | null;
  /** Set when counts could not be computed despite graph.json existing. */
  readonly countsSkippedReason?: string;
}

/**
 * Count nodes / links / Leiden communities in a NetworkX node-link `graph.json`.
 * Accepts `links` (canonical) or `edges` (Graphify's loader bridges it).
 * Defensive: any shape surprise yields null rather than throwing, so `status`
 * degrades to "graph present, counts unavailable".
 */
export function countGraph(parsed: unknown): GraphCounts | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const nodes = Array.isArray(obj.nodes) ? obj.nodes : null;
  if (nodes === null) return null;
  const linkArr = Array.isArray(obj.links) ? obj.links : Array.isArray(obj.edges) ? obj.edges : [];
  const communities = new Set<unknown>();
  for (const n of nodes) {
    if (typeof n === 'object' && n !== null) {
      const c = (n as Record<string, unknown>).community;
      if (c !== undefined && c !== null) communities.add(c);
    }
  }
  return { nodes: nodes.length, links: linkArr.length, communities: communities.size };
}

/* ---------------------------------------------------------------------------
 * Graph summary — one level richer than `countGraph`.
 *
 * Two consumers, one implementation:
 *   - the web `/graphify` page (community breakdown + hub list);
 *   - Phase 4's wiki grounding (communities → candidate sections,
 *     high-degree nodes → high-importance pages, per ADR-017).
 *
 * Deliberately derived from `graph.json` rather than parsed out of
 * `GRAPH_REPORT.md`: the report is prose meant for humans and Graphify
 * reformats it freely between releases, while `graph.json` is the stable
 * NetworkX node-link contract. Parsing the report would be a shallow proxy for
 * reading the data.
 * ------------------------------------------------------------------------- */

export interface GraphCommunitySummary {
  /** Leiden community id as it appears on the nodes (number or string). */
  readonly id: string;
  readonly size: number;
  /** A few member labels, for a human-readable "what is this cluster?" hint. */
  readonly sampleLabels: ReadonlyArray<string>;
  /** Distinct `source_file` values in this community, capped. */
  readonly files: ReadonlyArray<string>;
}

export interface GraphHubNode {
  readonly id: string;
  readonly label: string;
  readonly degree: number;
  readonly community: string | null;
  readonly sourceFile: string | null;
}

export interface GraphSummary {
  readonly counts: GraphCounts;
  /** Communities, largest first. */
  readonly communities: ReadonlyArray<GraphCommunitySummary>;
  /** "God nodes" — highest-degree nodes, most connected first. */
  readonly hubs: ReadonlyArray<GraphHubNode>;
}

/** Caps so a 10k-node graph can't produce an unbounded summary. */
const MAX_SAMPLE_LABELS = 6;
const MAX_COMMUNITY_FILES = 12;

function stringField(node: Record<string, unknown>, key: string): string | null {
  const v = node[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Summarize a parsed NetworkX node-link `graph.json`. Returns null on any shape
 * surprise (same contract as `countGraph`) so callers degrade to "graph
 * present, summary unavailable" instead of throwing mid-render.
 */
export function summarizeGraph(
  parsed: unknown,
  opts: { readonly maxCommunities?: number; readonly maxHubs?: number } = {},
): GraphSummary | null {
  const counts = countGraph(parsed);
  if (counts === null) return null;
  const obj = parsed as Record<string, unknown>;
  const nodes = (obj.nodes as unknown[]).filter(
    (n): n is Record<string, unknown> => typeof n === 'object' && n !== null,
  );
  const links = (Array.isArray(obj.links) ? obj.links : Array.isArray(obj.edges) ? obj.edges : []).filter(
    (l): l is Record<string, unknown> => typeof l === 'object' && l !== null,
  );

  const degree = new Map<string, number>();
  for (const l of links) {
    for (const endpoint of [l.source, l.target]) {
      if (typeof endpoint === 'string') degree.set(endpoint, (degree.get(endpoint) ?? 0) + 1);
    }
  }

  interface Bucket {
    size: number;
    labels: string[];
    files: Set<string>;
  }
  const byCommunity = new Map<string, Bucket>();
  const hubs: GraphHubNode[] = [];

  for (const n of nodes) {
    const rawCommunity = n.community;
    const community =
      typeof rawCommunity === 'string' || typeof rawCommunity === 'number' ? String(rawCommunity) : null;
    const id = stringField(n, 'id');
    const label = stringField(n, 'label') ?? id ?? '(unlabelled)';
    const sourceFile = stringField(n, 'source_file');

    if (community !== null) {
      let bucket = byCommunity.get(community);
      if (bucket === undefined) {
        bucket = { size: 0, labels: [], files: new Set<string>() };
        byCommunity.set(community, bucket);
      }
      bucket.size += 1;
      if (bucket.labels.length < MAX_SAMPLE_LABELS) bucket.labels.push(label);
      if (sourceFile !== null && bucket.files.size < MAX_COMMUNITY_FILES) bucket.files.add(sourceFile);
    }

    if (id !== null) {
      hubs.push({ id, label, degree: degree.get(id) ?? 0, community, sourceFile });
    }
  }

  const communities = [...byCommunity.entries()]
    .map(([id, b]) => ({ id, size: b.size, sampleLabels: b.labels, files: [...b.files] }))
    // Largest first; ties broken by id so the order is deterministic across runs.
    .sort((a, b) => b.size - a.size || a.id.localeCompare(b.id))
    .slice(0, opts.maxCommunities ?? 20);

  const rankedHubs = hubs
    .filter((h) => h.degree > 0)
    .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
    .slice(0, opts.maxHubs ?? 12);

  return { counts, communities, hubs: rankedHubs };
}

/**
 * Read + summarize the project's `graph.json`. Null when the file is absent,
 * over the size cap, unparseable, or not node-link shaped.
 */
export async function readGraphSummary(
  root: string,
  paths: GraphifyPaths,
  opts: { readonly maxCommunities?: number; readonly maxHubs?: number } = {},
): Promise<GraphSummary | null> {
  const abs = absOf(root, paths.graphJson);
  try {
    const s = await stat(abs);
    if (s.size > MAX_GRAPH_JSON_BYTES_FOR_COUNTS) return null;
    return summarizeGraph(JSON.parse(await readFile(abs, 'utf8')), opts);
  } catch {
    return null;
  }
}

export async function scanGraphifyArtifacts(root: string, paths: GraphifyPaths): Promise<GraphifyArtifactScan> {
  const graphJsonAbs = absOf(root, paths.graphJson);
  const [graphJson, graphHtml, report] = await Promise.all([
    statFile(graphJsonAbs),
    statFile(absOf(root, paths.graphHtml)),
    statFile(absOf(root, paths.report)),
  ]);

  let counts: GraphCounts | null = null;
  let countsSkippedReason: string | undefined;
  if (graphJson.exists) {
    if ((graphJson.sizeBytes ?? 0) > MAX_GRAPH_JSON_BYTES_FOR_COUNTS) {
      countsSkippedReason = `graph.json is ${Math.round((graphJson.sizeBytes ?? 0) / 1024 / 1024)}MB — skipping counts`;
    } else {
      try {
        counts = countGraph(JSON.parse(await readFile(graphJsonAbs, 'utf8')));
        if (counts === null) countsSkippedReason = 'graph.json is not NetworkX node-link shape';
      } catch (err) {
        countsSkippedReason = `graph.json unreadable: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  return {
    paths,
    graphJson,
    graphHtml,
    report,
    counts,
    ...(countsSkippedReason !== undefined ? { countsSkippedReason } : {}),
  };
}
