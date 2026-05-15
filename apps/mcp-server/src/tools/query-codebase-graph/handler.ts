import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { eq } from 'drizzle-orm';
import type { ToolContext } from '../../framework/tool-context.js';
import {
  QUERY_CODEBASE_GRAPH_DEFAULT_MAX_NODES,
  type QueryCodebaseGraphInput,
  type QueryCodebaseGraphOutput,
} from './schema.js';

/**
 * Handler factory for `coodra__query_codebase_graph` (§24.4, S15).
 *
 * S15 is the first caller of `GraphifyClient.getIndexStatus` (S7c
 * additive-method landed for exactly this slice — user directive Q9
 * 2026-04-24) AND the first caller of `expandContextBySlug` (S15
 * additive-method landed this commit — user directive Q2 2026-04-24).
 *
 * Factory shape (not static-const — user Q1 sign-off 2026-04-24)
 * closes over `DbHandle` for the projects-slug resolution. The
 * factory discipline matches every other project-resolving tool
 * (search_packs_nl, query_run_history, check_policy). A static-const
 * handler could not distinguish `project_not_found` from
 * `codebase_graph_not_indexed` because `ctx.db.db` is typed `unknown`
 * at the ToolContext boundary by deliberate design.
 *
 * Flow (order-critical — the spy-based integration test locks this):
 *   1. Resolve `projectSlug → projects.id`. Missing → structured
 *      `{ ok: false, error: 'project_not_found', howToFix }` per
 *      §9.1.2. No graphify call — projects-table miss is caller-
 *      addressable via `coodra init`, distinct from a missing
 *      graph.json (different remediation string, different error
 *      code).
 *   2. Call `ctx.graphify.getIndexStatus(projectSlug)` BEFORE
 *      `expandContextBySlug`. If `{ present: false, howToFix }`,
 *      return `{ ok: false, error: 'codebase_graph_not_indexed',
 *      howToFix }` soft-failure. The `howToFix` string is the
 *      lib-authored `'run `graphify scan` at repo root'` — surfaced
 *      verbatim without rederivation (per S7c sign-off).
 *   3. Call `ctx.graphify.expandContextBySlug(projectSlug)` — returns
 *      `{ nodes, edges }` (empty arrays if mid-read parse / read
 *      failed; those are lib-internal fail-open paths distinct from
 *      missing-file, so `indexed` stays `true`).
 *   4. Return `{ ok: true, nodes, edges, indexed: true, notice:
 *      'query_filtering_deferred_to_m05' }` — the `notice` marker
 *      signals agents that `query` was NOT applied at M02 and the
 *      full subgraph was returned instead.
 *
 * `query` is accepted on the input but NOT applied at M02. Nodes
 * are typed `unknown` at the lib layer (Module 05 owns the richer
 * schema), so any M02-level filter would either be imprecise
 * (stringify+substring) or structurally dishonest (duck-type cast
 * to `{ name, kind, file }`). The M02 shim returns the full
 * subgraph with the advisory notice; Module 05 replaces this
 * handler with typed filtering.
 *
 * Read-only tool: no RunRecorder emit, no policy_decisions write
 * from this handler (registry auto-wrap still writes audit rows
 * for pre/post evaluation).
 *
 * Fail-open (§7 canonical list) for this handler:
 *   - Lib's internal empty-return on FS/JSON errors → handler still
 *     responds `{ ok: true, nodes: [], edges: [], indexed: true }`.
 *     Does NOT collapse with `codebase_graph_not_indexed`, which is
 *     a genuine caller-addressable state (missing file, not a
 *     transient read failure).
 */

const handlerLogger = createLogger('mcp-server.tool.query_codebase_graph');

export interface QueryCodebaseGraphHandlerDeps {
  readonly db: DbHandle;
}

async function resolveProjectId(db: DbHandle, projectSlug: string): Promise<string | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ id: sqliteSchema.projects.id })
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, projectSlug))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  const rows = await db.db
    .select({ id: postgresSchema.projects.id })
    .from(postgresSchema.projects)
    .where(eq(postgresSchema.projects.slug, projectSlug))
    .limit(1);
  return rows[0]?.id ?? null;
}

export function createQueryCodebaseGraphHandler(deps: QueryCodebaseGraphHandlerDeps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createQueryCodebaseGraphHandler requires a deps object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createQueryCodebaseGraphHandler: deps.db must be a DbHandle');
  }

  return async function queryCodebaseGraphHandler(
    input: QueryCodebaseGraphInput,
    ctx: ToolContext,
  ): Promise<QueryCodebaseGraphOutput> {
    const projectId = await resolveProjectId(deps.db, input.projectSlug);
    if (projectId === null) {
      handlerLogger.info(
        {
          event: 'query_codebase_graph_project_not_found',
          projectSlug: input.projectSlug,
          sessionId: ctx.sessionId,
        },
        'query_codebase_graph: projectSlug does not match a projects row — returning project_not_found soft-failure',
      );
      return {
        ok: false,
        error: 'project_not_found',
        howToFix:
          'Register the project via the CLI (`coodra init`) or verify the slug matches an existing entry in the projects table.',
      };
    }

    // getIndexStatus BEFORE expandContextBySlug — the order is
    // load-bearing. Without this gate, a missing index would silently
    // fall through to `{ ok: true, nodes: [], edges: [], indexed: true }`
    // (expandContextBySlug's empty return) and the caller couldn't
    // tell "no results" from "no graphify scan ever ran".
    const status = await ctx.graphify.getIndexStatus(input.projectSlug);
    if (!status.present) {
      handlerLogger.info(
        {
          event: 'query_codebase_graph_not_indexed',
          projectSlug: input.projectSlug,
          sessionId: ctx.sessionId,
        },
        'query_codebase_graph: graph.json not found — returning codebase_graph_not_indexed soft-failure',
      );
      return {
        ok: false,
        error: 'codebase_graph_not_indexed',
        howToFix: status.howToFix ?? 'run `graphify scan` at repo root',
      };
    }

    const { nodes, edges } = await ctx.graphify.expandContextBySlug(input.projectSlug);

    // M05 — guard against giant graphs. The agent reasons over the
    // full subgraph; without a cap a 5000-node graph saturates the
    // agent's context budget. Surface graph_too_large with a
    // remediation hint instead of truncating silently.
    const maxNodes = input.maxNodes ?? QUERY_CODEBASE_GRAPH_DEFAULT_MAX_NODES;
    if (nodes.length > maxNodes) {
      handlerLogger.info(
        {
          event: 'query_codebase_graph_too_large',
          projectSlug: input.projectSlug,
          nodeCount: nodes.length,
          maxNodes,
          sessionId: ctx.sessionId,
        },
        'query_codebase_graph: subgraph exceeds maxNodes — returning graph_too_large soft-failure',
      );
      return {
        ok: false,
        error: 'graph_too_large',
        nodeCount: nodes.length,
        maxNodes,
        howToFix:
          'Narrow the query to a subdirectory or symbol prefix, or pass a higher `maxNodes` (max 10000). For exploration of large graphs, run `graphify scan --scope <subdir>` to produce a tighter index.',
      };
    }

    return {
      ok: true,
      nodes: [...nodes],
      edges: [...edges],
      indexed: true,
    };
  };
}
