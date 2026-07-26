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
 * The *wiring* surface (writing the `graphify` MCP entry into agent configs)
 * is a separate module — `@coodra/cli/lib/init/graphify-wire`.
 */
export {
  absOf,
  countGraph,
  detectGraphifyLayout,
  GRAPHIFY_RECORD_REL,
  type GraphCommunitySummary,
  type GraphCounts,
  type GraphHubNode,
  type GraphifyArtifactScan,
  type GraphifyLayoutDetection,
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
