import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createDb,
  type DbHandle,
  findKillSwitchMatchingEvent,
  insertKillSwitch,
  listActiveKillSwitches,
  migrateSqlite,
  softResumeAllKillSwitches,
  softResumeKillSwitch,
} from '../../src/index.js';

/**
 * Locks the M08b S1 kill_switches table contract:
 *
 *   - Insert returns the canonical KillSwitchRecord shape with the
 *     OQ-1 default mode='hard' applied when --mode is omitted.
 *   - Polymorphic (scope, target) shape per OQ-2: scope='global' has
 *     null target; scope='project|tool|agent_type' has a non-null target.
 *   - listActiveKillSwitches narrows by projectId at the SQL layer
 *     (project-scoped switches whose target ≠ projectId stay out of
 *     the result set; global/tool/agent_type rows always come back).
 *   - findKillSwitchMatchingEvent narrows in-memory: matches global,
 *     matches project=projectId, matches tool=toolName, matches
 *     agent_type=agentType.
 *   - expires_at in the past is treated as already-resumed by
 *     listActiveKillSwitches (no maintenance job needed).
 *   - softResumeKillSwitch sets resumed_at + resumed_by_session_id;
 *     row stays in the table as audit history (soft delete).
 *   - softResumeAllKillSwitches with no filter resumes everything
 *     active; with --scope/--target it filters.
 *
 * Hot-path performance is verified at the bridge layer (S2 integration
 * tests) — this suite focuses on the helper contract.
 */

let cwd: string;
let handle: DbHandle;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'kill-switches-test-'));
  const opened = createDb({ kind: 'local', sqlite: { path: join(cwd, 'data.db') } });
  if (opened.kind !== 'sqlite') throw new Error('expected sqlite handle');
  handle = opened;
  migrateSqlite(handle.db);
});

