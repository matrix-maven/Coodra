import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultClaudeSettingsPath, mergeClaudeSettings, removeClaudeSettings } from '../init/claude-settings-merge.js';
import { CODEX_PROJECT_CONFIG_NOTE, mergeCodexConfig, removeCodexConfig } from '../init/codex-merge.js';
import { mergeCursorMcpConfig, removeCursorMcpConfig } from '../init/cursor-merge.js';
import { type InstructionFileName, mergeInstructionFile, removeInstructionBlock } from '../init/instruction-files.js';
import { buildCoodraMcpEntry } from '../init/mcp-merge.js';
import type { WriteOutcome } from '../init/types.js';
import {
  defaultWindsurfMcpConfigPath,
  mergeWindsurfMcpConfig,
  removeWindsurfMcpConfig,
} from '../init/windsurf-merge.js';
import {
  probeCodexConfig,
  probeInstructionFile,
  probeMcpJson,
  probeSettingsJson,
  toFileState,
} from './status-probes.js';
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
// claude — ~/.claude/settings.json (hooks) + CLAUDE.md. (.mcp.json is
// project-level, ensured by the command layer, not here.)
// ---------------------------------------------------------------------------

const claudeAdapter: AgentAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  agentType: 'claude_code',
  detectionDir: '.claude',
  detect: (userHome) => detectDir(userHome, '.claude'),
  async status(ctx: AgentPathContext): Promise<AgentStatus> {
    const settingsPath = ctx.settingsPath ?? defaultClaudeSettingsPath(ctx.userHome);
    const files: AgentFileState[] = [
      {
        label: '~/.claude/settings.json',
        path: settingsPath,
        state: toFileState(await probeSettingsJson(settingsPath)),
      },
      await instructionFileState(ctx.cwd, 'CLAUDE.md'),
    ];
    return buildStatus(this, await this.detect(ctx.userHome), files);
  },
  async wire(ctx: AgentContext): Promise<readonly WriteOutcome[]> {
    const settingsPath = ctx.settingsPath ?? defaultClaudeSettingsPath(ctx.userHome);
    const merge = await mergeClaudeSettings({
      settingsPath,
      bridgePort: ctx.bridgePort,
      ...(ctx.localHookSecret !== undefined ? { localHookSecret: ctx.localHookSecret } : {}),
      force: ctx.force,
      dryRun: ctx.dryRun,
    });
    const instr = await mergeInstructionFile({
      cwd: ctx.cwd,
      filename: 'CLAUDE.md',
      projectSlug: ctx.projectSlug,
      dryRun: ctx.dryRun,
    });
    return [merge.outcome, instr];
  },
  async remove(ctx: AgentRemoveContext): Promise<readonly WriteOutcome[]> {
    const settingsPath = ctx.settingsPath ?? defaultClaudeSettingsPath(ctx.userHome);
    const rm = await removeClaudeSettings({ settingsPath, bridgePort: ctx.bridgePort, dryRun: ctx.dryRun });
    const instr = await removeInstructionBlock({ cwd: ctx.cwd, filename: 'CLAUDE.md', dryRun: ctx.dryRun });
    return [rm.outcome, instr];
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
// codex — .codex/config.toml + AGENTS.md
// ---------------------------------------------------------------------------

const codexAdapter: AgentAdapter = {
  id: 'codex',
  displayName: 'Codex',
  agentType: 'codex',
  detectionDir: '.codex',
  postWireNote: CODEX_PROJECT_CONFIG_NOTE,
  detect: (userHome) => detectDir(userHome, '.codex'),
  async status(ctx: AgentPathContext): Promise<AgentStatus> {
    const tomlPath = join(ctx.cwd, '.codex', 'config.toml');
    const files: AgentFileState[] = [
      { label: '.codex/config.toml', path: tomlPath, state: toFileState(await probeCodexConfig(tomlPath)) },
      await instructionFileState(ctx.cwd, 'AGENTS.md'),
    ];
    return buildStatus(this, await this.detect(ctx.userHome), files);
  },
  async wire(ctx: AgentContext): Promise<readonly WriteOutcome[]> {
    const toml = await mergeCodexConfig({
      cwd: ctx.cwd,
      entry: mcpEntry(ctx, 'codex'),
      force: ctx.force,
      dryRun: ctx.dryRun,
    });
    const instr = await mergeInstructionFile({
      cwd: ctx.cwd,
      filename: 'AGENTS.md',
      projectSlug: ctx.projectSlug,
      dryRun: ctx.dryRun,
    });
    return [toml, instr];
  },
  async remove(ctx: AgentRemoveContext): Promise<readonly WriteOutcome[]> {
    const toml = await removeCodexConfig({ cwd: ctx.cwd, dryRun: ctx.dryRun });
    const instr = await removeInstructionBlock({ cwd: ctx.cwd, filename: 'AGENTS.md', dryRun: ctx.dryRun });
    return [toml, instr];
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
