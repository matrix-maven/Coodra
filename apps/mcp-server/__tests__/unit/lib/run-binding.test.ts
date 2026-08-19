import { describe, expect, it } from 'vitest';

import { createRunBindingRegistry } from '../../../src/lib/run-binding.js';

/**
 * The binding is what makes pull attribution possible at all on stdio,
 * so the tests that matter most are the ones about what must NOT bind.
 * A wrong binding is worse than no binding: it produces cohort rows
 * indistinguishable from correct ones, making pull-through quietly
 * false rather than visibly empty.
 */

const RUN = 'run:proj-1:agent-sess-1:uuid-1';

describe('run binding — attribution sources', () => {
  it('binds from get_run_id output', () => {
    const reg = createRunBindingRegistry();
    reg.observe({
      sessionId: 'stdio-abc',
      toolName: 'get_run_id',
      input: { projectSlug: 'p' },
      output: { ok: true, runId: RUN },
    });
    expect(reg.resolve('stdio-abc')).toBe(RUN);
  });

  it('binds from record_decision input', () => {
    const reg = createRunBindingRegistry();
    reg.observe({
      sessionId: 'stdio-abc',
      toolName: 'record_decision',
      input: { runId: RUN, description: 'd', rationale: 'r' },
      output: { ok: true, decisionId: 'dec_1' },
    });
    expect(reg.resolve('stdio-abc')).toBe(RUN);
  });

  it('binds from save_context_pack input', () => {
    const reg = createRunBindingRegistry();
    reg.observe({
      sessionId: 'stdio-abc',
      toolName: 'save_context_pack',
      input: { runId: RUN, title: 't', content: 'c' },
      output: { contextPackId: 'cp_1' },
    });
    expect(reg.resolve('stdio-abc')).toBe(RUN);
  });

  it('keeps sessions independent', () => {
    const reg = createRunBindingRegistry();
    const other = 'run:proj-1:agent-sess-2:uuid-2';
    reg.observe({ sessionId: 'stdio-a', toolName: 'get_run_id', input: {}, output: { ok: true, runId: RUN } });
    reg.observe({ sessionId: 'stdio-b', toolName: 'get_run_id', input: {}, output: { ok: true, runId: other } });
    expect(reg.resolve('stdio-a')).toBe(RUN);
    expect(reg.resolve('stdio-b')).toBe(other);
  });
});

describe('run binding — what must never bind', () => {
  it('ignores query_decisions, where runId is a retrieval filter', () => {
    const reg = createRunBindingRegistry();
    // An agent searching ANOTHER run's decisions. Binding here would
    // misattribute every later pull in this session to that run.
    reg.observe({
      sessionId: 'stdio-abc',
      toolName: 'query_decisions',
      input: { projectSlug: 'p', query: 'q', runId: 'run:proj-1:someone-else:uuid-9' },
      output: { decisions: [] },
    });
    expect(reg.resolve('stdio-abc')).toBeNull();
  });

  it.each([
    'query_run_history',
    'query_run_diff',
    'read_context_pack',
    'work_pack_status',
  ])('ignores %s', (toolName) => {
    const reg = createRunBindingRegistry();
    reg.observe({ sessionId: 'stdio-abc', toolName, input: { runId: RUN }, output: { ok: true } });
    expect(reg.resolve('stdio-abc')).toBeNull();
  });

  it('ignores a failed call, so a fabricated run id cannot bind', () => {
    const reg = createRunBindingRegistry();
    reg.observe({
      sessionId: 'stdio-abc',
      toolName: 'record_decision',
      input: { runId: 'run:proj-1:made-up:uuid-x', description: 'd', rationale: 'r' },
      output: { ok: false, error: 'run_not_found' },
    });
    expect(reg.resolve('stdio-abc')).toBeNull();
  });

  it('ignores a missing or empty runId', () => {
    const reg = createRunBindingRegistry();
    reg.observe({ sessionId: 'stdio-a', toolName: 'get_run_id', input: {}, output: { ok: true } });
    reg.observe({ sessionId: 'stdio-b', toolName: 'get_run_id', input: {}, output: { ok: true, runId: '' } });
    expect(reg.resolve('stdio-a')).toBeNull();
    expect(reg.resolve('stdio-b')).toBeNull();
  });

  it('resolves to null for a session that never bound', () => {
    expect(createRunBindingRegistry().resolve('stdio-never-seen')).toBeNull();
  });
});

describe('run binding — lifecycle', () => {
  it('rebinds when the agent asserts a different run', () => {
    const reg = createRunBindingRegistry();
    const second = 'run:proj-2:agent-sess-1:uuid-2';
    reg.observe({ sessionId: 'stdio-abc', toolName: 'get_run_id', input: {}, output: { ok: true, runId: RUN } });
    reg.observe({ sessionId: 'stdio-abc', toolName: 'get_run_id', input: {}, output: { ok: true, runId: second } });
    expect(reg.resolve('stdio-abc')).toBe(second);
    expect(reg.size()).toBe(1);
  });

  it('bounds its memory so a long-lived HTTP daemon does not leak', () => {
    const reg = createRunBindingRegistry();
    for (let i = 0; i < 600; i += 1) {
      reg.observe({
        sessionId: `http-${i}`,
        toolName: 'get_run_id',
        input: {},
        output: { ok: true, runId: `run:p:s${i}:u` },
      });
    }
    expect(reg.size()).toBe(512);
    // Oldest evicted, newest retained.
    expect(reg.resolve('http-0')).toBeNull();
    expect(reg.resolve('http-599')).toBe('run:p:s599:u');
  });

  it('re-asserting keeps an active session from being evicted', () => {
    const reg = createRunBindingRegistry();
    reg.observe({ sessionId: 'http-keep', toolName: 'get_run_id', input: {}, output: { ok: true, runId: RUN } });
    for (let i = 0; i < 400; i += 1) {
      reg.observe({
        sessionId: `http-${i}`,
        toolName: 'get_run_id',
        input: {},
        output: { ok: true, runId: `run:p:s${i}:u` },
      });
    }
    // Touched again after the flood, so it moves to the newest slot.
    reg.observe({ sessionId: 'http-keep', toolName: 'get_run_id', input: {}, output: { ok: true, runId: RUN } });
    for (let i = 400; i < 900; i += 1) {
      reg.observe({
        sessionId: `http-${i}`,
        toolName: 'get_run_id',
        input: {},
        output: { ok: true, runId: `run:p:s${i}:u` },
      });
    }
    expect(reg.resolve('http-keep')).toBe(RUN);
  });
});
