import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createGetRunIdToolRegistration } from '../../../src/tools/get-run-id/manifest.js';
import type { GetRunIdOutput } from '../../../src/tools/get-run-id/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration test for `coodra__get_run_id` (S8; registration guard COOD-63).
 *
 * Exercises the real handler end-to-end via the `ToolRegistry` — the
 * same dispatch path the stdio transport uses — against an in-memory
 * SQLite handle with migrations applied.
 *
 * Covers:
 *   - Solo mode: an unverified/unknown slug is gated — `project_not_registered`
 *     unless the caller proves legitimacy via `cwd` matching a real
 *     `.coodra/config.json`, or explicit `cwd` + `confirmRegister: true`
 *     (field report 2026-08-13 — the old unconditional auto-create let an
 *     agent record durable decisions against a directory nobody ever
 *     registered). Once verified, `projects.cwd` is set and the same
 *     slug never re-prompts.
 *   - Team mode: unchanged — structured `project_not_found` soft-failure
 *     when slug unknown (no projects row inserted, no guard needed here
 *     since there is no auto-create path to gate).
 *   - Existing in-progress run: returns the cached runId.
 *   - Existing terminal run (completed/cancelled/...): returns the same
 *     runId AND resumes it — flips `status` back to `in_progress` and
 *     clears `ended_at`.
 *   - Concurrent inserts: Promise.all of two calls with the same
 *     (projectSlug, sessionId) returns the same runId on both
 *     (ON CONFLICT race resolution).
 *   - Idempotent re-call on the same (projectSlug, sessionId)
 *     returns the same runId.
 *
 * All responses are parsed through the registry envelope: success
 * looks like `{ ok: true, data: { ok: true, runId, startedAt } }`;
 * soft-failure looks like `{ ok: true, data: { ok: false, error,
 * howToFix } }`. The registry's `ok: true` wraps transport success;
 * the inner `data.ok` is the domain success/failure signal.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
}

async function openHarness(): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    // vec extension must load so migration 0001 creates context_packs_vec.
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);
  return {
    close: async () => {
      await client.close();
    },
    handle,
  };
}

function buildRegistry(handle: SqliteHandle, mode: 'solo' | 'team'): ToolRegistry {
  const registry = new ToolRegistry({ deps: makeFakeDeps() });
  registry.register(createGetRunIdToolRegistration({ db: handle, mode }));
  return registry;
}

function unwrap(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): GetRunIdOutput {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: GetRunIdOutput };
  if (!parsed.ok || !parsed.data) {
    throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  }
  return parsed.data;
}

/** A fake absolute path — fine for `confirmRegister` calls, which never touch disk. */
function fakeCwd(label: string): string {
  return `/tmp/coodra-get-run-id-test/${label}`;
}

async function writeRealProjectConfig(projectSlug: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'coodra-get-run-id-'));
  await mkdir(join(cwd, '.coodra'), { recursive: true });
  await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ projectSlug }), 'utf8');
  return cwd;
}

// ---------------------------------------------------------------------------
// Solo mode — the registration guard itself (COOD-63)
// ---------------------------------------------------------------------------

