import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import { type DbHandle, lookupProjectBySlug, postgresSchema, sqliteSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { and, desc, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { ToolContext } from '../../framework/tool-context.js';
import { computeGraphFreshness, type GraphStaleness } from '../../lib/graph-freshness.js';
import type { QueryDecisionsByFileInput, QueryDecisionsByFileOutput } from './schema.js';

const handlerLogger = createLogger('mcp-server.tool.query_decisions_by_file');

export interface QueryDecisionsByFileHandlerDeps {
  readonly db: DbHandle;
}

interface Row {
  readonly id: string;
  readonly runId: string;
  readonly description: string;
  readonly rationale: string;
  readonly createdAt: Date;
}

interface GraphifyNode {
  readonly id?: unknown;
  readonly label?: unknown;
  readonly norm_label?: unknown;
  readonly source_file?: unknown;
  readonly file_path?: unknown;
  readonly path?: unknown;
  readonly name?: unknown;
  readonly metadata?: Record<string, unknown>;
}

interface GraphifyLink {
  readonly source?: unknown;
  readonly target?: unknown;
}

interface GraphifyGraph {
  readonly nodes?: unknown;
  readonly links?: unknown;
  readonly edges?: unknown;
  /** COOD-81: written by Graphify, previously parsed and discarded. */
  readonly built_at_commit?: unknown;
}

interface BlastRadiusLookup {
  /**
   * COOD-81: now means "present AND fresh enough to trust", not merely
   * "a file exists on disk". A graph past the drift budget reports
   * false and returns the exact-file fallback, because correct-but-
   * narrow beats confidently wrong.
   */
  readonly graphAvailable: boolean;
  readonly depth: number;
  readonly rootNodeIds: string[];
  readonly graphNodeTargets: string[];
  readonly fileTargets: string[];
  /** Provenance + drift, so a caller can weigh an ageing graph itself. */
  readonly builtAtCommit: string | null;
  readonly commitsBehind: number | null;
  readonly filesChanged: number | null;
  readonly staleness: GraphStaleness;
}

interface GraphifyIndex {
  readonly nodes: GraphifyNode[];
  readonly byId: Map<string, GraphifyNode>;
  readonly adjacency: Map<string, Set<string>>;
  readonly builtAtCommit: string | null;
}

interface GraphifyCacheEntry {
  readonly loadedAt: number;
  readonly mtimeMs: number;
  readonly size: number;
  readonly index: GraphifyIndex;
}

const GRAPHIFY_BLAST_RADIUS_DEPTH = 1 as const;
const MAX_BLAST_RADIUS_TARGETS = 500 as const;
const GRAPHIFY_CACHE_TTL_MS = 60_000 as const;
const graphifyIndexCache = new Map<string, GraphifyCacheEntry>();

function normalizePathLike(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function normalizeLookupPath(projectCwd: string | null, filePath: string): string {
  if (projectCwd !== null && isAbsolute(filePath)) return normalizePathLike(relative(projectCwd, filePath));
  return normalizePathLike(filePath);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nodePathFields(node: GraphifyNode): string[] {
  const values = [
    node.source_file,
    node.file_path,
    node.path,
    node.metadata?.source_file,
    node.metadata?.file,
    node.metadata?.file_path,
    node.metadata?.path,
  ];
  return values.flatMap((value) => {
    const stringified = stringValue(value);
    return stringified === null ? [] : [stringified];
  });
}

function nodeFileTargets(node: GraphifyNode): string[] {
  const values = [
    node.source_file,
    node.file_path,
    node.path,
    node.metadata?.source_file,
    node.metadata?.file,
    node.metadata?.file_path,
    node.metadata?.path,
  ];
  return values.flatMap((value) => {
    const stringified = stringValue(value);
    return stringified === null ? [] : [normalizePathLike(stringified)];
  });
}

function isFileMatch(node: GraphifyNode, lookupPath: string): boolean {
  const normalizedLookup = normalizePathLike(lookupPath);
  return nodePathFields(node).some((value) => {
    const normalized = normalizePathLike(value);
    return (
      normalized === normalizedLookup ||
      normalized.endsWith(`/${normalizedLookup}`) ||
      normalizedLookup.endsWith(`/${normalized}`)
    );
  });
}

function edgeEndpointId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && 'id' in value) return stringValue((value as { readonly id?: unknown }).id);
  return null;
}

function boundedValues(values: Iterable<string>): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    if (value.length === 0) continue;
    unique.add(value);
    if (unique.size >= MAX_BLAST_RADIUS_TARGETS) break;
  }
  return [...unique];
}

