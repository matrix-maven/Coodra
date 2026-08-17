/**
 * Cross-package constants that must be locked to a single source of truth.
 *
 * Every consumer of embedding storage (SQLite vec0 virtual table, Postgres
 * `vector(...)` column, `packages/db` schema, `services/nl-assembly`
 * encoder, Module 05 batch jobs) reads `EMBEDDING_DIM` from here. Changing
 * the dimension requires:
 *   1. Update this constant.
 *   2. Regenerate migrations (SQLite vec0 DDL in the hand-written block,
 *      Postgres `vector(N)` column).
 *   3. Re-hash `migrations.lock.json`.
 *   4. Rebuild or re-embed every row in `context_packs.summary_embedding`.
 *   5. Update `system-architecture.md §5` if the model family changes.
 *
 * 384 matches `sentence-transformers/all-MiniLM-L6-v2` (the default
 * encoder per `system-architecture.md §5`). `nomic-embed-text-v1.5` (768)
 * would require migration; see point 4 above.
 */
export const EMBEDDING_DIM = 384 as const;
export type EmbeddingDim = typeof EMBEDDING_DIM;

/**
 * Coodra's own `coodra` MCP server's tool names — mirrors the registrations
 * registrations in `apps/mcp-server/src/tools/index.ts` 1:1. Update this
 * list whenever a tool is added/removed there.
 *
 * On Claude Code and Codex, self-exclusion from third-party MCP policy
 * coverage is a structural PREFIX match (`mcp__coodra__*`) — immune to
 * this list ever drifting. Cursor has no such boundary: its hook matcher
 * only ever sees the bare tool name (`MCP:<tool_name>`, confirmed via
 * Cursor's own hooks docs, no server qualifier at all), so excluding
 * Coodra's own calls there requires a maintained name list instead of a
 * prefix match — this constant, and `GRAPHIFY_MCP_TOOL_NAMES` below,
 * are that list. Consumed by `packages/cli/src/lib/agents/cursor-plugin.ts`
 * (builds the `preToolUse`/`postToolUse` matcher regex) and
 * `apps/mcp-server/src/tools/lifecycle-event/handler.ts`'s
 * `isCoodraOwnMcpTool` (server-side backstop for the same bare-name shape).
 */
export const COODRA_MCP_TOOL_NAMES = [
  'ping',
  'get_run_id',
  'lifecycle_event',
  'check_policy',
  'save_context_pack',
  'list_context_packs',
  'read_context_pack',
  'search_packs_nl',
  'record_decision',
  'query_decisions',
  'query_decisions_by_file',
  'query_run_history',
  'query_run_diff',
  'list_recipes',
  'get_recipe',
  'get_recipe_file',
  'work_pack_upsert',
  'work_pack_update',
  'work_pack_status',
  'link_run_to_issue',
  'link_run_to_pr',
  'prepare_jira_comment',
  'wiki_save_structure',
  'wiki_save_page',
  'wiki_status',
  // COOD-30 shipped `wiki_ask` without adding it here, and the omission
  // survived because the tests that would have caught it exercise the
  // BUILT binary — so they only fail once `dist/` is rebuilt.
  //
  // Not merely a test lock. This list is the Cursor arm of
  // `isCoodraOwnMcpTool` (lifecycle-event/handler.ts): Cursor reports
  // `MCP:<tool_name>` with no server prefix, so a missing name means
  // Coodra runs its own policy engine against its own tool call — the
  // exact failure that function's docblock warns about.
  'wiki_ask',
] as const;

/**
 * Graphify's own tool surface — unlike `COODRA_MCP_TOOL_NAMES` above,
 * this is an EXTERNALLY-VERSIONED Python package Coodra bundles but does
 * not own the tool list of (see `packages/cli/src/lib/graphify/`). This
 * list is best-effort (sourced from the tools actually observed
 * connected in a live Graphify session) and may drift if a future
 * Graphify release adds tools — a missed name here only costs one wasted
 * hook round-trip for that tool on Cursor (still correctly allowed, just
 * not short-circuited client-side), not a policy-correctness bug.
 */
export const GRAPHIFY_MCP_TOOL_NAMES = [
  'query_graph',
  'get_node',
  'get_neighbors',
  'shortest_path',
  'get_community',
  'get_pr_impact',
  'god_nodes',
  'graph_stats',
  'list_prs',
  'triage_prs',
] as const;
