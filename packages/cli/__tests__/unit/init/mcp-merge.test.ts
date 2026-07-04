import { describe, expect, it } from 'vitest';
import { buildCoodraMcpEntry } from '../../../src/lib/init/mcp-merge.js';

/**
 * Locks the `buildCoodraMcpEntry` env contract — in particular the
 * per-agent `COODRA_AGENT_TYPE` stamp (2026-07-02). The stamp is how a
 * spawned stdio MCP server attributes `runs.agent_type` when the
 * client's initialize `clientInfo.name` is unrecognised (observed:
 * Codex ships 'codex-mcp-client', which landed every Codex run as
 * "unknown" in the web app before this fix).
 */

const BASE = {
  mcpServerBin: '/opt/coodra/runtime/mcp-server/index.js',
  clerkSecretKey: 'sk_test_replace_me',
} as const;

describe('buildCoodraMcpEntry — COODRA_AGENT_TYPE stamp', () => {
  it.each([
    'claude_code',
    'cursor',
    'windsurf',
    'codex',
  ] as const)('stamps COODRA_AGENT_TYPE=%s when agentType is supplied', (agentType) => {
    const entry = buildCoodraMcpEntry({ ...BASE, agentType });
    expect(entry.env?.COODRA_AGENT_TYPE).toBe(agentType);
  });

  it('omits COODRA_AGENT_TYPE when agentType is not supplied', () => {
    const entry = buildCoodraMcpEntry(BASE);
    expect(entry.env?.COODRA_AGENT_TYPE).toBeUndefined();
  });

  it('keeps the baseline env keys alongside the stamp', () => {
    const entry = buildCoodraMcpEntry({ ...BASE, agentType: 'codex' });
    expect(entry.env?.COODRA_LOG_DESTINATION).toBe('stderr');
    expect(entry.env?.CLERK_SECRET_KEY).toBe('sk_test_replace_me');
    expect(entry.command).toBe('node');
    expect(entry.args).toEqual([BASE.mcpServerBin, '--transport', 'stdio']);
  });
});
