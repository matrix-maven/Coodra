import type { DbHandle } from '@coodra/db';

import type { ToolRegistry } from '../framework/tool-registry.js';
import { createCheckPolicyToolRegistration } from './check-policy/manifest.js';
import { createGetFeatureToolRegistration } from './get-feature/manifest.js';
import { createGetFeatureFileToolRegistration } from './get-feature-file/manifest.js';
import { getFeaturePackToolRegistration } from './get-feature-pack/manifest.js';
import { createGetRunIdToolRegistration } from './get-run-id/manifest.js';
import { createLinkRunToIssueToolRegistration } from './link-run-to-issue/manifest.js';
import { createListContextPacksToolRegistration } from './list-context-packs/manifest.js';
import { createListFeaturesToolRegistration } from './list-features/manifest.js';
import { pingToolRegistration } from './ping/manifest.js';
import { createPrepareJiraCommentToolRegistration } from './prepare-jira-comment/manifest.js';
import { createQueryDecisionsToolRegistration } from './query-decisions/manifest.js';
import { createQueryRunDiffToolRegistration } from './query-run-diff/manifest.js';
import { createQueryRunHistoryToolRegistration } from './query-run-history/manifest.js';
import { createReadContextPackToolRegistration } from './read-context-pack/manifest.js';
import { createRecordDecisionToolRegistration } from './record-decision/manifest.js';
import { createSaveContextPackToolRegistration } from './save-context-pack/manifest.js';
import { createSearchPacksNlToolRegistration } from './search-packs-nl/manifest.js';
import { createWikiSavePageToolRegistration } from './wiki-save-page/manifest.js';
import { createWikiSaveStructureToolRegistration } from './wiki-save-structure/manifest.js';
import { createWikiStatusToolRegistration } from './wiki-status/manifest.js';

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
}

export function registerAllTools(registry: ToolRegistry, deps: RegisterAllToolsDeps): void {
  registry.register(pingToolRegistration);
  registry.register(createGetRunIdToolRegistration({ db: deps.db, mode: deps.mode }));
  registry.register(getFeaturePackToolRegistration);
  registry.register(createSaveContextPackToolRegistration({ db: deps.db }));
  registry.register(createSearchPacksNlToolRegistration({ db: deps.db }));
  registry.register(createRecordDecisionToolRegistration({ db: deps.db }));
  registry.register(createQueryRunHistoryToolRegistration({ db: deps.db }));
  registry.register(createCheckPolicyToolRegistration({ db: deps.db }));
  // Slice 4 (2026-05-03 audit): cross-session decisions read-path. Closes
  // the gap that record_decision wrote rows nothing in the 9-tool surface
  // could read back. See manifest.ts docblock.
  registry.register(createQueryDecisionsToolRegistration({ db: deps.db }));
  // Module 05 (2026-05-08 reshape): the two new agent-driven retrieval
  // tools that replace the abandoned embedding pipeline. See
  // docs/feature-packs/05-agent-driven-nl-assembly/spec.md §5.1, §5.2.
  registry.register(createListContextPacksToolRegistration({ db: deps.db }));
  registry.register(createReadContextPackToolRegistration({ db: deps.db }));
  // Skill-style features (2026-05-08): the three retrieval tools that
  // back the docs/features/<slug>/ knowledge-units layer. See
  // packages/shared/src/features/types.ts for the format spec, and
  // apps/hooks-bridge/src/lib/features-index-loader.ts for the
  // SessionStart injection that surfaces the index list to agents.
  registry.register(createListFeaturesToolRegistration({ db: deps.db }));
  registry.register(createGetFeatureToolRegistration({ db: deps.db }));
  registry.register(createGetFeatureFileToolRegistration({ db: deps.db }));
  // Module 06 (Run Diff, 2026-05-09): surfaces run_diffs rows written
  // by the hooks-bridge SessionEnd runner. Server-side computation is
  // pure-deterministic (git diff, no LLM); the agent reads the
  // structured output and writes its own narrative recap into
  // save_context_pack. ADR-013 records why M06 ships TypeScript-in-
  // process with no external LLM (supersedes ADR-002 for this module).
  registry.register(createQueryRunDiffToolRegistration({ db: deps.db }));
  // Module 09 (External MCP Integrations, track 9A — Jira = Direct, ADR-016):
  // link_run_to_issue binds a run to its Jira key (runs.issue_ref) so Coodra
  // history is Jira-aware ("what touched PROJ-412?"). This is Coodra's ONLY
  // Jira MCP tool — the Jira tools themselves (getJiraIssue, etc.) come from
  // Atlassian's Rovo MCP wired alongside Coodra via `coodra jira enable`, not
  // from this server. J2 added link_run_to_issue; J3 added prepare_jira_comment
  // (the on-request write-back helper — assembles the session summary from the
  // Context Pack + decisions; the AGENT posts it via Rovo's addCommentToJiraIssue,
  // only when the user asks). Coodra's only two Jira tools. Tool count 15 → 17.
  registry.register(createLinkRunToIssueToolRegistration({ db: deps.db }));
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
  // Module 09 (External MCP Integrations, track 9B): Graphify is consumed
  // as its OWN MCP server wired alongside Coodra (ADR-010 / ADR-015) — the
  // agent calls Graphify's query_graph/get_node/etc. directly. Coodra mints
  // NO packs from the graph: the seed_feature_packs_from_graph +
  // build_codebase_graph tools were retired 2026-05-23 (ADR-015) because a
  // 1-community-1-pack dump produced hundreds of un-injectable shells. See
  // docs/feature-packs/09-integrations/ and `coodra graphify enable`.
}
