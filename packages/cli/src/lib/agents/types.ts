import type { BuildMcpEntryOptions } from '../init/mcp-merge.js';
import type { WriteOutcome } from '../init/types.js';

/**
 * `lib/agents/` — the AgentAdapter registry. The single implementation of
 * "how Coodra wires one coding agent." Before this, per-agent wiring was
 * duplicated across `init.ts` (the interactive install), `agents.ts` (the
 * read-only status report), and `uninstall.ts` (the reversal), each with its
 * own copy of the "which files does Claude/Codex own" map. The registry
 * collapses those into one adapter per agent; `coodra agent
 * add/status/remove/repair`, `coodra init`, and `coodra agents` all drive it.
 *
 * Ownership boundary:
 * `coodra init` owns only `<repo>/.coodra/`. `coodra agent add` owns the
 * native agent surfaces. Claude Code and Codex are the only supported
 * agents, both using global plugin bundles:
 *   - claude → ~/.coodra/claude-marketplaces/coodra + ~/.claude plugin registry/cache/settings
 *   - codex  → ~/.agents/plugins/marketplace.json + ~/.codex/plugins/coodra
 */

/** Canonical agent ids. */
export type AgentId = 'claude' | 'codex';

/** The COODRA_AGENT_TYPE stamp / runs.agent_type value for each agent. */
export type AgentTypeStamp = 'claude_code' | 'codex';

export interface AgentDetection {
  /** True when the agent's home config dir (e.g. ~/.claude) exists. */
  readonly installed: boolean;
  /** The absolute path probed for detection. */
  readonly detectionPath: string;
}

/** Tri-state per config surface: coodra present / file exists but no coodra / no file. */
export type FileWireState = 'wired' | 'partial' | 'missing';

export interface AgentFileState {
  readonly label: string;
  readonly path: string;
  readonly state: FileWireState;
  readonly notes?: string;
}

export interface AgentStatus {
  readonly id: AgentId;
  readonly displayName: string;
  readonly detection: AgentDetection;
  readonly files: readonly AgentFileState[];
  /** True when every Coodra surface for this agent is wired. */
  readonly fullyWired: boolean;
}

/** Filesystem anchors shared by status / wire / remove. */
export interface AgentPathContext {
  /** Project root — anchors project-scoped files for legacy adapters and project reads. */
  readonly cwd: string;
  /** $HOME — anchors global native agent files. */
  readonly userHome: string;
  /** Override for ~/.claude/settings.json (tests). */
  readonly settingsPath?: string;
}

/** Everything an adapter needs to WRITE the per-agent surfaces. */
export interface AgentContext extends AgentPathContext {
  readonly projectSlug: string;
  readonly bridgePort: number;
  readonly localHookSecret?: string;
  /** Ingredients for the per-agent MCP entry — the adapter appends its own `agentType`. */
  readonly mcpEntryOptions: Omit<BuildMcpEntryOptions, 'agentType'>;
  readonly force: boolean;
  readonly dryRun: boolean;
}

/** What an adapter needs to REMOVE the per-agent surfaces. */
export interface AgentRemoveContext extends AgentPathContext {
  readonly coodraHome: string;
  readonly bridgePort: number;
  readonly dryRun: boolean;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  readonly agentType: AgentTypeStamp;
  /** Home-relative config dir probed for detection (e.g. '.claude'). */
  readonly detectionDir: string;
  /** Printed once by the command layer after a successful `wire` (e.g. Codex trust note). */
  readonly postWireNote?: string;
  detect(userHome: string): Promise<AgentDetection>;
  status(ctx: AgentPathContext): Promise<AgentStatus>;
  wire(ctx: AgentContext): Promise<readonly WriteOutcome[]>;
  remove(ctx: AgentRemoveContext): Promise<readonly WriteOutcome[]>;
}
