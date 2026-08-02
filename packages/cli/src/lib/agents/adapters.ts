import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { removeCodexConfig } from '../init/codex-merge.js';
import { removeInstructionBlock } from '../init/instruction-files.js';
import type { WriteOutcome } from '../init/types.js';
import { type ClaudeCliRunner, installClaudePlugin, probeClaudePlugin, removeClaudePlugin } from './claude-plugin.js';
import { type CodexCliRunner, installCodexPlugin, probeCodexPlugin, removeCodexPlugin } from './codex-plugin.js';
import type {
  AgentAdapter,
  AgentContext,
  AgentDetection,
  AgentFileState,
  AgentPathContext,
  AgentRemoveContext,
  AgentStatus,
} from './types.js';

async function detectDir(userHome: string, dir: string): Promise<AgentDetection> {
  const detectionPath = join(userHome, dir);
  try {
    await access(detectionPath);
    return { installed: true, detectionPath };
  } catch {
    return { installed: false, detectionPath };
  }
}

function buildStatus(
  base: Pick<AgentAdapter, 'id' | 'displayName'>,
  detection: AgentDetection,
  files: readonly AgentFileState[],
): AgentStatus {
  return {
    id: base.id,
    displayName: base.displayName,
    detection,
    files,
    fullyWired: files.every((f) => f.state === 'wired'),
  };
}

// ---------------------------------------------------------------------------
// claude — global native Claude Code plugin via a Coodra-owned local marketplace.
// Source lives under ~/.coodra; Claude owns registry/cache under ~/.claude.
// ---------------------------------------------------------------------------

const claudeAdapter: AgentAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  agentType: 'claude_code',
  detectionDir: '.claude',
  postWireNote: 'Restart Claude Code or run /reload-plugins, then confirm Coodra appears as coodra@coodra in /plugin.',
  detect: (userHome) => detectDir(userHome, '.claude'),
  async status(ctx: AgentPathContext): Promise<AgentStatus> {
    const probe = await probeClaudePlugin(ctx, ctx.claudeCliRunner as ClaudeCliRunner | undefined);
    const files: AgentFileState[] = [
      {
        label: 'Claude user plugin enablement',
        path: probe.paths.settingsPath,
        state: probe.enabled ? 'wired' : 'missing',
      },
      {
        label: 'Claude local marketplace',
        path: probe.paths.marketplacePath,
        state: probe.marketplace ? 'wired' : 'missing',
      },
      {
        label: 'Claude plugin manifest',
        path: probe.paths.cacheManifestPath,
        state: probe.manifest ? 'wired' : 'missing',
      },
      {
        label: 'Claude plugin MCP',
        path: probe.paths.cacheMcpPath,
        state: probe.mcp ? 'wired' : 'missing',
      },
      {
        label: 'Claude plugin hooks',
        path: probe.paths.cacheHooksPath,
        state: probe.hooks ? 'wired' : 'missing',
      },
      {
        label: 'Claude plugin skills',
        path: probe.paths.cacheSkillsRoot,
        state: probe.skills ? 'wired' : 'missing',
      },
    ];
    return buildStatus(this, await this.detect(ctx.userHome), files);
  },
  async wire(ctx: AgentContext): Promise<readonly WriteOutcome[]> {
    return (await installClaudePlugin(ctx, ctx.claudeCliRunner as ClaudeCliRunner | undefined)).outcomes;
  },
  async remove(ctx: AgentRemoveContext): Promise<readonly WriteOutcome[]> {
    return (await removeClaudePlugin(ctx, ctx.claudeCliRunner as ClaudeCliRunner | undefined)).outcomes;
  },
};

// ---------------------------------------------------------------------------
// codex — global Codex plugin via the local personal marketplace.
// ---------------------------------------------------------------------------

const codexAdapter: AgentAdapter = {
  id: 'codex',
  displayName: 'Codex',
  agentType: 'codex',
  detectionDir: '.codex',
  postWireNote:
    'Coodra registers its own dedicated Codex marketplace (not your personal one) and installs the Coodra plugin ' +
    "via `codex plugin add` when the codex CLI is available — that's real installation, not just a file write. " +
    'Restart Codex, then review/trust bundled hooks with /hooks.',
  detect: (userHome) => detectDir(userHome, '.codex'),
  async status(ctx: AgentPathContext): Promise<AgentStatus> {
    const probe = await probeCodexPlugin(ctx, ctx.codexCliRunner as CodexCliRunner | undefined);
    const files: AgentFileState[] = [
      {
        label: 'Coodra Codex marketplace',
        path: probe.paths.marketplacePath,
        state: probe.marketplace ? 'wired' : 'missing',
      },
      {
        label: 'Codex plugin manifest',
        path: probe.paths.manifestPath,
        state: probe.manifest ? 'wired' : 'missing',
      },
      {
        label: 'Codex plugin MCP',
        path: probe.paths.mcpPath,
        state: probe.mcp ? 'wired' : 'missing',
      },
      {
        label: 'Codex plugin hooks',
        path: probe.paths.hooksPath,
        state: probe.hooks ? 'wired' : 'missing',
      },
      {
        label: 'Codex plugin skills',
        path: probe.paths.skillsRoot,
        state: probe.skills ? 'wired' : 'missing',
      },
    ];
    return buildStatus(this, await this.detect(ctx.userHome), files);
  },
  async wire(ctx: AgentContext): Promise<readonly WriteOutcome[]> {
    return (await installCodexPlugin(ctx, ctx.codexCliRunner as CodexCliRunner | undefined)).outcomes;
  },
  async remove(ctx: AgentRemoveContext): Promise<readonly WriteOutcome[]> {
    const plugin = await removeCodexPlugin(ctx, ctx.codexCliRunner as CodexCliRunner | undefined);
    const legacyMcp = await removeCodexConfig({ cwd: ctx.cwd, dryRun: ctx.dryRun });
    const legacyInstr = await removeInstructionBlock({ cwd: ctx.cwd, filename: 'AGENTS.md', dryRun: ctx.dryRun });
    return [...plugin.outcomes, legacyMcp, legacyInstr];
  },
};

export const ADAPTERS: Readonly<Record<import('./types.js').AgentId, AgentAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};
