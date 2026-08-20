import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDb,
  deleteProject,
  ensureProject,
  migrateSqlite,
  type SqliteHandle,
  sqliteSchema,
} from '../../src/index.js';

let cwd: string;
let handle: SqliteHandle;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'delete-project-test-'));
  const opened = createDb({ kind: 'local', sqlite: { path: join(cwd, 'data.db') } });
  if (opened.kind !== 'sqlite') throw new Error('expected sqlite');
  handle = opened;
  migrateSqlite(handle.db);
});

afterAll(() => {
  handle.close();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('@coodra/db::deleteProject', () => {
  it('deletes project rows even when newer project-owned tables contain data', async () => {
    const project = await ensureProject(handle, { slug: 'full-delete-project' });
    const policy = await handle.db
      .select({ id: sqliteSchema.policies.id })
      .from(sqliteSchema.policies)
      .where(eq(sqliteSchema.policies.projectId, project.id))
      .limit(1);
    const policyId = policy[0]?.id;
    expect(policyId).toBeTypeOf('string');

    handle.raw
      .prepare(
        `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('run_delete_project', project.id, 'sess-delete-project', 'codex', 'solo', 'in_progress');
    handle.raw
      .prepare(
        `INSERT INTO run_events (id, project_id, run_id, phase, tool_name, tool_use_id, tool_input)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('event_delete_project', project.id, 'run_delete_project', 'PreToolUse', 'Bash', 'toolu_delete', '{}');
    handle.raw
      .prepare(
        `INSERT INTO decisions (id, project_id, run_id, idempotency_key, description, rationale)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'decision_delete_project',
        project.id,
        'run_delete_project',
        'dec:run_delete_project:delete-project',
        'Delete-project regression decision',
        'Covers cascade counts',
      );
    handle.raw
      .prepare(
        `INSERT INTO context_packs (id, project_id, run_id, title, content, content_excerpt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'pack_delete_project',
        project.id,
        'run_delete_project',
        'Delete-project regression pack',
        'Context pack body',
        'Context pack body',
      );
    handle.raw
      .prepare(
        `INSERT INTO audit_events (id, org_id, project_id, event_type, subject_table, subject_id, action)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('audit_delete_project', '__solo__', project.id, 'project.test', 'projects', project.id, 'create');
    handle.raw
      .prepare(
        `INSERT INTO memory_access_events (id, project_id, run_id, channel, site, memory_type, trigger_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'mae_delete_project',
        project.id,
        'run_delete_project',
        'push',
        'session_start_manifest',
        'manifest',
        'session_start',
      );
    handle.raw
      .prepare(
        `INSERT INTO policy_versions (id, project_id, policy_id, version_number, snapshot_json, snapshot_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('pv_delete_project', project.id, policyId, 99, '{}', 'hash');
    handle.raw
      .prepare(
        `INSERT INTO features (id, project_id, slug, frontmatter, body, checksum, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('feature_delete_project', project.id, 'recipe-one', '{}', 'body', 'checksum', 'published');
    handle.raw
      .prepare(
        `INSERT INTO controls (id, project_id, control_key, title, relevance_track, implementation_mode)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('control_delete_project', project.id, 'ctrl.one', 'Control One', 'engineering', 'manual');
    handle.raw
      .prepare(
        `INSERT INTO control_attestations (id, project_id, control_id, status)
         VALUES (?, ?, ?, ?)`,
      )
      .run('attestation_delete_project', project.id, 'control_delete_project', 'recorded');
    handle.raw
      .prepare(
        `INSERT INTO wikis (id, project_id, slug, title, description, structure_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('wiki_delete_project', project.id, 'main', 'Main', 'Test wiki', '{"pages":[]}');
    handle.raw
      .prepare(
        `INSERT INTO wiki_pages (id, project_id, wiki_id, page_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run('wiki_page_delete_project', project.id, 'wiki_delete_project', 'overview');

    const result = await deleteProject(handle, project.id);
    expect(result.status).toBe('deleted');
    expect(result.cascade).toMatchObject({
      runsDeleted: 1,
      runEventsDeleted: 1,
      decisionsDeleted: 1,
      contextPacksDeleted: 1,
    });

    const projects = await handle.db
      .select({ id: sqliteSchema.projects.id })
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.id, project.id));
    expect(projects).toHaveLength(0);

    for (const table of [
      'audit_events',
      'memory_access_events',
      'policy_versions',
      'features',
      'control_attestations',
      'controls',
      'wiki_pages',
      'wikis',
      'policies',
    ]) {
      const row = handle.raw.prepare(`SELECT count(*) AS n FROM ${table} WHERE project_id = ?`).get(project.id) as {
        n: number;
      };
      expect(row.n, table).toBe(0);
    }
  });

  /**
   * The case the original fixture could not reach.
   *
   * `work_packs.latest_context_pack_id` is a bare
   * `REFERENCES context_packs(id)` with no `ON DELETE` clause, and
   * `work_pack_*_links` reference runs, decisions and packs. A project
   * with no work packs deletes cleanly no matter what order the phases
   * run in, so the ordering bug was invisible to a fixture without one
   * — it only reproduced on the largest real project on the machine.
   */
  it('deletes a project whose work packs point back at its context packs', async () => {
    const project = await ensureProject(handle, { slug: 'work-pack-delete-project' });
    const ids = {
      run: 'run_wp_delete',
      pack: 'cp_wp_delete',
      decision: 'dec_wp_delete',
      workPack: 'wp_delete',
    };

    handle.raw
      .prepare(
        `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(ids.run, project.id, 'sess-wp-delete', 'claude_code', 'solo', 'in_progress');
    handle.raw
      .prepare(
        `INSERT INTO context_packs (id, project_id, run_id, title, content)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(ids.pack, project.id, ids.run, 'wp pack', 'body');
    handle.raw
      .prepare(
        `INSERT INTO decisions (id, project_id, run_id, idempotency_key, description, rationale)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(ids.decision, project.id, ids.run, 'idem_wp_delete', 'wp decision', 'because');
    // The FK with no ON DELETE clause — this is the one that made the
    // delete fail with FOREIGN KEY constraint failed.
    handle.raw
      .prepare(
        `INSERT INTO work_packs (id, project_id, slug, title, status, latest_context_pack_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(ids.workPack, project.id, 'wp-delete', 'WP', 'active', ids.pack);
    handle.raw
      .prepare(
        `INSERT INTO work_pack_context_pack_links (id, project_id, work_pack_id, context_pack_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run('wpcpl_delete', project.id, ids.workPack, ids.pack);
    handle.raw
      .prepare(
        `INSERT INTO work_pack_decision_links (id, project_id, work_pack_id, decision_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run('wpdl_delete', project.id, ids.workPack, ids.decision);

    const result = await deleteProject(handle, project.id);
    expect(result.status).toBe('deleted');

    // Counts must be truthful. They were silently zeroed for a while,
    // because the cascade threw and the error was swallowed into an
    // empty placeholder result.
    expect(result.cascade?.runsDeleted).toBe(1);
    expect(result.cascade?.decisionsDeleted).toBe(1);
    expect(result.cascade?.contextPacksDeleted).toBe(1);

    const violations = handle.raw.pragma('foreign_key_check') as unknown[];
    expect(violations).toHaveLength(0);
    for (const table of ['work_packs', 'work_pack_context_pack_links', 'work_pack_decision_links', 'runs']) {
      const row = handle.raw.prepare(`SELECT count(*) AS n FROM ${table} WHERE project_id = ?`).get(project.id) as {
        n: number;
      };
      expect(row.n, table).toBe(0);
    }
  });

  /**
   * Drift guard.
   *
   * The delete list was hand-maintained and fell behind the schema
   * three separate times — the COOD-79 `memory_*` tables were the most
   * recent. Enumerating the FK referrers from the live schema turns the
   * next omission into a failing test instead of a runtime
   * `FOREIGN KEY constraint failed` on somebody's real database.
   */
  it('leaves no table with an FK to projects holding rows after a delete', async () => {
    const project = await ensureProject(handle, { slug: 'drift-guard-project' });
    const referrers = (
      handle.raw
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND sql LIKE '%REFERENCES \`projects\`%'`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(referrers.length).toBeGreaterThan(15);

    handle.raw
      .prepare(
        `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('run_drift', project.id, 'sess-drift', 'claude_code', 'solo', 'in_progress');

    expect((await deleteProject(handle, project.id)).status).toBe('deleted');

    for (const table of referrers) {
      const row = handle.raw.prepare(`SELECT count(*) AS n FROM ${table} WHERE project_id = ?`).get(project.id) as {
        n: number;
      };
      expect(row.n, `${table} still holds rows for the deleted project`).toBe(0);
    }
  });

  it('refuses the __global__ sentinel and reports a missing project honestly', async () => {
    expect((await deleteProject(handle, '__global__')).status).toBe('sentinel_locked');
    expect((await deleteProject(handle, 'no-such-project')).status).toBe('not_found');
  });

  /**
   * Atomicity. A mid-way constraint failure used to leave a partially
   * deleted project with no way to resume — strictly worse than the
   * original refusal to delete.
   */
  it('rolls back completely when the delete cannot finish', async () => {
    const project = await ensureProject(handle, { slug: 'rollback-project' });
    handle.raw
      .prepare(
        `INSERT INTO runs (id, project_id, session_id, agent_type, mode, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('run_rollback', project.id, 'sess-rollback', 'claude_code', 'solo', 'in_progress');

    // A row in a table the delete does not know about, with an FK that
    // blocks the final `DELETE FROM projects`.
    handle.raw.exec(
      'CREATE TABLE IF NOT EXISTS drift_table (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id))',
    );
    handle.raw.prepare('INSERT INTO drift_table (id, project_id) VALUES (?, ?)').run('drift_1', project.id);

    await expect(deleteProject(handle, project.id)).rejects.toThrow(/FOREIGN KEY/i);

    // Nothing may have been lost: the run is still there and so is the
    // project, rather than a half-deleted shell.
    const runs = handle.raw.prepare('SELECT count(*) AS n FROM runs WHERE project_id = ?').get(project.id) as {
      n: number;
    };
    expect(runs.n, 'run survived the rollback').toBe(1);
    const projects = handle.raw.prepare('SELECT count(*) AS n FROM projects WHERE id = ?').get(project.id) as {
      n: number;
    };
    expect(projects.n, 'project survived the rollback').toBe(1);

    handle.raw.exec('DROP TABLE drift_table');
  });
});