function buildGraphifyIndex(graph: GraphifyGraph): GraphifyIndex {
  const nodes = Array.isArray(graph.nodes) ? (graph.nodes as GraphifyNode[]) : [];
  const links = Array.isArray(graph.links)
    ? (graph.links as GraphifyLink[])
    : Array.isArray(graph.edges)
      ? (graph.edges as GraphifyLink[])
      : [];
  const byId = new Map<string, GraphifyNode>();
  for (const node of nodes) {
    const id = stringValue(node.id);
    if (id !== null) byId.set(id, node);
  }

  const adjacency = new Map<string, Set<string>>();
  for (const link of links) {
    const source = edgeEndpointId(link.source);
    const target = edgeEndpointId(link.target);
    if (source === null || target === null) continue;
    if (!adjacency.has(source)) adjacency.set(source, new Set());
    if (!adjacency.has(target)) adjacency.set(target, new Set());
    adjacency.get(source)?.add(target);
    adjacency.get(target)?.add(source);
  }
  const builtAtCommit =
    typeof graph.built_at_commit === 'string' && graph.built_at_commit.length > 0 ? graph.built_at_commit : null;
  return { nodes, byId, adjacency, builtAtCommit };
}

async function loadGraphifyIndex(graphPath: string, nowMs: number): Promise<GraphifyIndex> {
  const stats = await stat(graphPath);
  const cached = graphifyIndexCache.get(graphPath);
  if (
    cached !== undefined &&
    nowMs - cached.loadedAt < GRAPHIFY_CACHE_TTL_MS &&
    cached.mtimeMs === stats.mtimeMs &&
    cached.size === stats.size
  ) {
    return cached.index;
  }

  const graph = JSON.parse(await readFile(graphPath, 'utf8')) as GraphifyGraph;
  const index = buildGraphifyIndex(graph);
  graphifyIndexCache.set(graphPath, {
    loadedAt: nowMs,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    index,
  });
  return index;
}

/** Topology only; provenance/drift are layered on by the caller. */
type BlastRadiusTopology = Pick<BlastRadiusLookup, 'rootNodeIds' | 'graphNodeTargets' | 'fileTargets'>;

function buildBlastRadius(index: GraphifyIndex, lookupPath: string): BlastRadiusTopology {
  const { adjacency, byId, nodes } = index;
  const rootNodeIds = nodes.flatMap((node) => {
    const id = stringValue(node.id);
    return id !== null && isFileMatch(node, lookupPath) ? [id] : [];
  });

  const graphNodeTargets = new Set(rootNodeIds);
  for (const rootId of rootNodeIds) {
    for (const neighborId of adjacency.get(rootId) ?? []) graphNodeTargets.add(neighborId);
  }

  const fileTargets = new Set<string>([normalizePathLike(lookupPath)]);
  for (const nodeId of graphNodeTargets) {
    const node = byId.get(nodeId);
    if (!node) continue;
    for (const fileTarget of nodeFileTargets(node)) fileTargets.add(fileTarget);
  }

  return {
    rootNodeIds: boundedValues(rootNodeIds),
    graphNodeTargets: boundedValues(graphNodeTargets),
    fileTargets: boundedValues(fileTargets),
  };
}

