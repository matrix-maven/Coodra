import { ADAPTERS } from './adapters.js';
import type { AgentAdapter, AgentId } from './types.js';

/**
 * Registry surface over the four adapters + the `devin` input alias.
 *
 * `devin` is Cognition's rebrand of the Windsurf/Cascade/Codeium family; it is
 * accepted everywhere a `windsurf` id is accepted and resolves to the same
 * adapter (same on-disk config paths, same `windsurf` agent_type — ADR: keep
 * `windsurf` in the DB, treat Devin as a display/input alias). `windsurf`
 * remains a first-class id.
 */

/** Canonical display order (matches detect.ts IDE_ORDER). */
export const AGENT_ORDER: readonly AgentId[] = ['claude', 'cursor', 'windsurf', 'codex'] as const;

/** Input aliases → canonical id. */
const AGENT_ALIASES: Readonly<Record<string, AgentId>> = {
  devin: 'windsurf',
  cascade: 'windsurf',
  codeium: 'windsurf',
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
  /** Whether the caller typed an alias (e.g. `devin` for `windsurf`). */
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
