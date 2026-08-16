import type { DbHandle } from '@coodra/db';

import type { GraphRefreshWorkerHandle } from '@coodra/lifecycle';

import type { ToolRegistry } from '../framework/tool-registry.js';
import { createCheckPolicyToolRegistration } from './check-policy/manifest.js';
import { createGetRecipeToolRegistration } from './get-recipe/manifest.js';
import { createGetRecipeFileToolRegistration } from './get-recipe-file/manifest.js';
import { createGetRunIdToolRegistration } from './get-run-id/manifest.js';
import { createLifecycleEventToolRegistration } from './lifecycle-event/manifest.js';
import { createLinkRunToIssueToolRegistration } from './link-run-to-issue/manifest.js';
import { createLinkRunToPrToolRegistration } from './link-run-to-pr/manifest.js';
import { createListContextPacksToolRegistration } from './list-context-packs/manifest.js';
import { createListRecipesToolRegistration } from './list-recipes/manifest.js';
import { pingToolRegistration } from './ping/manifest.js';
import { createPrepareJiraCommentToolRegistration } from './prepare-jira-comment/manifest.js';
import { createQueryDecisionsToolRegistration } from './query-decisions/manifest.js';
import { createQueryDecisionsByFileToolRegistration } from './query-decisions-by-file/manifest.js';
import { createQueryRunDiffToolRegistration } from './query-run-diff/manifest.js';
import { createQueryRunHistoryToolRegistration } from './query-run-history/manifest.js';
import { createReadContextPackToolRegistration } from './read-context-pack/manifest.js';
import { createRecordDecisionToolRegistration } from './record-decision/manifest.js';
import { createSaveContextPackToolRegistration } from './save-context-pack/manifest.js';
import { createSearchPacksNlToolRegistration } from './search-packs-nl/manifest.js';
import { createWikiAskToolRegistration } from './wiki-ask/manifest.js';
import { createWikiSavePageToolRegistration } from './wiki-save-page/manifest.js';
import { createWikiSaveStructureToolRegistration } from './wiki-save-structure/manifest.js';
import { createWikiStatusToolRegistration } from './wiki-status/manifest.js';
import { createWorkPackStatusToolRegistration } from './work-pack-status/manifest.js';
import { createWorkPackUpdateToolRegistration } from './work-pack-update/manifest.js';
import { createWorkPackUpsertToolRegistration } from './work-pack-upsert/manifest.js';

/**
 * `apps/mcp-server/src/tools/index.ts` — registration barrel.
 *
 * Every tool under `src/tools/<name>/` is registered here. The guard
 * test `__tests__/unit/tools/_no-unregistered-tools.test.ts` walks
 * the `src/tools` directory and asserts each folder has a
 * corresponding registration — the failure mode named in
 * `essentialsforclaude/10-troubleshooting.md` ("tools/list returns
 * empty because a manifest was not wired in") becomes a CI error
 * rather than a runtime surprise.
 *
 * Tools whose handlers need process-level config (e.g. `get_run_id`
 * needs the DB handle and `COODRA_MODE`) are exported from their
 * `manifest.ts` as `createXxxToolRegistration(deps)` factories; this
 * barrel is the single place those factories are called.
 *
 * Tools whose handlers are pure (e.g. `ping`) export a static
 * `xxxToolRegistration` constant that is registered directly.
 */

export interface RegisterAllToolsDeps {
  readonly db: DbHandle;
  readonly mode: 'solo' | 'team';
  /** Threaded to lifecycle_event's SessionEnd finalizer — see LifecycleEventHandlerDeps. */
  readonly contextPacksRoot?: string;
  /**
   * COOD-82 graph refresh worker. Daemon-only (HTTP transport); on
   * stdio this is omitted and SessionEnd triggers no rebuild.
   */
  readonly graphRefresh?: GraphRefreshWorkerHandle;
}

