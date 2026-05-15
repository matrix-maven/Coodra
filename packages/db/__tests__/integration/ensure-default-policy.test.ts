import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDb,
  type DbHandle,
  ensureDefaultPolicy,
  ensureProject,
  migrateSqlite,
  sqliteSchema,
} from '../../src/index.js';

/**
 * Locks the Phase 3 Fix D + Phase 4 Fix F (both 2026-05-02) seed contract:
 *
 *   - Phase 3 Fix D: fresh installs must seed a default Policy + rules
 *     so the evaluator denies dangerous writes on day one.
 *
 *   - Phase 4 Fix F: rule set covers the cross-product
 *       tools = { Write, Edit, MultiEdit, NotebookEdit }
 *       globs = { .env, **\/.env, .git/**, **\/.git/**,
 *                 node_modules/**, **\/node_modules/** }
 *     plus the existing Bash → ask. 24 deny + 1 ask = 25 rules total.
 *
 *   - Phase 4 Fix F also adds an additive-merge repair path: an
 *     existing `__default__` policy missing some rules from the new
 *     baseline gets the missing rules inserted on `ensureDefaultPolicy`
 *     re-run — no user customizations touched.
 */

let cwd: string;
let handle: DbHandle;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ensure-default-policy-test-'));
  const opened = createDb({ kind: 'local', sqlite: { path: join(cwd, 'data.db') } });
  if (opened.kind !== 'sqlite') throw new Error('expected sqlite');
  handle = opened;
  migrateSqlite(handle.db);
});

