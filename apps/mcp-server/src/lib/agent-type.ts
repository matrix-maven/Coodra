/**
 * `apps/mcp-server/src/lib/agent-type.ts` — pure mapping from the MCP
 * `initialize.clientInfo.name` string to the canonical `runs.agent_type`
 * value.
 *
 * Per user directive Q2 (S8, 2026-04-24): the agent identity used for
 * `runs.agent_type` (NOT NULL) comes from the MCP protocol's initialize
 * handshake — `server.getClientVersion()` on the SDK `Server` exposes
 * `{ name, version }` once the client has finished the handshake.
 * Stdio + HTTP transports both carry this field; a future SSE or WS
 * transport can reuse the same mapping. Hardcoding `'unknown'` at the
 * write site would bake bad data into every row; reading
 * `process.env.COODRA_AGENT_TYPE` would break for HTTP where many
 * clients share one process.
 *
 * Interface growth (decisions-log 2026-04-24 14:30): the additive
 * `PerCallContext.agentType: string` slot on the frozen `ToolContext`
 * is the companion change. That slot was reserved as "future
 * transport-surfaced metadata" in the S7a docblock pattern.
 *
 * Mapping table — the ONE place new client names are added.
 * Canonical keys mirror the GitHub/JIRA event `agent_type` enum in
 * `system-architecture.md` §22/§23 (snake_case, lowercase).
 *
 * Unknown / missing → `'unknown'` (not thrown). The policy engine's
 * `match_agent_type` field already reserves `'*'` and `'unknown'` as
 * wildcards, so rows stamped `'unknown'` remain queryable.
 */

/** Canonical agent-type values the rest of the codebase consumes. */
export type KnownAgentType =
  | 'claude_code'
  | 'cursor'
  | 'windsurf'
  | 'codex'
  | 'vscode_copilot'
  | 'mcp_inspector'
  | 'unknown';

/**
 * Readonly mapping `clientInfo.name` → canonical `runs.agent_type`.
 *
 * Keys are the exact `name` strings each client ships in its
 * initialize handshake:
 *   - Claude Code:   'claude-ai' (prior to 2026-02) or 'claude-code'
 *   - Cursor:        'cursor-vscode' (observed) / 'cursor'
 *   - Windsurf:      'windsurf'
 *   - Codex:         'codex-mcp-client' (observed — openai/codex names its
 *                    MCP client this, NOT 'codex'; missing it stamped every
 *                    Codex run 'unknown') / 'codex' / 'codex-cli'
 *   - VS Code + Copilot Chat: 'github-copilot-chat-vscode' (observed)
 *   - MCP Inspector: 'mcp-inspector'
 *
 * Adding a new client here is the required-and-sufficient change — the
 * unit test in `__tests__/unit/lib/agent-type.test.ts` locks every
 * entry so an accidental mapping deletion fails CI.
 */
export const AGENT_TYPE_MAPPING: Readonly<Record<string, KnownAgentType>> = Object.freeze({
  'claude-code': 'claude_code',
  'claude-ai': 'claude_code',
  cursor: 'cursor',
  'cursor-vscode': 'cursor',
  windsurf: 'windsurf',
  codex: 'codex',
  'codex-cli': 'codex',
  'codex-mcp-client': 'codex',
  'github-copilot-chat-vscode': 'vscode_copilot',
  'mcp-inspector': 'mcp_inspector',
});

/**
 * Substring fallback for client names the exact table doesn't list.
 * Clients rename across releases ('codex' → 'codex-mcp-client' is the
 * observed case that stamped every Codex run 'unknown'); a product-name
 * substring is far more stable than the exact string. Ordered — first
 * match wins. 'copilot' is checked before 'cursor'/'claude' so a name
 * like 'github-copilot-…' can never mis-bucket.
 */
const AGENT_TYPE_HEURISTICS: ReadonlyArray<readonly [substring: string, agentType: KnownAgentType]> = Object.freeze([
  ['copilot', 'vscode_copilot'],
  ['codex', 'codex'],
  ['claude', 'claude_code'],
  ['cursor', 'cursor'],
  ['windsurf', 'windsurf'],
]);

/** The canonical values accepted from the COODRA_AGENT_TYPE env stamp. */
const KNOWN_AGENT_TYPES: ReadonlySet<string> = new Set<KnownAgentType>([
  'claude_code',
  'cursor',
  'windsurf',
  'codex',
  'vscode_copilot',
  'mcp_inspector',
]);

/**
 * Resolve the `runs.agent_type` value from a `clientInfo.name`.
 *
 * - Unknown / missing / non-string input → `'unknown'`.
 * - Known input → the mapped canonical value (exact table first, then
 *   the product-name substring heuristics).
 * - Case-insensitive lookup — clients sometimes capitalise.
 *
 * This function is pure, synchronous, and free of side effects. It is
 * safe to call from any code path, including the stdio transport's
 * per-request dispatch.
 */
export function mapAgentType(clientName: unknown): KnownAgentType {
  if (typeof clientName !== 'string' || clientName.length === 0) {
    return 'unknown';
  }
  const lowered = clientName.toLowerCase();
  const mapped = AGENT_TYPE_MAPPING[lowered];
  if (mapped !== undefined) return mapped;
  for (const [substring, agentType] of AGENT_TYPE_HEURISTICS) {
    if (lowered.includes(substring)) return agentType;
  }
  return 'unknown';
}

/**
 * Full resolution chain for a transport: clientInfo mapping first, then
 * the `COODRA_AGENT_TYPE` env stamp, then `'unknown'`.
 *
 * The env stamp exists for the stdio case: `coodra init` writes ONE MCP
 * config per agent (`.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`,
 * Windsurf's `mcp_config.json`) and each spawns its own server process, so
 * a per-entry `COODRA_AGENT_TYPE` is unambiguous — it identifies the agent
 * even when the client ships a `clientInfo.name` we've never seen. It is a
 * FALLBACK only: a clientInfo name that maps always wins, so a shared HTTP
 * process (where one env would cover many clients — the reason the S8
 * design rejected env-only) is never mislabeled by the stamp.
 */
export function resolveAgentType(clientName: unknown, env: NodeJS.ProcessEnv = process.env): KnownAgentType {
  const mapped = mapAgentType(clientName);
  if (mapped !== 'unknown') return mapped;
  const stamp = env.COODRA_AGENT_TYPE?.trim().toLowerCase();
  if (stamp !== undefined && KNOWN_AGENT_TYPES.has(stamp)) {
    // Safe narrow: KNOWN_AGENT_TYPES is a Set built from KnownAgentType
    // literals, so membership proves the string is one of them.
    return stamp as KnownAgentType;
  }
  return 'unknown';
}
