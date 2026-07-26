import { readFile } from 'node:fs/promises';
import { INSTRUCTION_BLOCK_START } from '../init/instruction-files.js';

/**
 * Read-only "is Coodra wired into this file?" probes. Lifted verbatim from
 * the per-agent report helpers that used to live in `commands/agents.ts`
 * (mcpJsonState / settingsJsonState / codexConfigState / instructionFileState)
 * so the status logic has ONE definition the adapters + the `agents`/`agent
 * status` commands all share. Each returns `{ exists, wired, notes? }`; the
 * caller maps that to the tri-state `FileWireState`.
 */

export interface ProbeResult {
  readonly exists: boolean;
  readonly wired: boolean;
  readonly notes?: string;
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** `.mcp.json` / `.cursor/mcp.json` — wired iff `mcpServers.coodra` is an own key. */
export async function probeMcpJson(path: string): Promise<ProbeResult> {
  const raw = await readFileOrNull(path);
  if (raw === null) return { exists: false, wired: false };
  try {
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    const wired =
      typeof parsed.mcpServers === 'object' && parsed.mcpServers !== null && Object.hasOwn(parsed.mcpServers, 'coodra');
    return { exists: true, wired };
  } catch {
    return { exists: true, wired: false, notes: 'unreadable JSON' };
  }
}

/** `~/.claude/settings.json` — wired iff a hook targets the bridge URL. */
export async function probeSettingsJson(path: string): Promise<ProbeResult> {
  const raw = await readFileOrNull(path);
  if (raw === null) return { exists: false, wired: false };
  try {
    const parsed = JSON.parse(raw) as { hooks?: unknown };
    const wired = JSON.stringify(parsed.hooks ?? {}).includes('/v1/hooks/claude-code');
    return { exists: true, wired };
  } catch {
    return { exists: true, wired: false, notes: 'unreadable JSON' };
  }
}

/** `.codex/config.toml` — wired iff the `[mcp_servers.coodra]` table is present. */
export async function probeCodexConfig(path: string): Promise<ProbeResult> {
  const raw = await readFileOrNull(path);
  if (raw === null) return { exists: false, wired: false };
  return { exists: true, wired: /\[mcp_servers\.coodra\]/.test(raw) };
}

/** CLAUDE.md / .cursorrules / AGENTS.md / .windsurfrules — wired iff the marker block is present. */
export async function probeInstructionFile(path: string): Promise<ProbeResult> {
  const raw = await readFileOrNull(path);
  if (raw === null) return { exists: false, wired: false };
  return { exists: true, wired: raw.includes(INSTRUCTION_BLOCK_START) };
}

/** Map a probe result to the tri-state used by AgentFileState. */
export function toFileState(probe: ProbeResult): 'wired' | 'partial' | 'missing' {
  if (probe.wired) return 'wired';
  if (probe.exists) return 'partial';
  return 'missing';
}