describe('get_run_id — solo mode registration guard', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns project_not_registered for an unknown slug with no cwd and no confirmRegister', async () => {
    const registry = buildRegistry(h.handle, 'solo');
    const out = unwrap(await registry.handleCall('get_run_id', { projectSlug: 'never-initialized' }, 'sess_gate'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('project_not_registered');
    expect(out.howToFix.length).toBeGreaterThan(0);
    const projects = await h.handle.db
      .select()
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, 'never-initialized'));
    expect(projects).toHaveLength(0);
  });

  it('returns project_not_registered when confirmRegister is true but cwd is missing (no silent permanent-nag row)', async () => {
    const registry = buildRegistry(h.handle, 'solo');
    const out = unwrap(
      await registry.handleCall(
        'get_run_id',
        { projectSlug: 'confirm-without-cwd', confirmRegister: true },
        'sess_gate2',
      ),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('project_not_registered');
    const projects = await h.handle.db
      .select()
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, 'confirm-without-cwd'));
    expect(projects).toHaveLength(0);
  });

  it('registers automatically when cwd resolves a real .coodra/config.json matching projectSlug — no confirmRegister needed', async () => {
    const cwd = await writeRealProjectConfig('real-init-project');
    const registry = buildRegistry(h.handle, 'solo');
    const out = unwrap(await registry.handleCall('get_run_id', { projectSlug: 'real-init-project', cwd }, 'sess_real'));
    expect(out.ok).toBe(true);
    const projects = await h.handle.db
      .select()
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, 'real-init-project'));
    expect(projects).toHaveLength(1);
    expect(projects[0]?.cwd).toBe(cwd);
  });

  it('does not register when cwd points at a .coodra/config.json for a DIFFERENT slug', async () => {
    const cwd = await writeRealProjectConfig('actual-slug');
    const registry = buildRegistry(h.handle, 'solo');
    const out = unwrap(await registry.handleCall('get_run_id', { projectSlug: 'guessed-slug', cwd }, 'sess_mismatch'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('project_not_registered');
  });

  it('registers with cwd + confirmRegister: true when no .coodra/config.json exists (the user-consented path)', async () => {
    const cwd = fakeCwd('consented-project');
    const registry = buildRegistry(h.handle, 'solo');
    const out = unwrap(
      await registry.handleCall(
        'get_run_id',
        { projectSlug: 'consented-project', cwd, confirmRegister: true },
        'sess_consent',
      ),
    );
    expect(out.ok).toBe(true);
    const projects = await h.handle.db
      .select()
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, 'consented-project'));
    expect(projects).toHaveLength(1);
    expect(projects[0]?.cwd).toBe(cwd);
  });

  it('never re-prompts once a project is registered — a later call with no cwd/confirmRegister succeeds', async () => {
    const cwd = fakeCwd('no-nag-project');
    const registry = buildRegistry(h.handle, 'solo');
    const first = unwrap(
      await registry.handleCall(
        'get_run_id',
        { projectSlug: 'no-nag-project', cwd, confirmRegister: true },
        'sess_first',
      ),
    );
    expect(first.ok).toBe(true);

    // A different session, same slug, no cwd/confirmRegister this time.
    const second = unwrap(await registry.handleCall('get_run_id', { projectSlug: 'no-nag-project' }, 'sess_second'));
    expect(second.ok).toBe(true);
  });

  it('gates a pre-existing row with cwd still null (a phantom from before this guard existed) until verified/confirmed, then backfills cwd', async () => {
    // Simulate a row created by the old unconditional auto-create: present
    // in the DB, cwd never set.
    await h.handle.db.insert(sqliteSchema.projects).values({
      id: 'proj_phantom_legacy',
      slug: 'phantom-legacy-project',
      orgId: 'org_dev_local',
      name: 'phantom-legacy-project',
    });

    const registry = buildRegistry(h.handle, 'solo');
    const blocked = unwrap(
      await registry.handleCall('get_run_id', { projectSlug: 'phantom-legacy-project' }, 'sess_phantom_1'),
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toBe('project_not_registered');

    const cwd = fakeCwd('phantom-legacy-project');
    const confirmed = unwrap(
      await registry.handleCall(
        'get_run_id',
        { projectSlug: 'phantom-legacy-project', cwd, confirmRegister: true },
        'sess_phantom_2',
      ),
    );
    expect(confirmed.ok).toBe(true);

    const projects = await h.handle.db
      .select()
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, 'phantom-legacy-project'));
    expect(projects).toHaveLength(1);
    expect(projects[0]?.id).toBe('proj_phantom_legacy'); // same row, backfilled — not a duplicate
    expect(projects[0]?.cwd).toBe(cwd);

    // And now it never re-prompts either.
    const third = unwrap(
      await registry.handleCall('get_run_id', { projectSlug: 'phantom-legacy-project' }, 'sess_phantom_3'),
    );
    expect(third.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Solo mode — successful creation via confirmRegister (project + runs + policy)
// ---------------------------------------------------------------------------

describe('get_run_id — solo mode registers via confirmRegister + creates the runs row', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('creates a projects row + a runs row on first call for an unknown slug', async () => {
    const registry = buildRegistry(h.handle, 'solo');
    const result = await registry.handleCall(
      'get_run_id',
      { projectSlug: 'my-fresh-project', cwd: fakeCwd('my-fresh-project'), confirmRegister: true },
      'sess_1',
      { agentType: 'claude_code' },
    );
    const out = unwrap(result);
    expect(out.ok).toBe(true);
    if (out.ok) {
      // projectId no longer carries a `proj_` prefix: ensureProject (shared
      // with `coodra init`) mints a bare UUID, unlike the old
      // autoCreateProject this guard replaced.
      expect(out.runId).toMatch(/^run:[0-9a-f-]+:sess_1:[0-9a-f-]+$/);
      expect(typeof out.startedAt).toBe('string');
    }
    // Verify the projects row materialised.
    const projects = await h.handle.db
      .select()
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, 'my-fresh-project'));
    expect(projects).toHaveLength(1);
    expect(projects[0]?.orgId).toBe('org_dev_local');
    // Verify the runs row materialised with agentType stamped.
    const runs = await h.handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.sessionId, 'sess_1'));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.agentType).toBe('claude_code');
    expect(runs[0]?.mode).toBe('solo');
    expect(runs[0]?.status).toBe('in_progress');
  });

  it('stamps agentType=unknown when the transport did not supply one', async () => {
    const registry = buildRegistry(h.handle, 'solo');
    const result = await registry.handleCall(
      'get_run_id',
      { projectSlug: 'x', cwd: fakeCwd('x'), confirmRegister: true },
      'sess_x',
    );
    const out = unwrap(result);
    expect(out.ok).toBe(true);
    const runs = await h.handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.sessionId, 'sess_x'));
    expect(runs[0]?.agentType).toBe('unknown');
  });

  it('reuses the projects row on a second call with the same slug', async () => {
    const registry = buildRegistry(h.handle, 'solo');
    await registry.handleCall(
      'get_run_id',
      { projectSlug: 'same-slug', cwd: fakeCwd('same-slug'), confirmRegister: true },
      'sess_a',
    );
    await registry.handleCall('get_run_id', { projectSlug: 'same-slug' }, 'sess_b');
    const projects = await h.handle.db
      .select()
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, 'same-slug'));
    expect(projects).toHaveLength(1);
  });

  it('seeds the __default__ policy + baseline rules on registration (closes the fail-open gap)', async () => {
    // Regression for the 2026-07-18 fail-open defect: an auto-create used
    // to mint a projects row with NO policy, so the MCP evaluator waved
    // through every tool (doctor check 29 red). get_run_id (via
    // ensureProject) still seeds `__default__` so enforcement is live
    // from the first Write.
    const registry = buildRegistry(h.handle, 'solo');
    await registry.handleCall(
      'get_run_id',
      { projectSlug: 'guarded-project', cwd: fakeCwd('guarded-project'), confirmRegister: true },
      'sess_p',
      { agentType: 'claude_code' },
    );
    const projects = await h.handle.db
      .select()
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, 'guarded-project'));
    const projectId = projects[0]?.id;
    expect(projectId).toBeTypeOf('string');

    const policies = await h.handle.db
      .select()
      .from(sqliteSchema.policies)
      .where(eq(sqliteSchema.policies.projectId, projectId as string));
    expect(policies).toHaveLength(1);
    expect(policies[0]?.name).toBe('__default__');

    const rules = await h.handle.db
      .select()
      .from(sqliteSchema.policyRules)
      .where(eq(sqliteSchema.policyRules.policyId, policies[0]?.id as string));
    // 24 dangerous write denies + 2 env Read denies + 28 agent-control self-protection denies + 5 targeted Bash asks.
    expect(rules).toHaveLength(59);
    // Spot-check the exact rule doctor check 29 probes: Write→.env must deny.
    const envDeny = rules.find((r) => r.matchToolName === 'Write' && r.matchPathGlob === '.env');
    expect(envDeny?.decision).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// agentType precedence — a KNOWN transport-resolved ctx.agentType beats the