afterAll(() => {
  if (handle?.kind === 'sqlite') handle.close();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

beforeEach(async () => {
  // Each test starts from a clean kill_switches table so fixtures don't
  // bleed across tests. The other tables (projects, runs, etc.) stay
  // empty for this suite — we never join.
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  handle.raw.exec('DELETE FROM kill_switches');
});

describe('@coodra/db::kill_switches helpers', () => {
  it('Fixture 1 — insertKillSwitch returns the row with default mode=hard and scope=global has null target', async () => {
    const row = await insertKillSwitch(handle, { scope: 'global', target: null, reason: 'demo pause' });
    expect(row.id).toMatch(/^ks_[0-9a-f]{32}$/);
    expect(row.scope).toBe('global');
    expect(row.target).toBeNull();
    expect(row.mode).toBe('hard');
    expect(row.reason).toBe('demo pause');
    expect(row.pausedAt).toBeInstanceOf(Date);
    expect(row.expiresAt).toBeNull();
    expect(row.resumedAt).toBeNull();
    expect(row.resumedBySessionId).toBeNull();

    // listActiveKillSwitches with null projectId returns the global row
    // (and would skip any project-scoped rows).
    const active = await listActiveKillSwitches(handle, null);
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(row.id);
  });

  it('Fixture 2 — insert two switches at different scopes, list returns both for matching projectId', async () => {
    const projectId = 'proj_alpha';
    const otherProjectId = 'proj_beta';

    const globalSwitch = await insertKillSwitch(handle, {
      scope: 'global',
      target: null,
      reason: 'global pause',
      mode: 'hard',
    });
    const projectSwitch = await insertKillSwitch(handle, {
      scope: 'project',
      target: projectId,
      reason: 'project alpha pause',
      mode: 'soft',
    });
    // A project-scoped switch on a DIFFERENT project should be filtered out
    // by listActiveKillSwitches when called with projectId='proj_alpha'.
    const otherProjectSwitch = await insertKillSwitch(handle, {
      scope: 'project',
      target: otherProjectId,
      reason: 'project beta pause',
    });
    const toolSwitch = await insertKillSwitch(handle, {
      scope: 'tool',
      target: 'Bash',
      reason: 'no shell during demo',
    });

    const activeForAlpha = await listActiveKillSwitches(handle, projectId);
    const activeIds = activeForAlpha.map((r) => r.id).sort();
    // Should include global, project=alpha, tool=Bash. Should NOT include project=beta.
    expect(activeIds).toEqual([globalSwitch.id, projectSwitch.id, toolSwitch.id].sort());
    expect(activeIds).not.toContain(otherProjectSwitch.id);

    // With null projectId we drop project-scoped rows entirely.
    const activeForNullProject = await listActiveKillSwitches(handle, null);
    const nullProjectIds = activeForNullProject.map((r) => r.id).sort();
    expect(nullProjectIds).toEqual([globalSwitch.id, toolSwitch.id].sort());
  });

  it('Fixture 3 — findKillSwitchMatchingEvent: scope=global matches every event', async () => {
    const row = await insertKillSwitch(handle, { scope: 'global', target: null, reason: 'global stop' });
    const switches = await listActiveKillSwitches(handle, 'any_project');
    const matched = findKillSwitchMatchingEvent(switches, {
      projectId: 'any_project',
      toolName: 'Edit',
      agentType: 'claude_code',
    });
    expect(matched?.id).toBe(row.id);

    // Even with no projectId on the event:
    const matchedNoProject = findKillSwitchMatchingEvent(switches, {
      toolName: 'Read',
      agentType: 'cursor',
    });
    expect(matchedNoProject?.id).toBe(row.id);
  });

  it('Fixture 4 — findKillSwitchMatchingEvent: scope=project matches only its target projectId', async () => {
    const row = await insertKillSwitch(handle, { scope: 'project', target: 'proj_X', reason: 'pause project X' });
    const switches = await listActiveKillSwitches(handle, 'proj_X');
    expect(switches).toHaveLength(1);

    const matched = findKillSwitchMatchingEvent(switches, {
      projectId: 'proj_X',
      toolName: 'Bash',
      agentType: 'claude_code',
    });
    expect(matched?.id).toBe(row.id);

    // Different projectId on the event AND in the lookup → no match (the
    // SQL filter dropped the row before the in-memory matcher saw it).
    const otherSwitches = await listActiveKillSwitches(handle, 'proj_Y');
    expect(otherSwitches).toHaveLength(0);
    expect(
      findKillSwitchMatchingEvent(otherSwitches, {
        projectId: 'proj_Y',
        toolName: 'Bash',
        agentType: 'claude_code',
      }),
    ).toBeNull();
  });

  it('Fixture 5 — findKillSwitchMatchingEvent: scope=tool matches only the named tool, scope=agent_type matches only the named agent', async () => {
    const bashSwitch = await insertKillSwitch(handle, { scope: 'tool', target: 'Bash', reason: 'no bash' });
    const cursorSwitch = await insertKillSwitch(handle, {
      scope: 'agent_type',
      target: 'cursor',
      reason: 'block cursor',
    });
    const switches = await listActiveKillSwitches(handle, 'proj_demo');

    // Bash event from claude_code → matches the bash switch.
    expect(
      findKillSwitchMatchingEvent(switches, {
        projectId: 'proj_demo',
        toolName: 'Bash',
        agentType: 'claude_code',
      })?.id,
    ).toBe(bashSwitch.id);

    // Edit event from cursor → matches the agent_type switch.
    expect(
      findKillSwitchMatchingEvent(switches, {
        projectId: 'proj_demo',
        toolName: 'Edit',
        agentType: 'cursor',
      })?.id,
    ).toBe(cursorSwitch.id);

    // Edit event from claude_code → matches NOTHING (no global, no project,
    // tool=Edit ≠ Bash, agent_type=claude_code ≠ cursor).
    expect(
      findKillSwitchMatchingEvent(switches, {
        projectId: 'proj_demo',
        toolName: 'Edit',
        agentType: 'claude_code',
      }),
    ).toBeNull();
  });

  it('Fixture 6 — expires_at in the past is treated as resumed by listActiveKillSwitches', async () => {
    const past = new Date(Date.now() - 60_000); // 1 minute ago
    const future = new Date(Date.now() + 60_000); // 1 minute from now

    const expiredRow = await insertKillSwitch(handle, {
      scope: 'global',
      target: null,
      reason: 'expired pause',
      expiresAt: past,
    });
    const liveRow = await insertKillSwitch(handle, {
      scope: 'global',
      target: null,
      reason: 'live pause',
      expiresAt: future,
    });

    const active = await listActiveKillSwitches(handle, null);
    const activeIds = active.map((r) => r.id);
    expect(activeIds).not.toContain(expiredRow.id);
    expect(activeIds).toContain(liveRow.id);

    // Asserting we can drive the clock from the test for deterministic
    // expiry behaviour (the bridge passes a clock for cache-TTL coordination).
    const futureFromOurPerspective = new Date(future.getTime() + 1_000); // 1s past liveRow.expiresAt
    const noneActive = await listActiveKillSwitches(handle, null, { now: futureFromOurPerspective });
    expect(noneActive.map((r) => r.id)).not.toContain(liveRow.id);
  });

  it('Fixture 7 — softResumeKillSwitch + softResumeAllKillSwitches preserve audit history', async () => {
    const ks1 = await insertKillSwitch(handle, { scope: 'global', target: null, reason: 'r1' });
    const ks2 = await insertKillSwitch(handle, { scope: 'tool', target: 'Bash', reason: 'r2' });
    const ks3 = await insertKillSwitch(handle, { scope: 'tool', target: 'Edit', reason: 'r3' });

    // Resume ks1 by id.
    const resumed1 = await softResumeKillSwitch(handle, { id: ks1.id, resumedBySessionId: 'sess_abc' });
    expect(resumed1).not.toBeNull();
    expect(resumed1?.resumedAt).toBeInstanceOf(Date);
    expect(resumed1?.resumedBySessionId).toBe('sess_abc');

    // Re-resuming ks1 is a no-op → returns null.
    const resumed1Again = await softResumeKillSwitch(handle, { id: ks1.id });
    expect(resumed1Again).toBeNull();

    // listActiveKillSwitches no longer surfaces ks1 (resumed_at is set)
    // but ks2 and ks3 are still active.
    const active = await listActiveKillSwitches(handle, 'proj_demo');
    const activeIds = active.map((r) => r.id);
    expect(activeIds).not.toContain(ks1.id);
    expect(activeIds).toEqual(expect.arrayContaining([ks2.id, ks3.id]));

    // Bulk resume all tool-scoped active switches.
    const bulk = await softResumeAllKillSwitches(handle, { scope: 'tool' });
    expect(bulk.map((r) => r.id).sort()).toEqual([ks2.id, ks3.id].sort());

    // After bulk resume, listActiveKillSwitches is empty.
    const stillActive = await listActiveKillSwitches(handle, 'proj_demo');
    expect(stillActive).toHaveLength(0);

    // Audit history: all three rows are still in the table even though
    // none are active. Verified via raw SQL since the helpers filter
    // resumed rows out.
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
    const allRows = handle.raw.prepare('SELECT id, resumed_at FROM kill_switches ORDER BY paused_at').all() as {
      id: string;
      resumed_at: number | null;
    }[];
    expect(allRows.map((r) => r.id)).toEqual([ks1.id, ks2.id, ks3.id]);
    expect(allRows.every((r) => r.resumed_at !== null)).toBe(true);
  });

  it('Fixture 8 (bonus) — insertKillSwitch validates polymorphic invariants', async () => {
    // scope='global' with a non-null target should throw.
    await expect(
      insertKillSwitch(handle, { scope: 'global', target: 'something', reason: 'mismatch' }),
    ).rejects.toThrow(/scope='global' requires target=null/);

    // scope='project' with a null target should throw.
    await expect(insertKillSwitch(handle, { scope: 'project', target: null, reason: 'mismatch' })).rejects.toThrow(
      /scope='project' requires a non-empty target/,
    );

    // Empty reason should throw — operator audit context is mandatory.
    await expect(insertKillSwitch(handle, { scope: 'global', target: null, reason: '' })).rejects.toThrow(
      /reason must be a non-empty string/,
    );

    // Invalid scope should throw.
    await expect(
      // @ts-expect-error — runtime test of the assertion
      insertKillSwitch(handle, { scope: 'org', target: 'oc_1', reason: 'bad scope' }),
    ).rejects.toThrow(/invalid scope 'org'/);
  });

  it('Fixture 9 (bonus) — listActiveKillSwitches returns rows ordered by paused_at ASC', async () => {
    const t0 = Date.now();
    const ks1 = await insertKillSwitch(handle, { scope: 'tool', target: 'Bash', reason: 'first' });
    // Force monotonic ordering by sleeping ~10ms so the unixepoch second
    // resolution doesn't collapse our inserts to the same timestamp.
    // (better-sqlite3 + unixepoch() is second-resolution; we need to
    // assert that even when ties occur, the helper returns SOMETHING
    // deterministic — the SQL ORDER BY doesn't fall back on rowid here.)
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const ks2 = await insertKillSwitch(handle, { scope: 'tool', target: 'Edit', reason: 'second' });

    const active = await listActiveKillSwitches(handle, null);
    expect(active).toHaveLength(2);
    expect(active[0]?.id).toBe(ks1.id);
    expect(active[1]?.id).toBe(ks2.id);
    expect(active[0]?.pausedAt.getTime()).toBeLessThan(active[1]?.pausedAt.getTime() ?? 0);
    expect(active[0]?.pausedAt.getTime()).toBeGreaterThanOrEqual(Math.floor(t0 / 1000) * 1000);
  });
});
