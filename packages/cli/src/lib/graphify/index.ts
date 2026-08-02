/**
 * `@coodra/cli/lib/graphify` — the Graphify **artifact** surface (where the
 * build output lives, what's in it), re-exported for out-of-CLI consumers.
 *
 * Two consumers today:
 *   - `apps/web-v2` `/graphify` — renders artifact status, the community
 *     breakdown and the interactive `graph.html`;
 *   - the wiki grounding path — communities become candidate sections and
 *     high-degree nodes become high-importance pages (ADR-017).
 *
 * Graphify wiring itself is Coodra-owned: native Claude Code and Codex
 * plugins bundle a managed `graphify` MCP entry automatically
 * (`agents/managed-capabilities.ts`). There is no separate wiring module.
 */
export {
  absOf,
  countGraph,
  GRAPHIFY_RECORD_REL,
  type GraphCommunitySummary,
  type GraphCounts,
  type GraphHubNode,
  type GraphifyArtifactScan,
  type GraphifyPaths,
  type GraphifyRecord,
  type GraphSummary,
  graphifyRecordPath,
  LEGACY_OUT_REL,
  LEGACY_PATHS,
  MANAGED_OUT_REL,
  MANAGED_PATHS,
  pathsForOutputDir,
  readGraphifyRecord,
  readGraphSummary,
  resolveGraphifyPaths,
  scanGraphifyArtifacts,
  summarizeGraph,
  writeGraphifyRecord,
} from './artifacts.js';
