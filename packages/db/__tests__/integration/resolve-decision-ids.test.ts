import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, decisionIdWarnings, migrateSqlite, resolveDecisionIds, type SqliteHandle } from '../../src/index.js';

/**
 * COOD-91 — `meta.decisionIds` must resolve, or say so.
 *
 * The bug this closes: three packs saved during COOD-77 stored 8-hex
 * PREFIXES (`dec_367d21cf`) rather than full ids
 * (`dec_367d21cf-df81-...`). Every link was dead, the write succeeded,
 * and the only symptom surfaced much later as a pack page unable to say
 * whether nothing had been set or something had been set and lost.
 */

const FULL_A = 'dec_367d21cf-df81-4ee7-b482-ab2e2666b4fa';
const FULL_B = 'dec_5aad93d1-04b1-4004-81f9-51c026684c82';
// Shares the first 8 hex chars with nothing else; used for ambiguity.
const TWIN_1 = 'dec_abcd1234-1111-4111-8111-111111111111';
const TWIN_2 = 'dec_abcd1234-2222-4222-8222-222222222222';

let cwd: string;
let handle: SqliteHandle;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'resolve-dec-ids-'));
  const opened = createDb({ kind: 'local', sqlite: { path: join(cwd, 'data.db') } });
  if (opened.kind !== 'sqlite') throw new Error('expected sqlite');
  handle = opened;
  migrateSqlite(handle.db);

  const insertProject = handle.raw.prepare(`INSERT INTO projects (id, slug, org_id, name, cwd) VALUES (?, ?, ?, ?, ?)`);
  insertProject.run('proj_a', 'proj-a', 'org_dev_local', 'A', cwd);
  insertProject.run('proj_b', 'proj-b', 'org_dev_local', 'B', cwd);

  const insertDecision = handle.raw.prepare(
    `INSERT INTO decisions (id, project_id, idempotency_key, run_id, description, rationale, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertDecision.run(FULL_A, 'proj_a', 'idem_a', null, 'A', 'A', 1000);
  insertDecision.run(FULL_B, 'proj_a', 'idem_b', null, 'B', 'B', 1000);
  insertDecision.run(TWIN_1, 'proj_a', 'idem_t1', null, 'T1', 'T1', 1000);
  insertDecision.run(TWIN_2, 'proj_a', 'idem_t2', null, 'T2', 'T2', 1000);
  // Belongs to a different project — must never resolve for proj_a.
  insertDecision.run('dec_ffffffff-0000-4000-8000-000000000000', 'proj_b', 'idem_other', null, 'X', 'X', 1000);
});

afterAll(() => {
  handle?.close();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('resolveDecisionIds', () => {
  it('maps an exact id to itself', async () => {
    const r = await resolveDecisionIds(handle, 'proj_a', [FULL_A]);
    expect(r.resolved.get(FULL_A)).toBe(FULL_A);
    expect(r.unresolved).toEqual([]);
  });

  it('expands the truncated prefix that caused the original bug', async () => {
    const r = await resolveDecisionIds(handle, 'proj_a', ['dec_367d21cf']);
    expect(r.resolved.get('dec_367d21cf')).toBe(FULL_A);
    expect(r.unresolved).toEqual([]);
  });

  it('refuses to guess when a prefix matches more than one decision', async () => {
    // Binding the pack to whichever row sorted first is precisely the
    // quiet wrongness this function exists to end.
    const r = await resolveDecisionIds(handle, 'proj_a', ['dec_abcd1234']);
    expect(r.ambiguous).toEqual(['dec_abcd1234']);
    expect(r.resolved.has('dec_abcd1234')).toBe(false);
  });

  it('reports an id that matches nothing', async () => {
    const r = await resolveDecisionIds(handle, 'proj_a', ['dec_deadbeef']);
    expect(r.unresolved).toEqual(['dec_deadbeef']);
  });

  it('treats another project’s decision as unresolved, not valid', async () => {
    const r = await resolveDecisionIds(handle, 'proj_a', ['dec_ffffffff-0000-4000-8000-000000000000']);
    expect(r.unresolved).toHaveLength(1);
    expect(r.resolved.size).toBe(0);
  });

  it('does not attempt prefix expansion on non-id junk', async () => {
    const r = await resolveDecisionIds(handle, 'proj_a', ['see the auth decision', 'COOD-77']);
    expect(r.unresolved).toEqual(['see the auth decision', 'COOD-77']);
    expect(r.ambiguous).toEqual([]);
  });

  it('handles a mixed batch without losing any input', async () => {
    const input = [FULL_A, 'dec_5aad93d1', 'dec_deadbeef', 'dec_abcd1234'];
    const r = await resolveDecisionIds(handle, 'proj_a', input);
    expect(r.resolved.get(FULL_A)).toBe(FULL_A);
    expect(r.resolved.get('dec_5aad93d1')).toBe(FULL_B);
    expect(r.unresolved).toEqual(['dec_deadbeef']);
    expect(r.ambiguous).toEqual(['dec_abcd1234']);
    expect(r.resolved.size + r.unresolved.length + r.ambiguous.length).toBe(input.length);
  });

  it('trims and de-duplicates before querying', async () => {
    const r = await resolveDecisionIds(handle, 'proj_a', [`  ${FULL_A}  `, FULL_A, '', '   ']);
    expect(r.resolved.get(FULL_A)).toBe(FULL_A);
    expect(r.resolved.size).toBe(1);
    expect(r.unresolved).toEqual([]);
  });

  it('returns empty for an empty input rather than querying', async () => {
    const r = await resolveDecisionIds(handle, 'proj_a', []);
    expect(r.resolved.size).toBe(0);
    expect(r.unresolved).toEqual([]);
  });
});

describe('decisionIdWarnings', () => {
  it('says nothing when everything resolved', async () => {
    expect(decisionIdWarnings(await resolveDecisionIds(handle, 'proj_a', [FULL_A]))).toEqual([]);
  });

  it('names the offending ids so the warning is actionable', async () => {
    const warnings = decisionIdWarnings(await resolveDecisionIds(handle, 'proj_a', ['dec_deadbeef']));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('dec_deadbeef');
  });

  it('distinguishes ambiguous from unresolved', async () => {
    const warnings = decisionIdWarnings(await resolveDecisionIds(handle, 'proj_a', ['dec_abcd1234']));
    expect(warnings.join(' ')).toMatch(/more than one/);
  });
});
