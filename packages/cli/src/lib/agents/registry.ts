import { ADAPTERS } from './adapters.js';
import type { AgentAdapter, AgentId } from './types.js';

/**
 * Registry surface over the four supported adapters (Claude Code, Codex, Cursor, Devin).
 */

/** Canonical display order. */
export const AGENT_ORDER: readonly AgentId[] = ['claude', 'codex', 'cursor', 'devin'] as const;

/** Input aliases → canonical id. */
const AGENT_ALIASES: Readonly<Record<string, AgentId>> = {
  claude_code: 'claude',
  'claude-code': 'claude',
};

/** Every accepted input token (canonical ids + aliases), for help text + validation. */
export const ACCEPTED_AGENT_TOKENS: readonly string[] = [...AGENT_ORDER, ...Object.keys(AGENT_ALIASES)];

export function getAdapter(id: AgentId): AgentAdapter {
  return ADAPTERS[id];
}

export function listAdapters(): readonly AgentAdapter[] {
  return AGENT_ORDER.map((id) => ADAPTERS[id]);
}

export interface ResolvedAgentInput {
  readonly adapter: AgentAdapter;
  /** The canonical id the input resolved to. */
  readonly id: AgentId;
  /** Whether the caller typed an alias (e.g. `claude-code` for `claude`). */
  readonly viaAlias: boolean;
  /** User-facing label: the alias (title-cased) when one was typed, else the adapter's display name. */
  readonly label: string;
}

/**
 * Resolve a user-supplied agent token to an adapter. Case-insensitive.
 * Returns null for unknown tokens so the caller can surface a clean error.
 */
export function resolveAgentInput(raw: string): ResolvedAgentInput | null {
  const token = raw.trim().toLowerCase();
  if (token.length === 0) return null;

  let id: AgentId | null = null;
  let viaAlias = false;
  if ((AGENT_ORDER as readonly string[]).includes(token)) {
    id = token as AgentId;
  } else if (Object.hasOwn(AGENT_ALIASES, token)) {
    id = AGENT_ALIASES[token] as AgentId;
    viaAlias = true;
  }
  if (id === null) return null;

  const adapter = ADAPTERS[id];
  const label = viaAlias ? `${token.charAt(0).toUpperCase()}${token.slice(1)}` : adapter.displayName;
  return { adapter, id, viaAlias, label };
}
