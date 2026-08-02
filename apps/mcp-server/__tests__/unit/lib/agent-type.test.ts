import { describe, expect, it } from 'vitest';

import {
  AGENT_TYPE_MAPPING,
  type KnownAgentType,
  mapAgentType,
  resolveAgentType,
} from '../../../src/lib/agent-type.js';

/**
 * Unit tests for `src/lib/agent-type.ts`.
 *
 * Locks the mapping table and the `mapAgentType` resolution contract
 * — every entry in `AGENT_TYPE_MAPPING` has a round-trip test so an
 * accidental deletion fails CI. Deliberately separate from the tool
 * tests so adding new agent clients doesn't churn tool-level tests.
 */

describe('mapAgentType', () => {
  it('returns "unknown" for undefined / null / non-string / empty input', () => {
    expect(mapAgentType(undefined)).toBe<KnownAgentType>('unknown');
    expect(mapAgentType(null)).toBe<KnownAgentType>('unknown');
    expect(mapAgentType(123)).toBe<KnownAgentType>('unknown');
    expect(mapAgentType('')).toBe<KnownAgentType>('unknown');
  });

  it('returns "unknown" for an unmapped client name', () => {
    expect(mapAgentType('totally-new-agent-nobody-has-seen')).toBe<KnownAgentType>('unknown');
  });

  it('maps the observed openai/codex client name codex-mcp-client to codex', () => {
    expect(mapAgentType('codex-mcp-client')).toBe<KnownAgentType>('codex');
  });

  it('falls back to product-name substring heuristics for renamed clients', () => {
    expect(mapAgentType('openai-codex')).toBe<KnownAgentType>('codex');
    expect(mapAgentType('claude-desktop')).toBe<KnownAgentType>('claude_code');
    expect(mapAgentType('copilot-chat')).toBe<KnownAgentType>('vscode_copilot');
  });

  it('maps Claude Code handshake names to claude_code', () => {
    expect(mapAgentType('claude-code')).toBe<KnownAgentType>('claude_code');
    expect(mapAgentType('claude-ai')).toBe<KnownAgentType>('claude_code');
  });

  it('checks codex LAST in the heuristics so composite names bucket to the other product token', () => {
    // 'copilot' still outranks everything, codex included.
    expect(mapAgentType('github-copilot-codex-bridge')).toBe<KnownAgentType>('vscode_copilot');
    // A name with ONLY the codex token still resolves to codex.
    expect(mapAgentType('some-codex-thing')).toBe<KnownAgentType>('codex');
  });

  it('maps Codex handshake names to codex (beta.95)', () => {
    expect(mapAgentType('codex')).toBe<KnownAgentType>('codex');
    expect(mapAgentType('codex-cli')).toBe<KnownAgentType>('codex');
  });

  it('maps VS Code Copilot Chat to vscode_copilot', () => {
    expect(mapAgentType('github-copilot-chat-vscode')).toBe<KnownAgentType>('vscode_copilot');
  });

  it('maps MCP Inspector to mcp_inspector', () => {
    expect(mapAgentType('mcp-inspector')).toBe<KnownAgentType>('mcp_inspector');
  });

  it('is case-insensitive', () => {
    expect(mapAgentType('CLAUDE-CODE')).toBe<KnownAgentType>('claude_code');
  });
});

describe('resolveAgentType — clientInfo first, COODRA_AGENT_TYPE env stamp second', () => {
  it('uses the clientInfo mapping when it resolves, ignoring the env stamp', () => {
    expect(resolveAgentType('claude-code', { COODRA_AGENT_TYPE: 'codex' })).toBe<KnownAgentType>('claude_code');
  });

  it('falls back to a valid env stamp when clientInfo is unmapped or missing', () => {
    expect(resolveAgentType('some-brand-new-client', { COODRA_AGENT_TYPE: 'codex' })).toBe<KnownAgentType>('codex');
    expect(resolveAgentType(undefined, { COODRA_AGENT_TYPE: 'codex' })).toBe<KnownAgentType>('codex');
    // Stamp is trimmed + case-normalised — env files get hand-edited.
    expect(resolveAgentType(undefined, { COODRA_AGENT_TYPE: ' Codex ' })).toBe<KnownAgentType>('codex');
  });

  it('rejects an invalid env stamp and returns unknown', () => {
    expect(resolveAgentType(undefined, { COODRA_AGENT_TYPE: 'not-a-real-agent' })).toBe<KnownAgentType>('unknown');
    expect(resolveAgentType(undefined, {})).toBe<KnownAgentType>('unknown');
  });
});

describe('resolveAgentType — preferEnvStamp (stdio: the coodra-init config stamp beats the handshake)', () => {
  it('lets a valid env stamp win over the clientInfo mapping when preferEnvStamp is true', () => {
    expect(
      resolveAgentType('codex-mcp-client', { COODRA_AGENT_TYPE: 'claude_code' }, { preferEnvStamp: true }),
    ).toBe<KnownAgentType>('claude_code');
  });

  it('keeps clientInfo-first precedence for the same inputs WITHOUT the option (HTTP default unchanged)', () => {
    expect(resolveAgentType('codex-mcp-client', { COODRA_AGENT_TYPE: 'claude_code' })).toBe<KnownAgentType>('codex');
    expect(resolveAgentType('codex-mcp-client', { COODRA_AGENT_TYPE: 'claude_code' }, {})).toBe<KnownAgentType>(
      'codex',
    );
  });

  it('falls back to the clientInfo mapping when the stamp is invalid, even with preferEnvStamp', () => {
    expect(
      resolveAgentType('codex-mcp-client', { COODRA_AGENT_TYPE: 'not-a-type' }, { preferEnvStamp: true }),
    ).toBe<KnownAgentType>('codex');
  });

  it('resolves a stamp-only setup (unknown clientName) in both modes', () => {
    expect(
      resolveAgentType('never-seen-client', { COODRA_AGENT_TYPE: 'claude_code' }, { preferEnvStamp: true }),
    ).toBe<KnownAgentType>('claude_code');
    expect(resolveAgentType('never-seen-client', { COODRA_AGENT_TYPE: 'claude_code' })).toBe<KnownAgentType>(
      'claude_code',
    );
  });

  it('trims + lowercases the stamp before matching (env files get hand-edited)', () => {
    expect(
      resolveAgentType('codex-mcp-client', { COODRA_AGENT_TYPE: '  Claude_Code ' }, { preferEnvStamp: true }),
    ).toBe<KnownAgentType>('claude_code');
  });
});

describe('AGENT_TYPE_MAPPING table — lock against accidental entry removal', () => {
  it.each(Object.entries(AGENT_TYPE_MAPPING))('maps "%s" → "%s"', (clientName, expectedAgentType) => {
    expect(mapAgentType(clientName)).toBe(expectedAgentType);
  });

  it('is frozen so runtime mutation cannot change the mapping', () => {
    expect(Object.isFrozen(AGENT_TYPE_MAPPING)).toBe(true);
  });
});