async function loadGraphifyBlastRadius(
  projectCwd: string | null,
  filePath: string,
  now: Date,
): Promise<BlastRadiusLookup> {
  const lookupPath = normalizeLookupPath(projectCwd, filePath);
  if (projectCwd === null) {
    return {
      graphAvailable: false,
      depth: GRAPHIFY_BLAST_RADIUS_DEPTH,
      rootNodeIds: [],
      graphNodeTargets: [],
      fileTargets: [lookupPath],
      builtAtCommit: null,
      commitsBehind: null,
      filesChanged: null,
      staleness: 'unknown' as const,
    };
  }

  try {
    const graphPath = join(projectCwd, '.coodra', 'graphify', 'out', 'graph.json');
    const index = await loadGraphifyIndex(graphPath, now.getTime());
    const freshness = await computeGraphFreshness(projectCwd, index.builtAtCommit);
    if (freshness.staleness === 'stale') {
      // Present but past the drift budget. Withholding the topology and
      // falling back to the exact-file lookup is the honest answer:
      // node ids are path-derived, so a heavily-drifted graph returns
      // neighbours for files that may no longer exist.
      handlerLogger.debug(
        {
          event: 'query_decisions_by_file_graph_stale',
          projectCwd,
          builtAtCommit: freshness.builtAtCommit,
          commitsBehind: freshness.commitsBehind,
          filesChanged: freshness.filesChanged,
        },
        'graph drift exceeds budget; withholding blast radius rather than serving stale topology',
      );
      return {
        graphAvailable: false,
        depth: GRAPHIFY_BLAST_RADIUS_DEPTH,
        rootNodeIds: [],
        graphNodeTargets: [],
        fileTargets: [lookupPath],
        ...freshness,
      };
    }
    return {
      graphAvailable: true,
      depth: GRAPHIFY_BLAST_RADIUS_DEPTH,
      ...buildBlastRadius(index, lookupPath),
      ...freshness,
    };
  } catch (error) {
    handlerLogger.debug(
      { event: 'query_decisions_by_file_graphify_unavailable', projectCwd, error },
      'query_decisions_by_file: Graphify artifact unavailable; falling back to exact file target lookup',
    );
    return {
      graphAvailable: false,
      depth: GRAPHIFY_BLAST_RADIUS_DEPTH,
      rootNodeIds: [],
      graphNodeTargets: [],
      fileTargets: [lookupPath],
      builtAtCommit: null,
      commitsBehind: null,
      filesChanged: null,
      staleness: 'unknown' as const,
    };
  }
}

async function selectSupersededBy(db: DbHandle, decisionIds: ReadonlyArray<string>): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(decisionIds)];
  const byTarget = new Map<string, string>();
  if (uniqueIds.length === 0) return byTarget;
  if (db.kind === 'sqlite') {
    const edges = sqliteSchema.decisionEdges;
    const rows = await db.db
      .select({ targetId: edges.targetId, fromDecisionId: edges.fromDecisionId })
      .from(edges)
      .where(
        and(eq(edges.edgeType, 'supersedes'), eq(edges.targetType, 'decision'), inArray(edges.targetId, uniqueIds)),
      );
    for (const row of rows) if (!byTarget.has(row.targetId)) byTarget.set(row.targetId, row.fromDecisionId);
    return byTarget;
  }
  const edges = postgresSchema.decisionEdges;
  const rows = await db.db
    .select({ targetId: edges.targetId, fromDecisionId: edges.fromDecisionId })
    .from(edges)
    .where(and(eq(edges.edgeType, 'supersedes'), eq(edges.targetType, 'decision'), inArray(edges.targetId, uniqueIds)));
  for (const row of rows) if (!byTarget.has(row.targetId)) byTarget.set(row.targetId, row.fromDecisionId);
  return byTarget;
}

function targetConditions(
  edges: typeof sqliteSchema.decisionEdges | typeof postgresSchema.decisionEdges,
  blastRadius: BlastRadiusLookup,
): SQL {
  const fileTargets = [...new Set(blastRadius.fileTargets)];
  const graphNodeTargets = [...new Set(blastRadius.graphNodeTargets)];
  const conditions: SQL[] = [];
  if (fileTargets.length > 0) conditions.push(and(eq(edges.targetType, 'file'), inArray(edges.targetId, fileTargets))!);
  if (graphNodeTargets.length > 0) {
    conditions.push(and(eq(edges.targetType, 'graph_node'), inArray(edges.targetId, graphNodeTargets))!);
  }
  return conditions.length === 1 ? conditions[0]! : (or(...conditions) ?? sql`1 = 0`);
}

