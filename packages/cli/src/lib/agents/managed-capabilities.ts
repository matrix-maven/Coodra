import { MANAGED_PATHS } from '../graphify/artifacts.js';
import { managedGraphifyPythonPath } from '../graphify/managed-runtime.js';
import type { ExternalMcpEntry } from '../init/external-mcp-merge.js';

/**
 * Default agent capabilities packaged inside Coodra's native plugins.
 *
 * Graphify wiring is Coodra-owned end to end — there is no separate
 * per-project wiring command. Native Coodra plugins are useful out of the
 * box: they expose Graphify's own MCP server against Coodra's managed graph
 * path, so an agent with the plugin installed has the structural-query surface
 * as soon as `.coodra/graphify/out/graph.json` exists.
 */
export function buildManagedGraphifyMcpEntry(
  coodraHome: string,
  platform: NodeJS.Platform = process.platform,
): ExternalMcpEntry {
  return {
    command: managedGraphifyPythonPath(coodraHome, platform),
    args: ['-m', 'graphify.serve', MANAGED_PATHS.graphJson],
  };
}
