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

describe('AGENT_TYPE_MAPPING table — lock against accidental entry removal', () => {
  it.each(Object.entries(AGENT_TYPE_MAPPING))('maps "%s" → "%s"', (clientName, expectedAgentType) => {
    expect(mapAgentType(clientName)).toBe(expectedAgentType);
  });

  it('is frozen so runtime mutation cannot change the mapping', () => {
    expect(Object.isFrozen(AGENT_TYPE_MAPPING)).toBe(true);
  });
});
