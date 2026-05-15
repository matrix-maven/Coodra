import { createDb, type DbHandle, insertKillSwitch, migrateSqlite } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKillSwitchEvaluator } from '../../../src/lib/kill-switch-evaluator.js';

/**
 * Module 08b S2 — kill-switch evaluator unit tests.
 *
 * 8 fixtures locking the cache + match + fail-open contract:
 *
 *   Fixture 1 — empty kill_switches table → null match.
 *   Fixture 2 — global hard switch → deny.
 *   Fixture 3 — global soft switch → allow + reason carries the id.
 *   Fixture 4 — project-scoped switch only matches its target project.
 *   Fixture 5 — tool-scoped switch only matches the named tool.
 *   Fixture 6 — agent_type-scoped switch only matches the named agent.
 *   Fixture 7 — cache hit avoids a re-read; cache miss after TTL re-reads.
 *   Fixture 8 — DB throw → null (fail-open) without caching the failure.
 */

let handle: DbHandle;

beforeEach(() => {
  const opened = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
  if (opened.kind !== 'sqlite') throw new Error('expected sqlite handle');
  handle = opened;
  migrateSqlite(handle.db);
});

afterEach(() => {
  if (handle?.kind === 'sqlite') handle.close();
});

describe('createKillSwitchEvaluator', () => {
  it('Fixture 1 — empty table returns null', async () => {
    const evaluator = createKillSwitchEvaluator({ db: handle });
    const result = await evaluator.check({
      projectId: 'proj_demo',
      toolName: 'Bash',
      agentType: 'claude_code',
    });
    expect(result).toBeNull();
  });

  it('Fixture 2 — global hard switch denies any tool/project/agent combination', async () => {
    const inserted = await insertKillSwitch(handle, {
      scope: 'global',
      target: null,
      reason: 'global pause',
      mode: 'hard',
    });
    const evaluator = createKillSwitchEvaluator({ db: handle });
    const result = await evaluator.check({
      projectId: 'proj_demo',
      toolName: 'Edit',
      agentType: 'claude_code',
    });
    expect(result).not.toBeNull();
    expect(result?.decision).toBe('deny');
    expect(result?.reason).toBe(`kill_switch_paused:${inserted.id}`);
    expect(result?.matched.scope).toBe('global');
    expect(result?.matched.mode).toBe('hard');
  });

  it('Fixture 3 — global soft switch returns allow but carries the kill_switch_paused reason', async () => {
    const inserted = await insertKillSwitch(handle, {
      scope: 'global',
      target: null,
      reason: 'observability-only pause',
      mode: 'soft',
    });
    const evaluator = createKillSwitchEvaluator({ db: handle });
    const result = await evaluator.check({
      projectId: 'proj_demo',
      toolName: 'Bash',
      agentType: 'cursor',
    });
    expect(result?.decision).toBe('allow');
    expect(result?.reason).toBe(`kill_switch_paused:${inserted.id}`);
    expect(result?.matched.mode).toBe('soft');
  });

  it('Fixture 4 — project-scoped switch matches only its own project', async () => {
    await insertKillSwitch(handle, {
      scope: 'project',
      target: 'proj_X',
      reason: 'pause project X',
      mode: 'hard',
    });
    const evaluator = createKillSwitchEvaluator({ db: handle });

    const matchProjectX = await evaluator.check({
      projectId: 'proj_X',
      toolName: 'Bash',
      agentType: 'claude_code',
    });
    expect(matchProjectX?.decision).toBe('deny');
    expect(matchProjectX?.matched.scope).toBe('project');
    expect(matchProjectX?.matched.target).toBe('proj_X');

    const matchProjectY = await evaluator.check({
      projectId: 'proj_Y',
      toolName: 'Bash',
      agentType: 'claude_code',
    });
    expect(matchProjectY).toBeNull();

    const matchNullProject = await evaluator.check({
      projectId: null,
      toolName: 'Bash',
      agentType: 'claude_code',
    });
    expect(matchNullProject).toBeNull();
  });

  it('Fixture 5 — tool-scoped switch matches only the named tool', async () => {
    await insertKillSwitch(handle, {
      scope: 'tool',
      target: 'Bash',
      reason: 'no shell during demo',
      mode: 'hard',
    });
    const evaluator = createKillSwitchEvaluator({ db: handle });

    const bashMatch = await evaluator.check({
      projectId: 'proj_demo',
      toolName: 'Bash',
      agentType: 'claude_code',
    });
    expect(bashMatch?.decision).toBe('deny');

    const editMiss = await evaluator.check({
      projectId: 'proj_demo',
      toolName: 'Edit',
      agentType: 'claude_code',
    });
    expect(editMiss).toBeNull();
  });

  it('Fixture 6 — agent_type-scoped switch matches only the named agent', async () => {
    await insertKillSwitch(handle, {
      scope: 'agent_type',
      target: 'cursor',
      reason: 'block cursor',
      mode: 'soft',
    });
    const evaluator = createKillSwitchEvaluator({ db: handle });

    const cursorMatch = await evaluator.check({
      projectId: 'proj_demo',
      toolName: 'Edit',
      agentType: 'cursor',
    });
    expect(cursorMatch?.decision).toBe('allow');
    expect(cursorMatch?.matched.scope).toBe('agent_type');

    const claudeMiss = await evaluator.check({
      projectId: 'proj_demo',
      toolName: 'Edit',
      agentType: 'claude_code',
    });
    expect(claudeMiss).toBeNull();
  });

  it('Fixture 7 — cache TTL: hit within window does NOT re-read; miss after TTL re-reads', async () => {
    const fakeNow = { value: new Date('2026-05-03T10:00:00Z') };
    const clock = (): Date => fakeNow.value;
    const evaluator = createKillSwitchEvaluator({ db: handle, cacheMs: 5_000, clock });

    // First call: empty table → null. Caches an empty array.
    const r1 = await evaluator.check({
      projectId: 'proj_cached',
      toolName: 'Bash',
      agentType: 'claude_code',
    });
    expect(r1).toBeNull();
    expect(evaluator.cacheSize()).toBe(1);

    // Insert a switch AFTER the cache populated. Within the TTL window
    // the cached "no switches" answer must still apply (the operator
    // accepts up-to-5s staleness for the latency win).
    const _ks = await insertKillSwitch(handle, {
      scope: 'global',
      target: null,
      reason: 'inserted after cache',
      mode: 'hard',
    });

    // Same `now` → cache hit → still null even though the DB has a row.
    const r2 = await evaluator.check({
      projectId: 'proj_cached',
      toolName: 'Bash',
      agentType: 'claude_code',
    });
    expect(r2).toBeNull();

    // Advance the clock past the TTL → cache miss → fresh read picks up the row.
    fakeNow.value = new Date(fakeNow.value.getTime() + 5_001);
    const r3 = await evaluator.check({
      projectId: 'proj_cached',
      toolName: 'Bash',
      agentType: 'claude_code',
    });
    expect(r3?.decision).toBe('deny');
    expect(r3?.matched.id).toBe(_ks.id);
  });

  it('Fixture 8 — DB throw fails open (returns null) and does NOT cache the failure', async () => {
    // Construct an evaluator pointing at a closed handle so the read
    // throws. Each call retries the DB; no cached "fail-open" state.
    handle.close();
    const evaluator = createKillSwitchEvaluator({ db: handle });

    const r1 = await evaluator.check({
      projectId: 'proj_demo',
      toolName: 'Bash',
      agentType: 'claude_code',
    });
    expect(r1).toBeNull();
    // Cache size stays 0 because we don't cache failures.
    expect(evaluator.cacheSize()).toBe(0);

    const r2 = await evaluator.check({
      projectId: 'proj_demo',
      toolName: 'Bash',
      agentType: 'claude_code',
    });
    expect(r2).toBeNull();
    expect(evaluator.cacheSize()).toBe(0);
    // Re-open so afterEach close doesn't double-throw.
    const reopened = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (reopened.kind !== 'sqlite') throw new Error('expected sqlite');
    handle = reopened;
    migrateSqlite(handle.db);
  });

  it('Fixture 9 (bonus) — invalidate(projectId) drops only the matching cache entry', async () => {
    const evaluator = createKillSwitchEvaluator({ db: handle, cacheMs: 60_000 });
    await evaluator.check({ projectId: 'proj_a', toolName: 'Bash', agentType: 'claude_code' });
    await evaluator.check({ projectId: 'proj_b', toolName: 'Bash', agentType: 'claude_code' });
    expect(evaluator.cacheSize()).toBe(2);

    evaluator.invalidate('proj_a');
    expect(evaluator.cacheSize()).toBe(1);

    evaluator.invalidate(); // clears all
    expect(evaluator.cacheSize()).toBe(0);
  });

  it('Fixture 10 (bonus) — null projectId on the event uses the dedicated cache key (does not collide with a real project)', async () => {
    const evaluator = createKillSwitchEvaluator({ db: handle, cacheMs: 60_000 });
    await evaluator.check({ projectId: null, toolName: 'Bash', agentType: 'claude_code' });
    expect(evaluator.cacheSize()).toBe(1);

    await evaluator.check({ projectId: 'proj_alpha', toolName: 'Bash', agentType: 'claude_code' });
    expect(evaluator.cacheSize()).toBe(2);
  });
});
