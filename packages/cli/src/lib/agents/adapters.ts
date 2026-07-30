import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { removeCodexConfig } from '../init/codex-merge.js';
import { mergeCursorMcpConfig, removeCursorMcpConfig } from '../init/cursor-merge.js';
import { type InstructionFileName, mergeInstructionFile, removeInstructionBlock } from '../init/instruction-files.js';
import { buildCoodraMcpEntry } from '../init/mcp-merge.js';
import type { WriteOutcome } from '../init/types.js';
import {
  defaultWindsurfMcpConfigPath,
  mergeWindsurfMcpConfig,
  removeWindsurfMcpConfig,
} from '../init/windsurf-merge.js';
import { installClaudePlugin, probeClaudePlugin, removeClaudePlugin } from './claude-plugin.js';
import { installCodexPlugin, probeCodexPlugin, removeCodexPlugin } from './codex-plugin.js';
import { probeInstructionFile, probeMcpJson, toFileState } from './status-probes.js';
import type {
  AgentAdapter,
  AgentContext,
  AgentDetection,
  AgentFileState,
  AgentPathContext,
  AgentRemoveContext,
  AgentStatus,
  AgentTypeStamp,
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

/** Build the per-agent MCP entry, stamping this adapter's agentType. */
function mcpEntry(ctx: AgentContext, agentType: AgentTypeStamp) {
  return buildCoodraMcpEntry({ ...ctx.mcpEntryOptions, agentType });
}

/** Shared helper: this agent's instruction file path + a fresh probe. */
async function instructionFileState(cwd: string, filename: InstructionFileName): Promise<AgentFileState> {
  const path = join(cwd, filename);
  return { label: filename, path, state: toFileState(await probeInstructionFile(path)) };
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
    const probe = await probeClaudePlugin(ctx);
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
    return (await installClaudePlugin(ctx)).outcomes;
  },
  async remove(ctx: AgentRemoveContext): Promise<readonly WriteOutcome[]> {
    return (await removeClaudePlugin(ctx)).outcomes;
  },
};

// ---------------------------------------------------------------------------
// cursor — .cursor/mcp.json + .cursorrules
// ---------------------------------------------------------------------------

const cursorAdapter: AgentAdapter = {
  id: 'cursor',
  displayName: 'Cursor',
  agentType: 'cursor',
  detectionDir: '.cursor',
  detect: (userHome) => detectDir(userHome, '.cursor'),
  async status(ctx: AgentPathContext): Promise<AgentStatus> {
    const mcpPath = join(ctx.cwd, '.cursor', 'mcp.json');
    const files: AgentFileState[] = [
      { label: '.cursor/mcp.json', path: mcpPath, state: toFileState(await probeMcpJson(mcpPath)) },
      await instructionFileState(ctx.cwd, '.cursorrules'),
    ];
    return buildStatus(this, await this.detect(ctx.userHome), files);
  },
  async wire(ctx: AgentContext): Promise<readonly WriteOutcome[]> {
    const mcp = await mergeCursorMcpConfig({
      cwd: ctx.cwd,
      entry: mcpEntry(ctx, 'cursor'),
      force: ctx.force,
      dryRun: ctx.dryRun,
    });
    const instr = await mergeInstructionFile({
      cwd: ctx.cwd,
      filename: '.cursorrules',
      projectSlug: ctx.projectSlug,
      dryRun: ctx.dryRun,
    });
    return [mcp, instr];
  },
  async remove(ctx: AgentRemoveContext): Promise<readonly WriteOutcome[]> {
    const mcp = await removeCursorMcpConfig({ cwd: ctx.cwd, dryRun: ctx.dryRun });
    const instr = await removeInstructionBlock({ cwd: ctx.cwd, filename: '.cursorrules', dryRun: ctx.dryRun });
    return [mcp, instr];
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
    'Restart Codex, install/enable the Coodra plugin from the Personal marketplace if prompted, then review/trust bundled hooks with /hooks.',
  detect: (userHome) => detectDir(userHome, '.codex'),
  async status(ctx: AgentPathContext): Promise<AgentStatus> {
    const probe = await probeCodexPlugin(ctx);
    const files: AgentFileState[] = [
      {
        label: '~/.agents/plugins/marketplace.json',
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
    return (await installCodexPlugin(ctx)).outcomes;
  },
  async remove(ctx: AgentRemoveContext): Promise<readonly WriteOutcome[]> {
    const plugin = await removeCodexPlugin(ctx);
    const legacyMcp = await removeCodexConfig({ cwd: ctx.cwd, dryRun: ctx.dryRun });
    const legacyInstr = await removeInstructionBlock({ cwd: ctx.cwd, filename: 'AGENTS.md', dryRun: ctx.dryRun });
    return [...plugin.outcomes, legacyMcp, legacyInstr];
  },
};

// ---------------------------------------------------------------------------
// windsurf — ~/.codeium/windsurf/mcp_config.json (GLOBAL, no cwd) + .windsurfrules
// Public label is "Devin" (Cognition's rebrand of the Windsurf/Cascade/Codeium
// family); `coodra agent add devin` resolves here. The config paths + agentType
// stay `windsurf` — that's what the on-disk files and DB attribution use.
// ---------------------------------------------------------------------------

const windsurfAdapter: AgentAdapter = {
  id: 'windsurf',
  displayName: 'Windsurf',
  aka: 'Devin',
  agentType: 'windsurf',
  detectionDir: '.windsurf',
  detect: (userHome) => detectDir(userHome, '.windsurf'),
  async status(ctx: AgentPathContext): Promise<AgentStatus> {
    const mcpPath = defaultWindsurfMcpConfigPath(ctx.userHome);
    const files: AgentFileState[] = [
      { label: '~/.codeium/windsurf/mcp_config.json', path: mcpPath, state: toFileState(await probeMcpJson(mcpPath)) },
      await instructionFileState(ctx.cwd, '.windsurfrules'),
    ];
    return buildStatus(this, await this.detect(ctx.userHome), files);
  },
  async wire(ctx: AgentContext): Promise<readonly WriteOutcome[]> {
    const mcp = await mergeWindsurfMcpConfig({
      entry: mcpEntry(ctx, 'windsurf'),
      force: ctx.force,
      dryRun: ctx.dryRun,
      userHome: ctx.userHome,
    });
    const instr = await mergeInstructionFile({
      cwd: ctx.cwd,
      filename: '.windsurfrules',
      projectSlug: ctx.projectSlug,
      dryRun: ctx.dryRun,
    });
    return [mcp, instr];
  },
  async remove(ctx: AgentRemoveContext): Promise<readonly WriteOutcome[]> {
    const mcp = await removeWindsurfMcpConfig({ dryRun: ctx.dryRun, userHome: ctx.userHome });
    const instr = await removeInstructionBlock({ cwd: ctx.cwd, filename: '.windsurfrules', dryRun: ctx.dryRun });
    return [mcp, instr];
  },
};

export const ADAPTERS: Readonly<Record<import('./types.js').AgentId, AgentAdapter>> = {
  claude: claudeAdapter,
  cursor: cursorAdapter,
  codex: codexAdapter,
  windsurf: windsurfAdapter,
};
