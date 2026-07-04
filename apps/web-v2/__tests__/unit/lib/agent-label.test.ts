import { describe, expect, it } from 'vitest';

import { agentTypeLabel } from '../../../lib/agent-label';

describe('agentTypeLabel', () => {
  it('maps every canonical runs.agent_type value to its display name', () => {
    expect(agentTypeLabel('claude_code')).toBe('Claude Code');
    expect(agentTypeLabel('cursor')).toBe('Cursor');
    expect(agentTypeLabel('windsurf')).toBe('Windsurf');
    expect(agentTypeLabel('codex')).toBe('Codex');
    expect(agentTypeLabel('vscode_copilot')).toBe('VS Code Copilot');
    expect(agentTypeLabel('mcp_inspector')).toBe('MCP Inspector');
  });

  it('renders unknown as "unknown agent" instead of the bare enum value', () => {
    expect(agentTypeLabel('unknown')).toBe('unknown agent');
  });

  it('passes unmapped values through verbatim rather than guessing', () => {
    expect(agentTypeLabel('some_future_agent')).toBe('some_future_agent');
  });
});
