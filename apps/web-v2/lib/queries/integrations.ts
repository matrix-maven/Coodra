import 'server-only';

import { homedir } from 'node:os';
import { detectIDE } from '@coodra/cli/lib/detect';
import { type IDE, readGraphifyPresence } from '@coodra/cli/lib/init/graphify-wire';

import { isCloudHostedWeb } from '@/lib/deployment-mode';
import { listProjects } from '@/lib/queries/projects';

/**
 * `apps/web-v2/lib/queries/integrations.ts` — read-side for the
 * `/settings/integrations` page (Module 09, Track 9B / phase G4).
 *
 * The only integration today is Graphify. The page shows, per
 * registered project, whether Graphify's stdio MCP server is wired
 * into the agent configs on this machine.
 *
 * Mode behaviour mirrors `lib/actions/services.ts`:
 *   - local web (`!isCloudHostedWeb()`) — the web process runs on the
 *     developer's machine and CAN read Claude Code's / Codex's plugin
 *     configs and `.codex/config.toml`. We probe each project's wiring.
 *   - team-hosted web — the deployed server has no local agent configs
 *     to probe. We return `cloudHosted: true` and the page renders the
 *     `coodra graphify enable` CLI command instead.
 */

export interface GraphifyProjectStatus {
  readonly slug: string;
  readonly name: string;
  /** Absolute project root. Null on pre-0010 rows that never recorded a cwd. */
  readonly cwd: string | null;
  /** How many of the machine's detected agents carry the `graphify` MCP entry. */
  readonly wiredCount: number;
}

export interface GraphifyIntegrationStatus {
  /** True on a deployed (team-hosted) server — no local configs to write. */
  readonly cloudHosted: boolean;
  /**
   * IDEs detected on this machine (`~/.claude`, `~/.cursor`, … exist).
   * These are the agents the card wires — same set `coodra graphify
   * enable` autodetects. Empty in team-hosted mode.
   */
  readonly detectedAgents: ReadonlyArray<IDE>;
  /** Per-project wiring summary. Empty in team-hosted mode. */
  readonly projects: ReadonlyArray<GraphifyProjectStatus>;
}

/**
 * Resolve the Graphify integration status for the integrations page.
 * Read-only — never writes a config file.
 */
export async function readGraphifyIntegrationStatus(): Promise<GraphifyIntegrationStatus> {
  if (isCloudHostedWeb()) {
    return { cloudHosted: true, detectedAgents: [], projects: [] };
  }

  const userHome = homedir();
  const detectedAgents = await detectIDE();
  const projects = await listProjects();

  const out: GraphifyProjectStatus[] = [];
  for (const project of projects) {
    if (project.cwd === null) {
      // Pre-0010 row with no recorded cwd — can't resolve `.mcp.json`.
      out.push({ slug: project.slug, name: project.name, cwd: null, wiredCount: 0 });
      continue;
    }
    let wiredCount = 0;
    for (const ide of detectedAgents) {
      const presence = await readGraphifyPresence({ ide, cwd: project.cwd, userHome });
      if (presence.wired) wiredCount += 1;
    }
    out.push({ slug: project.slug, name: project.name, cwd: project.cwd, wiredCount });
  }

  return { cloudHosted: false, detectedAgents, projects: out };
}
