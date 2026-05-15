import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/db';
import type { Logger } from '@coodra/shared';
import { eq } from 'drizzle-orm';

import type { GraphifyClient } from '../framework/tool-context.js';
import { createMcpLogger } from './logger.js';

/**
 * `apps/mcp-server/src/lib/graphify.ts` — filesystem-backed Graphify
 * index reader, wired into `ToolContext.graphify`.
 *
 * The Graphify tool produces a `graph.json` with tree-sitter AST
 * nodes clustered by Leiden communities (ADR-010). This client
 * reads that file for a given project slug, caches the parsed
 * content in-memory, and exposes two domain methods — strictly no
 * raw filesystem or SQL surface.
 *
 * Two methods (user directive Q9):
 *
 *   - `expandContext({ runId, depth })` — resolves the run's
 *     project slug via the `runs` + `projects` tables, loads
 *     `<graphifyRoot>/<slug>/graph.json`, returns the community
 *     subgraph. Missing file → empty `{ nodes: [], edges: [] }`
 *     (callers that need to tell "missing" from "empty" use
 *     `getIndexStatus`). Missing run → empty.
 *
 *   - `getIndexStatus(slug)` — synchronous-ish file existence
 *     probe. Returns `{ present: true }` when `graph.json` is
 *     readable, or `{ present: false, howToFix }` with the
 *     documented §S15 remediation string.
 *
 * Cache is per-slug, cleared only at process restart. The on-disk
 * file is expected to change only when an operator runs `graphify
 * scan` — a manual action — so a TTL would add flakiness without
 * buying freshness.
 */

const graphifyLogger = createMcpLogger('lib-graphify');

const GRAPHIFY_MISSING_HOWTO = 'run `graphify scan` at repo root' as const;

function defaultGraphifyRoot(): string {
  return join(homedir(), '.coodra', 'graphify');
}

export interface CreateGraphifyClientDeps {
  /** Root directory for `<slug>/graph.json` lookups. Defaults to `~/.coodra/graphify`. */
  readonly graphifyRoot?: string;
  /** DbHandle used to resolve `runId` → project slug inside `expandContext`. */
  readonly db: DbHandle;
  readonly logger?: Logger;
}

/**
 * Minimal shape of the Graphify `graph.json` file. Intentionally
 * permissive — Module 05 owns the rich schema; Module 02 only needs
 * to forward the nodes/edges arrays to S15's handler.
 */
interface GraphJson {
  readonly nodes?: ReadonlyArray<unknown>;
  readonly edges?: ReadonlyArray<unknown>;
}

interface CacheEntry {
  readonly nodes: ReadonlyArray<unknown>;
  readonly edges: ReadonlyArray<unknown>;
}

function graphPathFor(graphifyRoot: string, slug: string): string {
  return resolve(graphifyRoot, slug, 'graph.json');
}

async function resolveRunSlug(db: DbHandle, runId: string): Promise<string | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ slug: sqliteSchema.projects.slug })
      .from(sqliteSchema.runs)
      .innerJoin(sqliteSchema.projects, eq(sqliteSchema.projects.id, sqliteSchema.runs.projectId))
      .where(eq(sqliteSchema.runs.id, runId))
      .limit(1);
    return rows[0]?.slug ?? null;
  }
  const rows = await db.db
    .select({ slug: postgresSchema.projects.slug })
    .from(postgresSchema.runs)
    .innerJoin(postgresSchema.projects, eq(postgresSchema.projects.id, postgresSchema.runs.projectId))
    .where(eq(postgresSchema.runs.id, runId))
    .limit(1);
  return rows[0]?.slug ?? null;
}

export function createGraphifyClient(deps: CreateGraphifyClientDeps): GraphifyClient {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createGraphifyClient requires an options object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createGraphifyClient: deps.db must be a DbHandle from @coodra/db');
  }

  const log = deps.logger ?? graphifyLogger;
  const graphifyRoot = deps.graphifyRoot ?? defaultGraphifyRoot();
  const cache = new Map<string, CacheEntry>();

  async function loadForSlug(slug: string): Promise<CacheEntry | null> {
    const cached = cache.get(slug);
    if (cached) return cached;
    const path = graphPathFor(graphifyRoot, slug);
    if (!existsSync(path)) {
      log.warn(
        { event: 'graphify_index_missing', slug, path },
        'graph.json not found for slug — returning empty subgraph',
      );
      return null;
    }
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      log.warn(
        { event: 'graphify_read_failed', slug, path, err: err instanceof Error ? err.message : String(err) },
        'graph.json read failed — returning empty subgraph',
      );
      return null;
    }
    let parsed: GraphJson;
    try {
      parsed = JSON.parse(raw) as GraphJson;
    } catch (err) {
      log.warn(
        { event: 'graphify_parse_failed', slug, path, err: err instanceof Error ? err.message : String(err) },
        'graph.json is not valid JSON — returning empty subgraph',
      );
      return null;
    }
    const entry: CacheEntry = {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    };
    cache.set(slug, entry);
    log.info(
      { event: 'graphify_index_loaded', slug, path, nodeCount: entry.nodes.length, edgeCount: entry.edges.length },
      'graph.json loaded and cached',
    );
    return entry;
  }

  log.info(
    { event: 'graphify_client_wired', graphifyRoot },
    'createGraphifyClient: graphify reader wired (missing-index returns empty + notice via getIndexStatus).',
  );

  return {
    async expandContext({ runId, depth: _depth }) {
      // `depth` is accepted for forward-compatibility with Module 05's
      // n-hop community expansion. Module 02 returns the full parsed
      // subgraph; depth filtering lands with the richer graph shape.
      const slug = await resolveRunSlug(deps.db, runId);
      if (slug === null) {
        log.warn({ event: 'graphify_run_not_found', runId }, 'expandContext: runId did not resolve to a project slug');
        return { nodes: [], edges: [] };
      }
      const entry = await loadForSlug(slug);
      if (!entry) return { nodes: [], edges: [] };
      return { nodes: entry.nodes, edges: entry.edges };
    },

    async expandContextBySlug(slug) {
      // Additive method landed in S15 (user Q2 sign-off 2026-04-24)
      // for callers with a projectSlug but no runId — the
      // `query_codebase_graph` tool is the first consumer. Shares
      // the per-slug cache with `expandContext`. Missing file → empty
      // arrays (callers distinguish via `getIndexStatus` first).
      if (typeof slug !== 'string' || slug.length === 0) {
        return { nodes: [], edges: [] };
      }
      const entry = await loadForSlug(slug);
      if (!entry) return { nodes: [], edges: [] };
      return { nodes: entry.nodes, edges: entry.edges };
    },

    async getIndexStatus(slug) {
      if (typeof slug !== 'string' || slug.length === 0) {
        return { present: false, howToFix: GRAPHIFY_MISSING_HOWTO };
      }
      const path = graphPathFor(graphifyRoot, slug);
      if (!existsSync(path)) {
        return { present: false, howToFix: GRAPHIFY_MISSING_HOWTO };
      }
      return { present: true };
    },
  };
}
