import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSqliteDb, migrateSqlite, sqliteSchema } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assembleKnowledgeGrounding } from '../../../src/lib/wiki/knowledge.js';

/**
 * Locks the Phase 4 knowledge grounding: `assembleKnowledgeGrounding` reads a
 * project's recorded decisions + context packs from the local store, bounded
 * and excerpt-only, and returns null for an unregistered project rather than
 * throwing.
 */

let home: string;
let dataDb: string;
type Handle = ReturnType<typeof createSqliteDb>;
let handle: Handle;

const now = new Date('2026-07-24T00:00:00.000Z');

function seedProject(id: string, slug: string): void {
  handle.db
    .insert(sqliteSchema.projects)
    .values({ id, slug, orgId: '__solo__', name: slug, createdAt: now, updatedAt: now })
    .run();
}

function seedRun(id: string, projectId: string): void {
  handle.db
    .insert(sqliteSchema.runs)
    .values({ id, projectId, sessionId: `s_${id}`, agentType: 'claude_code', mode: 'solo', startedAt: now })
    .run();
}

function seedDecision(id: string, runId: string, description: string, rationale: string, alternatives: string): void {
  handle.db
    .insert(sqliteSchema.decisions)
    .values({ id, idempotencyKey: `dec_${id}`, runId, description, rationale, alternatives, createdAt: now })
    .run();
}

function seedPack(id: string, runId: string, projectId: string, title: string, excerpt: string): void {
  handle.db
    .insert(sqliteSchema.contextPacks)
    .values({
      id,
      runId,
      projectId,
      title,
      content: `${title} — full body`,
      contentExcerpt: excerpt,
      createdAt: now,
    })
    .run();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wiki-knowledge-'));
  dataDb = join(home, 'data.db');
  handle = createSqliteDb({ path: dataDb });
  migrateSqlite(handle.db);
});

afterEach(() => {
  handle.close();
  rmSync(home, { recursive: true, force: true });
});

describe('assembleKnowledgeGrounding', () => {
  it('returns decisions + context packs for a registered project', async () => {
    seedProject('proj_1', 'demo');
    seedRun('run_1', 'proj_1');
    seedDecision('d1', 'run_1', 'Use Drizzle over Prisma', 'native pgvector support', JSON.stringify(['Prisma']));
    seedPack('cp1', 'run_1', 'proj_1', 'Module 09 closeout', 'wired graphify + jira via config');

    const k = await assembleKnowledgeGrounding(handle, 'demo');
    expect(k).not.toBeNull();
    if (k === null) return;
    expect(k.projectId).toBe('proj_1');
    expect(k.decisionCount).toBe(1);
    expect(k.decisions[0]?.description).toBe('Use Drizzle over Prisma');
    expect(k.decisions[0]?.rationale).toBe('native pgvector support');
    expect(k.decisions[0]?.alternatives).toEqual(['Prisma']);
    expect(k.packCount).toBe(1);
    expect(k.contextPacks[0]?.id).toBe('cp1');
    expect(k.contextPacks[0]?.title).toBe('Module 09 closeout');
    expect(k.contextPacks[0]?.excerpt).toBe('wired graphify + jira via config');
  });

  it('returns null for an unregistered project (pre-init wiki build is legitimate)', async () => {
    expect(await assembleKnowledgeGrounding(handle, 'never-registered')).toBeNull();
  });

  it('scopes to the requested project — no cross-project bleed', async () => {
    seedProject('proj_1', 'alpha');
    seedProject('proj_2', 'beta');
    seedRun('run_a', 'proj_1');
    seedRun('run_b', 'proj_2');
    seedDecision('da', 'run_a', 'Alpha decision', 'because alpha', '[]');
    seedDecision('db', 'run_b', 'Beta decision', 'because beta', '[]');

    const alpha = await assembleKnowledgeGrounding(handle, 'alpha');
    expect(alpha?.decisions.map((d) => d.description)).toEqual(['Alpha decision']);
  });

  it('caps decisions + packs and reports the honest total', async () => {
    seedProject('proj_1', 'big');
    seedRun('run_1', 'proj_1');
    for (let i = 0; i < 40; i++) {
      seedDecision(`d${i}`, 'run_1', `decision ${i}`, 'r', '[]');
    }
    // context_packs has a UNIQUE(run_id) — one pack per run (ADR-007) — so each
    // pack gets its own run.
    for (let i = 0; i < 30; i++) {
      seedRun(`run_p${i}`, 'proj_1');
      seedPack(`p${i}`, `run_p${i}`, 'proj_1', `pack ${i}`, 'e');
    }
    const k = await assembleKnowledgeGrounding(handle, 'big', { maxDecisions: 5, maxPacks: 3 });
    expect(k?.decisions).toHaveLength(5);
    expect(k?.contextPacks).toHaveLength(3);
    // Over-fetch is bounded at 4× the cap, so the reported total reflects "more
    // than shown" without an unbounded count query.
    expect(k?.decisionCount).toBeGreaterThan(5);
    expect(k?.packCount).toBeGreaterThan(3);
  });

  it('tolerates a bare-string alternatives value written by an older caller', async () => {
    seedProject('proj_1', 'demo');
    seedRun('run_1', 'proj_1');
    seedDecision('d1', 'run_1', 'Legacy decision', 'r', 'just a string, not JSON array');
    const k = await assembleKnowledgeGrounding(handle, 'demo');
    expect(k?.decisions[0]?.alternatives).toEqual(['just a string, not JSON array']);
  });

  it('treats an empty rationale as null', async () => {
    seedProject('proj_1', 'demo');
    seedRun('run_1', 'proj_1');
    seedDecision('d1', 'run_1', 'No-rationale decision', '', '[]');
    const k = await assembleKnowledgeGrounding(handle, 'demo');
    expect(k?.decisions[0]?.rationale).toBeNull();
  });
});