afterAll(() => {
  if (handle?.kind === 'sqlite') handle.close();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('@coodra/db::ensureDefaultPolicy', () => {
  it('inserts a default Policy row + Phase-4-Fix-F baseline rule set on first call (4 tools × 6 globs + Bash = 25 rules)', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const project = await ensureProject(handle, { slug: 'fresh-policy-project' });

    const result = await ensureDefaultPolicy(handle, project.id);
    expect(result.created).toBe(true);
    expect(result.policyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.rulesInserted).toBe(25);

    const policies = await handle.db
      .select({ id: sqliteSchema.policies.id, name: sqliteSchema.policies.name })
      .from(sqliteSchema.policies)
      .where(eq(sqliteSchema.policies.projectId, project.id));
    expect(policies.length).toBe(1);
    expect(policies[0]?.name).toBe('__default__');

    const rules = await handle.db
      .select({
        priority: sqliteSchema.policyRules.priority,
        matchToolName: sqliteSchema.policyRules.matchToolName,
        matchPathGlob: sqliteSchema.policyRules.matchPathGlob,
        decision: sqliteSchema.policyRules.decision,
      })
      .from(sqliteSchema.policyRules)
      .where(eq(sqliteSchema.policyRules.policyId, result.policyId));
    expect(rules.length).toBe(25);

    // Phase 4 Fix F: every file-mutating tool denied for every dangerous
    // glob. Walk the cross-product explicitly.
    const tools = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;
    const globs = ['.env', '**/.env', '.git/**', '**/.git/**', 'node_modules/**', '**/node_modules/**'] as const;
    for (const tool of tools) {
      for (const glob of globs) {
        const rule = rules.find((r) => r.matchToolName === tool && r.matchPathGlob === glob);
        expect(rule, `${tool} → ${glob} must be present in default policy`).toBeDefined();
        expect(rule?.decision, `${tool} → ${glob} must deny`).toBe('deny');
      }
    }
    // Bash ask rule still present.
    const bashAsk = rules.find((r) => r.matchToolName === 'Bash');
    expect(bashAsk?.decision).toBe('ask');
  });

  it('Phase 4 Fix F: existing pre-Fix-F install with 9 narrow rules is repaired additively (16 missing rules added)', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const project = await ensureProject(handle, { slug: 'pre-fix-f-install' });

    // Hand-seed the pre-Fix-F shape: __default__ policy + the 9 Phase-3
    // rules at their original priorities. Mimics what existing user
    // installs have on disk before they re-run `coodra init`.
    const PRE_FIX_F = [
      { priority: 10, tool: 'Write', glob: '.env', dec: 'deny' as const },
      { priority: 11, tool: 'Write', glob: '**/.env', dec: 'deny' as const },
      { priority: 20, tool: 'Write', glob: '.git/**', dec: 'deny' as const },
      { priority: 30, tool: 'Write', glob: 'node_modules/**', dec: 'deny' as const },
      { priority: 40, tool: 'Edit', glob: '.env', dec: 'deny' as const },
      { priority: 41, tool: 'Edit', glob: '**/.env', dec: 'deny' as const },
      { priority: 50, tool: 'Edit', glob: '.git/**', dec: 'deny' as const },
      { priority: 60, tool: 'Edit', glob: 'node_modules/**', dec: 'deny' as const },
      { priority: 70, tool: 'Bash', glob: null, dec: 'ask' as const },
    ];
    const policyId = '00000000-0000-0000-0000-prefixfphase3';
    await handle.db.insert(sqliteSchema.policies).values({
      id: policyId,
      projectId: project.id,
      name: '__default__',
      description: 'pre-Fix-F seed',
      isActive: true,
    });
    await handle.db.insert(sqliteSchema.policyRules).values(
      PRE_FIX_F.map((r, i) => ({
        id: `pre-fix-f-rule-${i.toString().padStart(2, '0')}`,
        policyId,
        priority: r.priority,
        matchEventType: 'PreToolUse',
        matchToolName: r.tool,
        matchPathGlob: r.glob,
        matchAgentType: '*',
        decision: r.dec,
        reason: 'pre-fix-f',
      })),
    );

    const result = await ensureDefaultPolicy(handle, project.id);
    expect(result.created).toBe(false);
    // 25 baseline - 9 already-present = 16 missing rules to insert.
    expect(result.rulesInserted).toBe(16);
    expect(result.policyId).toBe(policyId);

    // Existing rules are preserved unchanged.
    const allRules = await handle.db
      .select({
        id: sqliteSchema.policyRules.id,
        priority: sqliteSchema.policyRules.priority,
        matchToolName: sqliteSchema.policyRules.matchToolName,
        matchPathGlob: sqliteSchema.policyRules.matchPathGlob,
        decision: sqliteSchema.policyRules.decision,
        reason: sqliteSchema.policyRules.reason,
      })
      .from(sqliteSchema.policyRules)
      .where(eq(sqliteSchema.policyRules.policyId, policyId));
    expect(allRules.length).toBe(25);

    const preserved = allRules.find((r) => r.id === 'pre-fix-f-rule-00');
    expect(preserved?.reason).toBe('pre-fix-f'); // unchanged

    // The repair added MultiEdit + NotebookEdit + nested-glob rules.
    expect(allRules.some((r) => r.matchToolName === 'MultiEdit' && r.matchPathGlob === '.env')).toBe(true);
    expect(allRules.some((r) => r.matchToolName === 'NotebookEdit' && r.matchPathGlob === '**/.env')).toBe(true);
    expect(allRules.some((r) => r.matchToolName === 'Write' && r.matchPathGlob === '**/.git/**')).toBe(true);
    expect(allRules.some((r) => r.matchToolName === 'Edit' && r.matchPathGlob === '**/node_modules/**')).toBe(true);
  });

  it('Phase 4 Fix F: user-customized rule (changed reason text on a Phase-3 rule) survives a repair', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const project = await ensureProject(handle, { slug: 'customized-policy-install' });

    // User has a __default__ policy with a hand-edited reason on the
    // priority-10 .env-Write rule. The additive merge must NOT touch it.
    const policyId = '00000000-0000-0000-0000-customizedinst';
    await handle.db.insert(sqliteSchema.policies).values({
      id: policyId,
      projectId: project.id,
      name: '__default__',
      description: 'customized',
      isActive: true,
    });
    await handle.db.insert(sqliteSchema.policyRules).values({
      id: 'user-edited-rule',
      policyId,
      priority: 10,
      matchEventType: 'PreToolUse',
      matchToolName: 'Write',
      matchPathGlob: '.env',
      matchAgentType: '*',
      decision: 'deny',
      reason: 'CUSTOMIZED REASON — DO NOT TOUCH',
    });

    await ensureDefaultPolicy(handle, project.id);

    const userEditedAfter = await handle.db
      .select({
        reason: sqliteSchema.policyRules.reason,
      })
      .from(sqliteSchema.policyRules)
      .where(eq(sqliteSchema.policyRules.id, 'user-edited-rule'));
    expect(userEditedAfter[0]?.reason).toBe('CUSTOMIZED REASON — DO NOT TOUCH');
  });

  it('is idempotent: a second call returns created:false and inserts no rules', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const project = await ensureProject(handle, { slug: 'idempotent-policy-project' });

    const first = await ensureDefaultPolicy(handle, project.id);
    expect(first.created).toBe(true);

    const second = await ensureDefaultPolicy(handle, project.id);
    expect(second.created).toBe(false);
    expect(second.rulesInserted).toBe(0);
    expect(second.policyId).toBe(first.policyId);

    const policyCount = (
      await handle.db
        .select({ id: sqliteSchema.policies.id })
        .from(sqliteSchema.policies)
        .where(eq(sqliteSchema.policies.projectId, project.id))
    ).length;
    expect(policyCount).toBe(1);
  });

  it('Phase 4 Fix F priority ordering: .env-Write at priority 10 fires first; Bash sits at priority 70 between Edit and MultiEdit blocks', async () => {
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    const project = await ensureProject(handle, { slug: 'priority-policy-project' });
    const result = await ensureDefaultPolicy(handle, project.id);

    const rules = await handle.db
      .select({
        priority: sqliteSchema.policyRules.priority,
        matchToolName: sqliteSchema.policyRules.matchToolName,
        matchPathGlob: sqliteSchema.policyRules.matchPathGlob,
        decision: sqliteSchema.policyRules.decision,
      })
      .from(sqliteSchema.policyRules)
      .where(eq(sqliteSchema.policyRules.policyId, result.policyId))
      .orderBy(sqliteSchema.policyRules.priority);

    // First rule by priority is the .env Write deny (priority 10) — the
    // highest-stake target. Phase 3 priority preserved.
    expect(rules[0]?.priority).toBe(10);
    expect(rules[0]?.matchPathGlob).toBe('.env');
    expect(rules[0]?.matchToolName).toBe('Write');
    expect(rules[0]?.decision).toBe('deny');

    // Bash ask rule sits at priority 70 (between Edit's last priority 60
    // and MultiEdit's first priority 80). Priority order doesn't affect
    // Bash correctness because tool-name predicates partition the rule
    // space — Bash never collides with file-mutating tools.
    const bashIdx = rules.findIndex((r) => r.matchToolName === 'Bash');
    expect(bashIdx).toBeGreaterThan(-1);
    expect(rules[bashIdx]?.priority).toBe(70);
    expect(rules[bashIdx]?.decision).toBe('ask');

    // Last rule by priority is in the NotebookEdit block (priority 95).
    const last = rules[rules.length - 1];
    expect(last?.matchToolName).toBe('NotebookEdit');
    expect(last?.priority).toBe(95);
  });
});

