import { MANAGED_PATHS } from '../graphify/artifacts.js';
import { managedGraphifyPythonPath } from '../graphify/managed-runtime.js';
import type { ExternalMcpEntry } from '../init/external-mcp-merge.js';

/**
 * Default agent capabilities packaged inside Coodra's native plugins.
 *
 * `coodra graphify enable` still exists as the explicit/custom wiring path for
 * project config files. Native Coodra plugins, however, should be useful out of
 * the box: they expose Graphify's own MCP server against Coodra's managed graph
 * path, so an agent with the plugin installed has the structural-query surface
 * as soon as `.coodra/graphify/out/graph.json` exists.
 */
export function buildManagedGraphifyMcpEntry(coodraHome: string): ExternalMcpEntry {
  return {
    command: managedGraphifyPythonPath(coodraHome),
    args: ['-m', 'graphify.serve', MANAGED_PATHS.graphJson],
  };
}
