import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_AGENT_TOKENS,
  AGENT_ORDER,
  getAdapter,
  listAdapters,
  resolveAgentInput,
} from '../../../src/lib/agents/registry.js';

/**
 * Locks the AgentAdapter registry contract: canonical ids, the devin/cascade/
 * codeium → windsurf input aliases (ADR: Devin is a display/input alias, the
 * on-disk config + DB agent_type stay `windsurf`), case-insensitivity, and the
 * per-adapter surface identity (id / agentType / display label).
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

  it('resolves `devin` (and cascade/codeium) to the windsurf adapter, flagged as an alias', () => {
    for (const alias of ['devin', 'cascade', 'codeium']) {
      const r = resolveAgentInput(alias);
      expect(r, alias).not.toBeNull();
      expect(r?.id).toBe('windsurf');
      expect(r?.viaAlias).toBe(true);
      expect(r?.adapter.agentType).toBe('windsurf'); // DB attribution stays windsurf
    }
  });

  it('title-cases the alias for display (`devin` → "Devin"), keeps the adapter display for canonical ids', () => {
    expect(resolveAgentInput('devin')?.label).toBe('Devin');
    expect(resolveAgentInput('windsurf')?.label).toBe('Windsurf');
    expect(resolveAgentInput('claude')?.label).toBe('Claude Code');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(resolveAgentInput('  CURSOR ')?.id).toBe('cursor');
    expect(resolveAgentInput('Devin')?.id).toBe('windsurf');
    expect(resolveAgentInput('claude_code')?.id).toBe('claude');
  });

  it('returns null for unknown tokens and empty input', () => {
    expect(resolveAgentInput('bogus')).toBeNull();
    expect(resolveAgentInput('')).toBeNull();
    expect(resolveAgentInput('   ')).toBeNull();
  });
});

describe('agent registry — adapters', () => {
  it('exposes exactly the four adapters in canonical order', () => {
    expect(AGENT_ORDER).toEqual(['claude', 'cursor', 'windsurf', 'codex']);
    expect(listAdapters().map((a) => a.id)).toEqual(['claude', 'cursor', 'windsurf', 'codex']);
  });

  it('each adapter carries the right agentType stamp + detection dir', () => {
    const byId = Object.fromEntries(listAdapters().map((a) => [a.id, a]));
    expect(byId.claude?.agentType).toBe('claude_code');
    expect(byId.cursor?.agentType).toBe('cursor');
    expect(byId.codex?.agentType).toBe('codex');
    expect(byId.windsurf?.agentType).toBe('windsurf');
    expect(byId.claude?.detectionDir).toBe('.claude');
    expect(byId.codex?.detectionDir).toBe('.codex');
    expect(byId.windsurf?.detectionDir).toBe('.windsurf');
  });

  it('windsurf advertises the Devin alias label; codex carries a post-wire note', () => {
    expect(getAdapter('windsurf').aka).toBe('Devin');
    expect(getAdapter('codex').postWireNote).toBeDefined();
    expect(getAdapter('claude').postWireNote).toBeUndefined();
  });

  it('ACCEPTED_AGENT_TOKENS covers the canonical ids and the aliases', () => {
    for (const id of AGENT_ORDER) expect(ACCEPTED_AGENT_TOKENS).toContain(id);
    expect(ACCEPTED_AGENT_TOKENS).toContain('devin');
  });
});