export function registerAllTools(registry: ToolRegistry, deps: RegisterAllToolsDeps): void {
  registry.register(pingToolRegistration);
  registry.register(createGetRunIdToolRegistration({ db: deps.db, mode: deps.mode }));
  registry.register(
    createLifecycleEventToolRegistration({
      db: deps.db,
      mode: deps.mode,
      ...(deps.contextPacksRoot !== undefined ? { contextPacksRoot: deps.contextPacksRoot } : {}),
      // COOD-82: present only when the daemon wired one (HTTP transport).
      ...(deps.graphRefresh !== undefined ? { graphRefresh: deps.graphRefresh } : {}),
    }),
  );
  registry.register(createSaveContextPackToolRegistration({ db: deps.db }));
  registry.register(createSearchPacksNlToolRegistration({ db: deps.db }));
  registry.register(createRecordDecisionToolRegistration({ db: deps.db }));
  registry.register(createQueryRunHistoryToolRegistration({ db: deps.db }));
  registry.register(createCheckPolicyToolRegistration({ db: deps.db }));
  // Slice 4 (2026-05-03 audit): cross-session decisions read-path. Closes
  // the gap that record_decision wrote rows nothing in the 9-tool surface
  // could read back. See manifest.ts docblock.
  registry.register(createQueryDecisionsToolRegistration({ db: deps.db }));
  registry.register(createQueryDecisionsByFileToolRegistration({ db: deps.db }));
  // Module 05 (2026-05-08 reshape): the two agent-driven retrieval
  // tools that replaced the abandoned embedding pipeline.
  registry.register(createListContextPacksToolRegistration({ db: deps.db }));
  registry.register(createReadContextPackToolRegistration({ db: deps.db }));
  // Agent Recipes (2026-07-31; renamed from Skills / Features): the three
  // retrieval tools that back the .coodra/recipes/<slug>/ reusable guidance
  // layer (legacy docs/skills and docs/features are still read — see
  // @coodra/shared recipesRoot).
  // See packages/shared/src/features/types.ts for the format spec, and
  // apps/hooks-bridge/src/lib/features-index-loader.ts for the SessionStart
  // injection that surfaces the index list to agents. The pre-rename tool
  // names (list_skills/get_skill/get_skill_file, list_features/get_feature/
  // get_feature_file) were removed as backward-compat aliases once the
  // rename had shipped for a full cycle; call list_recipes/get_recipe/
  // get_recipe_file directly.
  registry.register(createListRecipesToolRegistration({ db: deps.db }));
  registry.register(createGetRecipeToolRegistration({ db: deps.db }));
  registry.register(createGetRecipeFileToolRegistration({ db: deps.db }));
  // Module 06 (Run Diff, 2026-05-09): surfaces run_diffs rows written
  // by the hooks-bridge SessionEnd runner. Server-side computation is
  // pure-deterministic (git diff, no LLM); the agent reads the
  // structured output and writes its own narrative recap into
  // save_context_pack. ADR-013 records why M06 ships TypeScript-in-
  // process with no external LLM (supersedes ADR-002 for this module).
  registry.register(createQueryRunDiffToolRegistration({ db: deps.db }));
  // Module 09 (External MCP Integrations, track 9A — provider-direct
  // linking, ADR-016): link_run_to_issue/link_run_to_pr bind a run to a
  // tracker issue and/or a PR/MR (runs.issue_ref, runs.pr_ref — two
  // independent columns, so a run can be bound to both at once) so Coodra
  // history is issue/PR-aware ("what touched PROJ-412?"). These are
  // Coodra's only provider-linking tools — the provider's own tools
  // themselves (getJiraIssue, GitHub/GitLab PR reads, etc.) come from the
  // agent's own native MCP/connector settings, not from this server. J2
  // added link_run_to_issue; J3 added prepare_jira_comment (superseded by
  // the query_decisions-based sync-back flow — kept for backward compat,
  // no longer recommended by the coodra-work skill); COOD-work-redesign
  // added link_run_to_pr. Tool count 15 → 17 → 22.
  registry.register(createLinkRunToIssueToolRegistration({ db: deps.db }));
  registry.register(createLinkRunToPrToolRegistration({ db: deps.db }));
  registry.register(createPrepareJiraCommentToolRegistration({ db: deps.db }));
  // Module 10 (Deep Wiki, 2026-06-06): the DeepWiki-style two-pass flow.
  // The agent plans a hierarchical/mind-map wiki and persists it via
  // wiki_save_structure (pass 1, writes a pending page skeleton), authors
  // each page via wiki_save_page (pass 2, Markdown + Mermaid + citations),
  // and resumes via wiki_status. Coodra runs no LLM/embeddings — the agent
  // is the model; Coodra is the schema + persistence + web render
  // (ADR-012/013 "ship records, not services"). Tool count 17 → 20.
  registry.register(createWikiSaveStructureToolRegistration({ db: deps.db }));
  registry.register(createWikiSavePageToolRegistration({ db: deps.db }));
  registry.register(createWikiStatusToolRegistration({ db: deps.db }));
  // COOD-30 (2026-08-13): wiki_ask is the cloud-facing counterpart to the
  // CLI's local-only `coodra wiki ask` — reads through this server's own
  // DbHandle (local SQLite solo, shared Postgres team), so a teammate who
  // never ran `wiki build` locally can still query a wiki that exists.
  registry.register(createWikiAskToolRegistration({ db: deps.db }));
  // COOD-12 (2026-07-31): Work Packs are Coodra's local issue-bound
  // implementation artifact. The agent reads/writes Jira through Atlassian
  // Rovo MCP, then persists local state with these tools.
  registry.register(createWorkPackUpsertToolRegistration({ db: deps.db }));
  registry.register(createWorkPackUpdateToolRegistration({ db: deps.db }));
  registry.register(createWorkPackStatusToolRegistration({ db: deps.db }));
  // COOD-6 (2026-07-29): lifecycle_event is registered near get_run_id above.
  // It brings the count to 21 and lets native Codex plugin hooks call Coodra
  // MCP directly rather than posting to the background hooks bridge.
  // Module 09 (External MCP Integrations, track 9B): Graphify is consumed
  // as its OWN MCP server wired alongside Coodra (ADR-010 / ADR-015) — the
  // agent calls Graphify's query_graph/get_node/etc. directly. Coodra mints
  // NO Work Packs from the graph: Graphify remains structural context, while
  // Work Packs are issue-bound artifacts imported via the `coodra work` flow.
}