// input.agentType param (field fix 2026-07-12: an agent parroting a
// Codex-authored AGENTS.md passed agentType: "codex" and mislabeled its runs)
// ---------------------------------------------------------------------------

describe('get_run_id — agentType precedence (known transport identity beats the input param)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('stamps the transport ctx.agentType when it is known, ignoring input.agentType (the field scenario)', async () => {
    const registry = buildRegistry(h.handle, 'solo');
    const result = await registry.handleCall(
      'get_run_id',
      { projectSlug: 'claude-proj', agentType: 'codex', cwd: fakeCwd('claude-proj'), confirmRegister: true },
      'sess_field',
      { agentType: 'claude_code' },
    );
    const out = unwrap(result);
    expect(out.ok).toBe(true);
    const runs = await h.handle.db
      .select()
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.sessionId, 'sess_field'));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.agentType).toBe('claude_code');
  });

  it('falls back to input.agentType when the transport resolved unknown (param fallback preserved)', async () => {
    const registry = buildRegistry(h.handle, 'solo');
    // No 4th-arg agentType — the registry defaults ctx.agentType to 'unknown'.
    const result = await registry.handleCall(
      'get_run_id',
      { projectSlug: 'codex-proj', agentType: 'codex', cwd: fakeCwd('codex-proj'), confirmRegister: true },
      'sess_param',
    );
    const out = unwrap(result);
    expect(out.ok).toBe(true);
    const runs = await h.handle.db
      .select()
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.sessionId, 'sess_param'));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.agentType).toBe('codex');
  });

  it('stamps unknown when the transport resolved unknown and no input param was supplied', async () => {
    const registry = buildRegistry(h.handle, 'solo');
    const result = await registry.handleCall(
      'get_run_id',
      { projectSlug: 'anon-proj', cwd: fakeCwd('anon-proj'), confirmRegister: true },
      'sess_anon',
    );
    const out = unwrap(result);
    expect(out.ok).toBe(true);
    const runs = await h.handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.sessionId, 'sess_anon'));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.agentType).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Team mode — structured soft-failure on unknown slug (unchanged by COOD-63;
// team mode already had no auto-create path to gate)
// ---------------------------------------------------------------------------

describe('get_run_id — team mode returns project_not_found on unknown slug', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns ok:false / error:project_not_found / howToFix — and does NOT insert a projects row', async () => {
    const registry = buildRegistry(h.handle, 'team');
    const result = await registry.handleCall('get_run_id', { projectSlug: 'not-registered' }, 'sess_team');
    const out = unwrap(result);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toBe('project_not_found');
      expect(out.howToFix).toMatch(/Web App|coodra init/);
      expect(out.howToFix.length).toBeGreaterThan(0);
    }
    const projects = await h.handle.db
      .select()
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, 'not-registered'));
    expect(projects).toHaveLength(0);
  });

  it('ignores cwd/confirmRegister — still returns project_not_found, no projects row', async () => {
    const registry = buildRegistry(h.handle, 'team');
    const result = await registry.handleCall(
      'get_run_id',
      { projectSlug: 'still-not-registered', cwd: fakeCwd('still-not-registered'), confirmRegister: true },
      'sess_team2',
    );
    const out = unwrap(result);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('project_not_found');
    const projects = await h.handle.db
      .select()
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, 'still-not-registered'));
    expect(projects).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Existing runs — return cached, resume if terminal
