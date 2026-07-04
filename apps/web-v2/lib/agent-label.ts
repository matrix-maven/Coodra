/**
 * `lib/agent-label.ts` — display names for `runs.agent_type` values.
 *
 * The DB stores the canonical snake_case enum (`claude_code`, `codex`,
 * `unknown`, …). Rendering the raw value reads as a bug to users
 * ("why does my screen say unknown?"), so every run surface renders
 * through this map. Values outside the map (a future agent the web
 * hasn't learned yet) pass through verbatim rather than lying.
 */

const AGENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  claude_code: 'Claude Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  codex: 'Codex',
  vscode_copilot: 'VS Code Copilot',
  mcp_inspector: 'MCP Inspector',
  unknown: 'unknown agent',
};

export function agentTypeLabel(agentType: string): string {
  return AGENT_TYPE_LABELS[agentType] ?? agentType;
}
