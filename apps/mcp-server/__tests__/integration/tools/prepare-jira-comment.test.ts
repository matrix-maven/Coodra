import { migrateSqlite, type SqliteHandle, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createGetRunIdToolRegistration } from '../../../src/tools/get-run-id/manifest.js';
import type { GetRunIdOutput } from '../../../src/tools/get-run-id/schema.js';
import { createLinkRunToIssueToolRegistration } from '../../../src/tools/link-run-to-issue/manifest.js';
import { createPrepareJiraCommentToolRegistration } from '../../../src/tools/prepare-jira-comment/manifest.js';
import type { PrepareJiraCommentOutput } from '../../../src/tools/prepare-jira-comment/schema.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Integration test for `coodra__prepare_jira_comment` (Module 09 Track 9A,
 * ADR-016 — the on-request write-back helper). Assembles a markdown comment
 * for a linked run from its Context Pack + decisions; the agent then posts
 * the body via Rovo's addCommentToJiraIssue. Read-only — no Jira call.
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
}

async function openHarness(): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);
  return { close: async () => void (await client.close()), handle };
}

function buildRegistry(handle: SqliteHandle): ToolRegistry {
  const registry = new ToolRegistry({ deps: makeFakeDeps() });
  registry.register(createGetRunIdToolRegistration({ db: handle, mode: 'solo' }));
  registry.register(createLinkRunToIssueToolRegistration({ db: handle }));
  registry.register(createPrepareJiraCommentToolRegistration({ db: handle }));
  return registry;
}

function unwrap<T>(result: { readonly content: ReadonlyArray<{ type: string; text: string }> }): T {
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { ok: boolean; data?: T };
  if (!parsed.ok || parsed.data === undefined) throw new Error(`unexpected envelope: ${JSON.stringify(parsed)}`);
  return parsed.data;
}

async function mintRun(registry: ToolRegistry, slug: string, sessionId: string): Promise<string> {
  const out = unwrap<GetRunIdOutput>(
    await registry.handleCall(
      'get_run_id',
      { projectSlug: slug, cwd: `/tmp/coodra-test/${slug}`, confirmRegister: true },
      sessionId,
      { agentType: 'claude_code' },
    ),
  );
  if (!out.ok) throw new Error('get_run_id failed');
  return out.runId;
}

async function projectIdOf(h: Harness, runId: string): Promise<string> {
  const rows = await h.handle.db
    .select({ projectId: sqliteSchema.runs.projectId })
    .from(sqliteSchema.runs)
    .where(eq(sqliteSchema.runs.id, runId))
    .limit(1);
  const pid = rows[0]?.projectId;
  if (pid === undefined) throw new Error('run has no projectId');
  return pid;
}

describe('prepare_jira_comment — assembles the session summary', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('builds a body from the pack title + excerpt + top decisions', async () => {
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'pjc-a', 'sess_a');
    await registry.handleCall('link_run_to_issue', { runId, issueRef: 'PROJ-9' }, 'sess_a');
    const projectId = await projectIdOf(h, runId);

    await h.handle.db.insert(sqliteSchema.contextPacks).values({
      id: 'cp_a',
      runId,
      projectId,
      title: 'Wired the auth flow',
      content: 'Long pack content here.',
      contentExcerpt: 'Added OAuth + token refresh.',
    });
    await h.handle.db.insert(sqliteSchema.decisions).values([
      { id: 'd1', idempotencyKey: 'k1', runId, description: 'Chose Clerk over Auth0', rationale: 'r' },
      { id: 'd2', idempotencyKey: 'k2', runId, description: 'Stored tokens encrypted', rationale: 'r' },
    ]);

    const out = unwrap<PrepareJiraCommentOutput>(
      await registry.handleCall('prepare_jira_comment', { runId }, 'sess_a'),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.issueRef).toBe('PROJ-9');
      expect(out.body).toContain('PROJ-9');
      expect(out.body).toContain('Wired the auth flow');
      expect(out.body).toContain('Added OAuth + token refresh.');
      expect(out.body).toContain('Chose Clerk over Auth0');
      expect(out.body).toContain('Stored tokens encrypted');
      expect(out.body).toContain(runId);
    }
  });

  it('honours maxDecisions (caps the bullet list)', async () => {
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'pjc-b', 'sess_b');
    await registry.handleCall('link_run_to_issue', { runId, issueRef: 'KAN-1' }, 'sess_b');
    await h.handle.db.insert(sqliteSchema.decisions).values(
      Array.from({ length: 5 }, (_, i) => ({
        id: `dd${i}`,
        idempotencyKey: `kk${i}`,
        runId,
        description: `Decision number ${i}`,
        rationale: 'r',
      })),
    );
    const out = unwrap<PrepareJiraCommentOutput>(
      await registry.handleCall('prepare_jira_comment', { runId, maxDecisions: 2 }, 'sess_b'),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      const bullets = out.body.split('\n').filter((l) => l.startsWith('- '));
      expect(bullets).toHaveLength(2);
    }
  });

  it('works with no pack and no decisions (sparse but valid body)', async () => {
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'pjc-c', 'sess_c');
    await registry.handleCall('link_run_to_issue', { runId, issueRef: 'EMPTY-1' }, 'sess_c');
    const out = unwrap<PrepareJiraCommentOutput>(
      await registry.handleCall('prepare_jira_comment', { runId }, 'sess_c'),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.body).toContain('EMPTY-1');
      expect(out.body.length).toBeGreaterThan(0);
    }
  });

  it('returns not_linked when the run has no issueRef', async () => {
    const registry = buildRegistry(h.handle);
    const runId = await mintRun(registry, 'pjc-d', 'sess_d');
    const out = unwrap<PrepareJiraCommentOutput>(
      await registry.handleCall('prepare_jira_comment', { runId }, 'sess_d'),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toBe('not_linked');
      expect(out.howToFix).toContain('link_run_to_issue');
    }
  });

  it('returns run_not_found for an unknown runId', async () => {
    const registry = buildRegistry(h.handle);
    const out = unwrap<PrepareJiraCommentOutput>(
      await registry.handleCall('prepare_jira_comment', { runId: 'nope' }, 'sess_e'),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('run_not_found');
  });
});