async function selectRows(
  db: DbHandle,
  args: QueryDecisionsByFileInput & { projectId: string; blastRadius: BlastRadiusLookup },
): Promise<Row[]> {
  if (db.kind === 'sqlite') {
    const edges = sqliteSchema.decisionEdges;
    const decisions = sqliteSchema.decisions;
    const runs = sqliteSchema.runs;
    const conditions: SQL[] = [
      eq(edges.projectId, args.projectId),
      eq(runs.projectId, args.projectId),
      eq(edges.edgeType, 'affects'),
      targetConditions(edges, args.blastRadius),
    ];
    if (args.activeOnly) {
      conditions.push(sql`
        NOT EXISTS (
          SELECT 1 FROM decision_edges supersede
          WHERE supersede.edge_type = 'supersedes'
            AND supersede.target_type = 'decision'
            AND supersede.target_id = ${decisions.id}
        )
      `);
    }
    return (await db.db
      .selectDistinct({
        id: decisions.id,
        runId: decisions.runId,
        description: decisions.description,
        rationale: decisions.rationale,
        createdAt: decisions.createdAt,
      })
      .from(edges)
      .innerJoin(decisions, eq(edges.fromDecisionId, decisions.id))
      .innerJoin(runs, eq(decisions.runId, runs.id))
      .where(and(...conditions))
      .orderBy(desc(decisions.createdAt))
      .limit(args.limit)) as Row[];
  }
  const edges = postgresSchema.decisionEdges;
  const decisions = postgresSchema.decisions;
  const runs = postgresSchema.runs;
  const conditions: SQL[] = [
    eq(edges.projectId, args.projectId),
    eq(runs.projectId, args.projectId),
    eq(edges.edgeType, 'affects'),
    targetConditions(edges, args.blastRadius),
  ];
  if (args.activeOnly) {
    conditions.push(sql`
      NOT EXISTS (
        SELECT 1 FROM decision_edges supersede
        WHERE supersede.edge_type = 'supersedes'
          AND supersede.target_type = 'decision'
          AND supersede.target_id = ${decisions.id}
      )
    `);
  }
  return (await db.db
    .selectDistinct({
      id: decisions.id,
      runId: decisions.runId,
      description: decisions.description,
      rationale: decisions.rationale,
      createdAt: decisions.createdAt,
    })
    .from(edges)
    .innerJoin(decisions, eq(edges.fromDecisionId, decisions.id))
    .innerJoin(runs, eq(decisions.runId, runs.id))
    .where(and(...conditions))
    .orderBy(desc(decisions.createdAt))
    .limit(args.limit)) as Row[];
}

export function createQueryDecisionsByFileHandler(deps: QueryDecisionsByFileHandlerDeps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('createQueryDecisionsByFileHandler requires deps');
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createQueryDecisionsByFileHandler: deps.db must be a DbHandle');
  }

  return async function queryDecisionsByFileHandler(
    input: QueryDecisionsByFileInput,
    ctx: ToolContext,
  ): Promise<QueryDecisionsByFileOutput> {
    const project = await lookupProjectBySlug(deps.db, input.projectSlug);
    if (project === null) {
      handlerLogger.info(
        {
          event: 'query_decisions_by_file_project_not_found',
          projectSlug: input.projectSlug,
          sessionId: ctx.sessionId,
        },
        'query_decisions_by_file: projectSlug does not match a projects row',
      );
      return {
        ok: false,
        error: 'project_not_found',
        howToFix:
          'Register the project via the CLI (`coodra init`) or verify the slug matches an existing entry in the projects table.',
      };
    }

    const blastRadius = await loadGraphifyBlastRadius(project.cwd, input.filePath, ctx.now());
    const rows = await selectRows(deps.db, { ...input, projectId: project.id, blastRadius });
    const supersededBy = await selectSupersededBy(
      deps.db,
      rows.map((row) => row.id),
    );
    return {
      ok: true,
      filePath: input.filePath,
      blastRadius,
      decisions: rows.map((row) => ({
        id: row.id,
        runId: row.runId,
        description: row.description,
        rationale: row.rationale,
        createdAt: row.createdAt.toISOString(),
        supersededBy: supersededBy.get(row.id) ?? null,
      })),
    };
  };
}
