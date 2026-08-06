import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_AGENT_TOKENS,
  AGENT_ORDER,
  getAdapter,
  listAdapters,
  resolveAgentInput,
} from '../../../src/lib/agents/registry.js';

/**
 * Locks the AgentAdapter registry contract: canonical ids (claude, codex,
 * cursor), the claude_code/claude-code → claude input aliases,
 * case-insensitivity, and the per-adapter surface identity (id / agentType
 * / display label).
 */

describe('agent registry — resolveAgentInput', () => {
  it('resolves each canonical id to its own adapter', () => {
    for (const id of AGENT_ORDER) {
      const r = resolveAgentInput(id);
      expect(r).not.toBeNull();
      expect(r?.id).toBe(id);
      expect(r?.viaAlias).toBe(false);
      expect(r?.adapter.id).toBe(id);
    }
  });

  it('resolves `claude_code` and `claude-code` to the claude adapter, flagged as an alias', () => {
    for (const alias of ['claude_code', 'claude-code']) {
      const r = resolveAgentInput(alias);
      expect(r, alias).not.toBeNull();
      expect(r?.id).toBe('claude');
      expect(r?.viaAlias).toBe(true);
      expect(r?.adapter.agentType).toBe('claude_code');
    }
  });

  it('title-cases the alias for display, keeps the adapter display for canonical ids', () => {
    expect(resolveAgentInput('claude_code')?.label).toBe('Claude_code');
    expect(resolveAgentInput('claude')?.label).toBe('Claude Code');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(resolveAgentInput('  CODEX ')?.id).toBe('codex');
    expect(resolveAgentInput('Claude-Code')?.id).toBe('claude');
  });

  it('returns null for unknown tokens and empty input', () => {
    expect(resolveAgentInput('bogus')).toBeNull();
    expect(resolveAgentInput('')).toBeNull();
    expect(resolveAgentInput('   ')).toBeNull();
  });
});

describe('agent registry — adapters', () => {
  it('exposes exactly the five adapters in canonical order', () => {
    expect(AGENT_ORDER).toEqual(['claude', 'codex', 'cursor', 'devin', 'antigravity']);
    expect(listAdapters().map((a) => a.id)).toEqual(['claude', 'codex', 'cursor', 'devin', 'antigravity']);
  });

  it('each adapter carries the right agentType stamp + detection dir', () => {
    const byId = Object.fromEntries(listAdapters().map((a) => [a.id, a]));
    expect(byId.claude?.agentType).toBe('claude_code');
    expect(byId.codex?.agentType).toBe('codex');
    expect(byId.cursor?.agentType).toBe('cursor');
    expect(byId.devin?.agentType).toBe('devin');
    expect(byId.antigravity?.agentType).toBe('antigravity');
    expect(byId.claude?.detectionDir).toBe('.claude');
    expect(byId.codex?.detectionDir).toBe('.codex');
    expect(byId.cursor?.detectionDir).toBe('.cursor');
    expect(byId.devin?.detectionDir).toBe('.devin');
    expect(byId.antigravity?.detectionDir).toBe(join('.gemini', 'antigravity'));
  });

  it('native plugin adapters carry post-wire notes', () => {
    expect(getAdapter('codex').postWireNote).toContain('Coodra plugin');
    expect(getAdapter('claude').postWireNote).toContain('coodra@coodra');
    expect(getAdapter('cursor').postWireNote).toContain('Customize panel');
    expect(getAdapter('devin').postWireNote).toContain('devin auth login');
    expect(getAdapter('antigravity').postWireNote).toContain('Antigravity discovers local plugins automatically');
  });

  it('ACCEPTED_AGENT_TOKENS covers the canonical ids and the aliases', () => {
    for (const id of AGENT_ORDER) expect(ACCEPTED_AGENT_TOKENS).toContain(id);
    expect(ACCEPTED_AGENT_TOKENS).toContain('claude_code');
  });
});