// ---------------------------------------------------------------------------

describe('get_run_id — returns the existing run for (projectId, sessionId)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('returns the same runId on a second call for the same (slug, sessionId)', async () => {
    const registry = buildRegistry(h.handle, 'solo');
    const first = unwrap(
      await registry.handleCall(
        'get_run_id',
        { projectSlug: 'idem-slug', cwd: fakeCwd('idem-slug'), confirmRegister: true },
        'sess_idem',
      ),
    );
    const second = unwrap(await registry.handleCall('get_run_id', { projectSlug: 'idem-slug' }, 'sess_idem'));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.runId).toBe(first.runId);
      expect(second.startedAt).toBe(first.startedAt);
    }
  });

  it('resumes a terminal run back to in_progress (same runId, status flipped, ended_at cleared)', async () => {
    const registry = buildRegistry(h.handle, 'solo');
    const first = unwrap(
      await registry.handleCall(
        'get_run_id',
        { projectSlug: 'completed-slug', cwd: fakeCwd('completed-slug'), confirmRegister: true },
        'sess_done',
      ),
    );
    if (!first.ok) throw new Error('expected first call to succeed');
    // Mark the run as completed with an ended_at — simulates a real
    // SessionEnd firing mid-session before the same session_id resumes.
    await h.handle.db
      .update(sqliteSchema.runs)
      .set({ status: 'completed', endedAt: new Date() })
      .where(eq(sqliteSchema.runs.id, first.runId));

    const second = unwrap(await registry.handleCall('get_run_id', { projectSlug: 'completed-slug' }, 'sess_done'));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.runId).toBe(first.runId);

    const rows = await h.handle.db
      .select({ status: sqliteSchema.runs.status, endedAt: sqliteSchema.runs.endedAt })
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.id, first.runId));
    expect(rows[0]?.status).toBe('in_progress');
    expect(rows[0]?.endedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Concurrent-insert race
// ---------------------------------------------------------------------------

describe('get_run_id — concurrent calls with the same (slug, sessionId) converge on one run', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('Promise.all of two parallel calls returns the same runId in both responses', async () => {
    const registry = buildRegistry(h.handle, 'solo');
    const cwd = fakeCwd('race-slug');
    const [a, b] = await Promise.all([
      registry.handleCall('get_run_id', { projectSlug: 'race-slug', cwd, confirmRegister: true }, 'sess_race'),
      registry.handleCall('get_run_id', { projectSlug: 'race-slug', cwd, confirmRegister: true }, 'sess_race'),
    ]);
    const outA = unwrap(a);
    const outB = unwrap(b);
    expect(outA.ok).toBe(true);
    expect(outB.ok).toBe(true);
    if (outA.ok && outB.ok) {
      expect(outA.runId).toBe(outB.runId);
    }
    // Exactly one runs row for the (project, session) pair.
    const runs = await h.handle.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.sessionId, 'sess_race'));
    expect(runs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Different sessions → different runs for the same project
// ---------------------------------------------------------------------------

describe('get_run_id — different sessionIds under the same project get different runs', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('two calls with different sessionIds produce two distinct runs rows', async () => {
    const registry = buildRegistry(h.handle, 'solo');
    const a = unwrap(
      await registry.handleCall(
        'get_run_id',
        { projectSlug: 'multi-session', cwd: fakeCwd('multi-session'), confirmRegister: true },
        'sess_1',
      ),
    );
    const b = unwrap(await registry.handleCall('get_run_id', { projectSlug: 'multi-session' }, 'sess_2'));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.runId).not.toBe(b.runId);
    }
    // Scope to the test's two sessions — migration 0008 seeds a
    // `run:__global__:orphan-backfill-0008` row in every fresh DB
    // (F3 orphan rebind), so an unfiltered SELECT now returns 3.
    // The test's intent is "two distinct runs for these sessionIds",
    // not a global count.
    const runs = await h.handle.db
      .select()
      .from(sqliteSchema.runs)
      .where(inArray(sqliteSchema.runs.sessionId, ['sess_1', 'sess_2']));
    expect(runs).toHaveLength(2);
  });
});
