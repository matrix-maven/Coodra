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
    expect(mapAgentType('cursor-agent-2')).toBe<KnownAgentType>('cursor');
    expect(mapAgentType('windsurf-editor')).toBe<KnownAgentType>('windsurf');
    expect(mapAgentType('copilot-chat')).toBe<KnownAgentType>('vscode_copilot');
    // 'copilot' outranks the other substrings so a combined product name
    // like GitHub's never mis-buckets.
    expect(mapAgentType('github-copilot-cursor-bridge')).toBe<KnownAgentType>('vscode_copilot');
  });

  it('maps Claude Code handshake names to claude_code', () => {
    expect(mapAgentType('claude-code')).toBe<KnownAgentType>('claude_code');
    expect(mapAgentType('claude-ai')).toBe<KnownAgentType>('claude_code');
  });

  it('maps Cursor handshake names to cursor', () => {
    expect(mapAgentType('cursor')).toBe<KnownAgentType>('cursor');
    expect(mapAgentType('cursor-vscode')).toBe<KnownAgentType>('cursor');
  });

  it('maps Windsurf to windsurf', () => {
    expect(mapAgentType('windsurf')).toBe<KnownAgentType>('windsurf');
  });

  it('maps the Windsurf brand family (codeium / cascade / devin) to windsurf', () => {
    expect(mapAgentType('codeium')).toBe<KnownAgentType>('windsurf');
    expect(mapAgentType('cascade')).toBe<KnownAgentType>('windsurf');
    expect(mapAgentType('devin')).toBe<KnownAgentType>('windsurf');
    // Case-insensitive like every other entry.
    expect(mapAgentType('Devin')).toBe<KnownAgentType>('windsurf');
    expect(mapAgentType('CODEIUM')).toBe<KnownAgentType>('windsurf');
    expect(mapAgentType('Cascade')).toBe<KnownAgentType>('windsurf');
  });

  it('checks codex LAST in the heuristics so composite names bucket to the other product token', () => {
    // Field report 2026-07-12: Windsurf runs were mislabeled codex.
    expect(mapAgentType('windsurf-codex-bridge')).toBe<KnownAgentType>('windsurf');
    expect(mapAgentType('codeium-codex-shim')).toBe<KnownAgentType>('windsurf');
    expect(mapAgentType('cascade-codex')).toBe<KnownAgentType>('windsurf');
    expect(mapAgentType('devin-codex-agent')).toBe<KnownAgentType>('windsurf');
    expect(mapAgentType('my-cursor-codex')).toBe<KnownAgentType>('cursor');
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
    expect(mapAgentType('Cursor')).toBe<KnownAgentType>('cursor');
    expect(mapAgentType('Windsurf')).toBe<KnownAgentType>('windsurf');
  });
});

describe('resolveAgentType — clientInfo first, COODRA_AGENT_TYPE env stamp second', () => {
  it('uses the clientInfo mapping when it resolves, ignoring the env stamp', () => {
    expect(resolveAgentType('claude-code', { COODRA_AGENT_TYPE: 'codex' })).toBe<KnownAgentType>('claude_code');
  });

  it('falls back to a valid env stamp when clientInfo is unmapped or missing', () => {
    expect(resolveAgentType('some-brand-new-client', { COODRA_AGENT_TYPE: 'codex' })).toBe<KnownAgentType>('codex');
    expect(resolveAgentType(undefined, { COODRA_AGENT_TYPE: 'windsurf' })).toBe<KnownAgentType>('windsurf');
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
    // Field report 2026-07-12: Windsurf launched from its own stamped
    // config entry but shipped a codex-flavored clientInfo name.
    expect(
      resolveAgentType('codex-mcp-client', { COODRA_AGENT_TYPE: 'windsurf' }, { preferEnvStamp: true }),
    ).toBe<KnownAgentType>('windsurf');
  });

  it('keeps clientInfo-first precedence for the same inputs WITHOUT the option (HTTP default unchanged)', () => {
    expect(resolveAgentType('codex-mcp-client', { COODRA_AGENT_TYPE: 'windsurf' })).toBe<KnownAgentType>('codex');
    expect(resolveAgentType('codex-mcp-client', { COODRA_AGENT_TYPE: 'windsurf' }, {})).toBe<KnownAgentType>('codex');
  });

  it('falls back to the clientInfo mapping when the stamp is invalid, even with preferEnvStamp', () => {
    expect(
      resolveAgentType('codex-mcp-client', { COODRA_AGENT_TYPE: 'not-a-type' }, { preferEnvStamp: true }),
    ).toBe<KnownAgentType>('codex');
  });

  it('resolves a stamp-only setup (unknown clientName) in both modes', () => {
    expect(
      resolveAgentType('never-seen-client', { COODRA_AGENT_TYPE: 'windsurf' }, { preferEnvStamp: true }),
    ).toBe<KnownAgentType>('windsurf');
    expect(resolveAgentType('never-seen-client', { COODRA_AGENT_TYPE: 'windsurf' })).toBe<KnownAgentType>('windsurf');
  });

  it('trims + lowercases the stamp before matching (env files get hand-edited)', () => {
    expect(
      resolveAgentType('codex-mcp-client', { COODRA_AGENT_TYPE: '  Windsurf ' }, { preferEnvStamp: true }),
    ).toBe<KnownAgentType>('windsurf');
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
