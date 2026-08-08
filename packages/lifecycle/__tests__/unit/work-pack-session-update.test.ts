import { createDb, migrateSqlite, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { updateLinkedWorkPackFromRun } from '../../src/work-pack-session-update.js';

describe('updateLinkedWorkPackFromRun', () => {
  it('writes a generated implementation overview into the linked Work Pack', async () => {
    const db = createDb({ kind: 'local', sqlite: { path: ':memory:' } });
    if (db.kind !== 'sqlite') throw new Error('expected sqlite handle');
    migrateSqlite(db.db);

    db.raw
      .prepare(`INSERT INTO projects (id, slug, org_id, name) VALUES (?, ?, ?, ?)`)
      .run('proj_1', 'coodra', 'org_test', 'Coodra');
    db.raw
      .prepare(
        `INSERT INTO work_packs
          (id, project_id, slug, title, pack_type, status, spec_markdown, implementation_markdown, sync_markdown, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('work_1', 'proj_1', 'cood-10', 'COOD-10', 'task', 'draft', '', '', 'Existing sync notes.', '{}');
    db.raw
      .prepare(
        `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status, work_pack_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('run_1', 'proj_1', 'sess_1', 'codex', 'solo', 'completed', 'work_1');
    db.raw
      .prepare(
        `INSERT INTO context_packs
          (id, run_id, project_id, title, content, content_excerpt, source, work_pack_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'cp_1',
        'run_1',
        'proj_1',
        'Initial COOD-10 context',
        'Imported Jira and prepared implementation plan.',
        'Imported Jira and prepared implementation plan.',
        'agent',
        'work_1',
      );
    db.raw
      .prepare(
        `INSERT INTO run_diffs
          (run_id, base_sha, head_sha, unified_diff, files_changed, truncated, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'run_1',
        'a'.repeat(40),
        'b'.repeat(40),
        '',
        JSON.stringify([
          { path: 'packages/shared/src/work-intent.ts', status: 'modified', additions: 10, deletions: 2 },
          {
            path: 'apps/hooks-bridge/src/lib/work-pack-session-update.ts',
            status: 'added',
            additions: 80,
            deletions: 0,
          },
        ]),
        0,
        null,
      );

    await updateLinkedWorkPackFromRun({
      db,
      runId: 'run_1',
      now: new Date('2026-07-31T08:00:00Z'),
    });

    const rows = await db.db
      .select({ syncMarkdown: sqliteSchema.workPacks.syncMarkdown })
      .from(sqliteSchema.workPacks)
      .where(eq(sqliteSchema.workPacks.id, 'work_1'));
    const markdown = rows[0]?.syncMarkdown ?? '';
    expect(markdown).toContain('Existing sync notes.');
    expect(markdown).toContain('<!-- coodra:work-pack-session-overview:start -->');
    expect(markdown).toContain('## Latest implementation overview');
    expect(markdown).toContain('Initial COOD-10 context');
    expect(markdown).toContain('Imported Jira and prepared implementation plan.');
    expect(markdown).toContain('`packages/shared/src/work-intent.ts` - modified +10 -2');
    expect(markdown).toContain('`apps/hooks-bridge/src/lib/work-pack-session-update.ts` - added +80 -0');
    expect(markdown).toContain('<!-- coodra:work-pack-session-overview:end -->');
  });
});