/**
 * Slice 7 (2026-05-03 audit §14.2) — UNIQUE constraint backstop.
 * Verifies that the schema's UNIQUE INDEX on
 *   (policy_id, priority, match_event_type, match_tool_name, match_path_glob)
 * actually fires when a duplicate INSERT bypasses ensureDefaultPolicy's
 * application-layer WHERE NOT EXISTS guard. Pre-Slice-7 the duplicate
 * would silently succeed (the audit observed 9 priority-1 rows in the
 * demo DB where 3 was the design intent).
 */
describe('Slice 7 — policy_rules UNIQUE constraint enforces', () => {
  it('a second raw INSERT with the same key tuple aborts with a constraint violation', async () => {
    const project = await ensureProject(handle, { slug: 'slice7-uk-test', orgId: 'org_dev_local' });
    const result = await ensureDefaultPolicy(handle, project.id);
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle for raw INSERT');

    // Pick the first rule from the seeded set via raw SQL (drizzle's
    // .where(eq(...)) with the joined Date type was producing a
    // "Too few parameters" binding error in this specific test
    // context; raw prepare is unambiguous and matches what
    // ensure-default-policy.ts itself uses).
    const target = handle.raw
      .prepare(
        'SELECT priority, match_event_type AS matchEventType, match_tool_name AS matchToolName, match_path_glob AS matchPathGlob FROM policy_rules WHERE policy_id = ? LIMIT 1',
      )
      .get(result.policyId) as
      | { priority: number; matchEventType: string; matchToolName: string; matchPathGlob: string | null }
      | undefined;
    expect(target).toBeDefined();
    if (!target) return;

    // Raw INSERT bypassing ensureDefaultPolicy's WHERE NOT EXISTS. The
    // UNIQUE INDEX on (policy_id, priority, match_event_type,
    // match_tool_name, match_path_glob) MUST reject this. Pre-Slice-7
    // it would have silently succeeded and produced a duplicate row.
    let thrown: unknown;
    try {
      handle.raw
        .prepare(
          `INSERT INTO policy_rules (id, policy_id, priority, match_event_type, match_tool_name, match_path_glob, decision, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))`,
        )
        .run(
          'duplicate-row-id',
          result.policyId,
          target.priority,
          target.matchEventType,
          target.matchToolName,
          target.matchPathGlob,
          'deny',
          'duplicate attempt — should be rejected',
        );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error).message).toMatch(/UNIQUE|policy_rules_dedup_uk/);
  });
});
