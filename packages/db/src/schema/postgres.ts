import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core';

/**
 * Postgres schema — team-mode cloud store (`system-architecture.md` §4.2).
 *
 * Mirrors `./sqlite.ts` column-for-column for all ten tables (5-table
 * Module-01 core + 5 Module-02 additions incl. `decisions`). The
 * schema-parity unit test
 * asserts that column names, notNull flags, and Drizzle `dataType`
 * categories match between dialects.
 *
 * The only intentional dialect difference is
 * `context_packs.summary_embedding`: `vector(384)` here (pgvector) and
 * `text` in SQLite (the parallel `context_packs_vec` vec0 virtual table
 * holds the real embeddings in SQLite; Postgres materialises the index
 * directly on this column via a hand-appended `CREATE INDEX ... USING
 * hnsw` block in migration 0001, sha256-locked in migrations.lock.json).
 *
 * `context_packs.content_excerpt` is populated at save time by
 * `save_context_pack` with the first 500 Unicode code points of
 * `content` (trailing whitespace trimmed).
 */

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  orgId: text('org_id').notNull(),
  name: text('name').notNull(),
  // Absolute filesystem path of the project root. See `./sqlite.ts` for the
  // full rationale (parity column for the per-project pack uploader).
  cwd: text('cwd'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    sessionId: text('session_id').notNull(),
    agentType: text('agent_type').notNull(),
    mode: text('mode').notNull(),
    status: text('status').notNull().default('in_progress'),
    issueRef: text('issue_ref'),
    prRef: text('pr_ref'),
    // Module 06 — see ./sqlite.ts::runs.baseSha for the full rationale.
    baseSha: text('base_sha'),
    // Module 04 Phase 4 — see ./sqlite.ts::runs.createdByUserId.
    createdByUserId: text('created_by_user_id'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [uniqueIndex('runs_project_session_idx').on(t.projectId, t.sessionId), index('runs_status_idx').on(t.status)],
);

export const runEvents = pgTable(
  'run_events',
  {
    id: text('id').primaryKey(),
    // run_id is nullable + ON DELETE SET NULL: the `RunRecorder.record()`
    // contract (see apps/mcp-server/src/framework/tool-context.ts) accepts
    // `runId: string | null` so PreToolUse events that fire before a
    // `runs` row exists still land in the trace (system-architecture.md
    // §4.3 rationale). Widened from NOT NULL in Module-02 migration 0002
    // — see context_memory/decisions-log.md 2026-04-24.
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    phase: text('phase').notNull(),
    toolName: text('tool_name').notNull(),
    toolUseId: text('tool_use_id').notNull(),
    toolInput: text('tool_input').notNull(),
    outcome: text('outcome'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('run_events_run_created_idx').on(t.runId, t.createdAt)],
);

export const contextPacks = pgTable(
  'context_packs',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    title: text('title').notNull(),
    content: text('content').notNull(),
    contentExcerpt: text('content_excerpt').notNull().default(''),
    // Module 05 (2026-05-08 reshape): kept through 0009; dropped in 0010.
    summaryEmbedding: vector('summary_embedding', { dimensions: 384 }),
    // Module 05 — see sqlite.ts contextPacks comment.
    source: text('source').notNull().default('agent'),
    // Module 05 — JSON-encoded agent-curated metadata. Use `text` (not
    // `jsonb`) for parity with SQLite. Handler does JSON.parse/stringify.
    meta: text('meta'),
    // Module 04 Phase 4 — see ./sqlite.ts::contextPacks.createdByUserId.
    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('context_packs_run_idx').on(t.runId),
    index('context_packs_project_created_idx').on(t.projectId, t.createdAt),
  ],
);

export const pendingJobs = pgTable(
  'pending_jobs',
  {
    id: text('id').primaryKey(),
    queue: text('queue').notNull(),
    payload: text('payload').notNull(),
    attempts: integer('attempts').notNull().default(0),
    // 'pending' | 'picked' | 'dead'. Module 03.1 outbox lifecycle.
    status: text('status').notNull().default('pending'),
    runAfter: timestamp('run_after', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    // Lease bookkeeping (Module 03.1). Set when status flips to 'picked';
    // an in-flight row whose pickedAt is older than leaseMs is treated as
    // orphaned and reclaimable by another worker (lease serialization).
    pickedAt: timestamp('picked_at', { withTimezone: true, mode: 'date' }),
    // Set when the worker exhausts maxAttempts (status='dead').
    failedAt: timestamp('failed_at', { withTimezone: true, mode: 'date' }),
    // Last dispatch error string. Retained on dead rows for the doctor
    // dead-letter check and any future audit-trail UI.
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('pending_jobs_poll_idx').on(t.queue, t.status, t.runAfter),
    // Fast orphan recovery: status='picked' rows ordered by pickedAt
    // surface lease-expired rows for reclaim without a full scan.
    index('pending_jobs_picked_idx').on(t.status, t.pickedAt),
  ],
);

export const policies = pgTable('policies', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  name: text('name').notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  // Module 04 Phase 4 — see ./sqlite.ts::policies.createdByUserId.
  createdByUserId: text('created_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const policyRules = pgTable(
  'policy_rules',
  {
    id: text('id').primaryKey(),
    policyId: text('policy_id')
      .notNull()
      .references(() => policies.id),
    priority: integer('priority').notNull(),
    matchEventType: text('match_event_type').notNull(),
    matchToolName: text('match_tool_name').notNull(),
    matchPathGlob: text('match_path_glob'),
    matchAgentType: text('match_agent_type'),
    decision: text('decision').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('policy_rules_policy_priority_idx').on(t.policyId, t.priority),
    // Slice 7 (2026-05-03 audit §14.2): mirror of the SQLite UNIQUE
    // constraint. Backstops ensureDefaultPolicy's application-layer
    // idempotency check so future raw-SQL adventurism cannot reintroduce
    // duplicates. See sqlite.ts comment for full rationale.
    uniqueIndex('policy_rules_dedup_uk').on(t.policyId, t.priority, t.matchEventType, t.matchToolName, t.matchPathGlob),
  ],
);

export const policyDecisions = pgTable(
  'policy_decisions',
  {
    id: text('id').primaryKey(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    runId: text('run_id').references(() => runs.id),
    sessionId: text('session_id').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    agentType: text('agent_type').notNull(),
    eventType: text('event_type').notNull(),
    toolName: text('tool_name').notNull(),
    toolInputSnapshot: text('tool_input_snapshot').notNull(),
    permissionDecision: text('permission_decision').notNull(),
    matchedRuleId: text('matched_rule_id').references(() => policyRules.id),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('policy_decisions_session_idx').on(t.sessionId, t.createdAt)],
);

export const featurePacks = pgTable('feature_packs', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  parentSlug: text('parent_slug'),
  isActive: boolean('is_active').notNull().default(true),
  checksum: text('checksum').notNull(),
  // Module 04 Phase 4 — see ./sqlite.ts::featurePacks.createdByUserId.
  createdByUserId: text('created_by_user_id'),
  // Phase F.2 — see ./sqlite.ts::featurePacks.contentJson. text (not
  // jsonb) for parity with the SQLite dialect; the handler JSON.parses
  // when consuming.
  contentJson: text('content_json'),
  // Phase F.2 — draft/published lifecycle. Default 'published' preserves
  // pre-Phase-F semantics.
  status: text('status').notNull().default('published'),
  // Phase G slice G.9 — multi-tenancy column. Nullable for backward
  // compat; Phase G+1 backfills + tightens. New writes should populate
  // from the verified Clerk JWT's org_id claim. See
  // packages/db/drizzle/postgres/0018_feature_packs_org_id.sql.
  orgId: text('org_id'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/**
 * Phase F.1 — features (2026-05-11) — postgres mirror.
 *
 * On-demand "skill recipe" rows (Anthropic Skills pattern). See
 * `./sqlite.ts::features` for the full design rationale.
 *
 * Cloud-side serves as the distribution channel in team mode — the
 * sync-daemon pushes local file changes to this table on every CLI
 * `feature add/edit/remove` and the team-rows-puller pulls cloud rows
 * back to teammate filesystems on its tick. Conflict resolution writes
 * `.cloud.md` sidecars when the local file mtime exceeds the cloud
 * row's `updated_at` AND the content differs (Phase F.2 semantics
 * shared across features + feature_packs).
 *
 * Status lifecycle gates agent visibility: only `status='published'`
 * rows reach the MCP `list_features` handler (Phase F.3 filter).
 *
 * Idempotency: UNIQUE(project_id, slug); the sync-daemon's
 * syncFeatures case uses ON CONFLICT (project_id, slug) DO UPDATE.
 */
export const features = pgTable(
  'features',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    slug: text('slug').notNull(),
    frontmatter: text('frontmatter').notNull(),
    body: text('body').notNull(),
    checksum: text('checksum').notNull(),
    status: text('status').notNull().default('draft'),
    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('features_project_slug_uk').on(t.projectId, t.slug),
    index('features_project_status_idx').on(t.projectId, t.status),
  ],
);

export const decisions = pgTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    // idempotency_key = `dec:{runId}:{sha256(description).slice(0,32)}`. Two
    // calls with the same runId + identical description collide on this
    // unique index and the second returns the first row's id — see
    // `apps/mcp-server/src/tools/record-decision/handler.ts`.
    idempotencyKey: text('idempotency_key').notNull().unique(),
    // run_id is nullable + ON DELETE SET NULL so decisions survive the
    // deletion of their originating run (decisions are permanent history;
    // parallels the run_events widening in migration 0002).
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    description: text('description').notNull(),
    rationale: text('rationale').notNull(),
    // JSON-encoded string[] ; NULL is treated as [] by the handler.
    // Stored as text on both dialects for parity — the handler does
    // JSON.parse/stringify, so Postgres gains nothing from JSONB here.
    alternatives: text('alternatives'),
    // Module 05 (2026-05-08 reshape) — structured intent fields. See
    // sqlite.ts decisions comment. NULL on legacy rows; idempotency key
    // unchanged (sha256 of description), so re-recording with new metadata
    // collapses to the original row.
    context: text('context'),
    impact: text('impact'),
    confidence: text('confidence'),
    reversible: boolean('reversible'),
    // Module 04 Phase 4 — see ./sqlite.ts::decisions.createdByUserId.
    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('decisions_run_created_idx').on(t.runId, t.createdAt)],
);

/**
 * Module 08b S1 — kill switches (postgres mirror of sqlite.ts::killSwitches).
 *
 * Same shape, dialect-appropriate timestamp columns. The schema-parity test
 * enforces that column names and Drizzle dataType categories match. See
 * `./sqlite.ts` for the full design rationale.
 */
export const killSwitches = pgTable(
  'kill_switches',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    target: text('target'),
    mode: text('mode').notNull().default('hard'),
    reason: text('reason').notNull(),
    pausedAt: timestamp('paused_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    pausedBySessionId: text('paused_by_session_id'),
    // Module 04 Phase 4 — see ./sqlite.ts::killSwitches.pausedByUserId.
    pausedByUserId: text('paused_by_user_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    resumedAt: timestamp('resumed_at', { withTimezone: true, mode: 'date' }),
    resumedBySessionId: text('resumed_by_session_id'),
    // Module 04 Phase 4 — see ./sqlite.ts::killSwitches.resumedByUserId.
    resumedByUserId: text('resumed_by_user_id'),
  },
  (t) => [
    // Mirror of the SQLite active-switch index. See sqlite.ts for the
    // hot-path rationale.
    index('kill_switches_active_idx').on(t.resumedAt, t.scope, t.target),
  ],
);

/**
 * Module 06 — run diffs (postgres mirror of sqlite.ts::runDiffs). See
 * ./sqlite.ts for the full design rationale, soft-failure shape, and
 * idempotency contract. Schema-parity test enforces column-name +
 * dataType + notNull match.
 */
export const runDiffs = pgTable(
  'run_diffs',
  {
    runId: text('run_id')
      .primaryKey()
      .references(() => runs.id, { onDelete: 'cascade' }),
    baseSha: text('base_sha'),
    headSha: text('head_sha'),
    unifiedDiff: text('unified_diff').notNull().default(''),
    filesChanged: text('files_changed').notNull().default('[]'),
    truncated: boolean('truncated').notNull().default(false),
    error: text('error'),
    generatedAt: timestamp('generated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('run_diffs_generated_at_idx').on(t.generatedAt)],
);

/**
 * Module 04 Phase 2 — `team_invites` (2026-05-11). See the SQLite
 * mirror in `./sqlite.ts` for the full design rationale; the column set
 * here is identical for the dual-dialect schema-parity test.
 *
 * Only ever populated on cloud Postgres in practice — `~/.coodra/data.db`
 * never holds an invite row because invite minting is a team-hosted
 * operation. The SQLite table exists for parity (test coverage + future
 * draft-invite use cases).
 */
export const teamInvites = pgTable(
  'team_invites',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    email: text('email').notNull(),
    role: text('role').notNull(),
    jti: text('jti').notNull().unique(),
    invitedByUserId: text('invited_by_user_id').notNull(),
    clerkInvitationId: text('clerk_invitation_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    usedByUserId: text('used_by_user_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedByUserId: text('revoked_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('team_invites_org_active_idx').on(t.orgId, t.usedAt, t.revokedAt),
    index('team_invites_email_idx').on(t.email),
  ],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type RunEvent = typeof runEvents.$inferSelect;
export type NewRunEvent = typeof runEvents.$inferInsert;
export type ContextPack = typeof contextPacks.$inferSelect;
export type NewContextPack = typeof contextPacks.$inferInsert;
export type PendingJob = typeof pendingJobs.$inferSelect;
export type NewPendingJob = typeof pendingJobs.$inferInsert;
export type Policy = typeof policies.$inferSelect;
export type NewPolicy = typeof policies.$inferInsert;
export type PolicyRule = typeof policyRules.$inferSelect;
export type NewPolicyRule = typeof policyRules.$inferInsert;
export type PolicyDecision = typeof policyDecisions.$inferSelect;
export type NewPolicyDecision = typeof policyDecisions.$inferInsert;
export type FeaturePack = typeof featurePacks.$inferSelect;
export type NewFeaturePack = typeof featurePacks.$inferInsert;
export type Feature = typeof features.$inferSelect;
export type NewFeature = typeof features.$inferInsert;
export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;
export type KillSwitch = typeof killSwitches.$inferSelect;
export type NewKillSwitch = typeof killSwitches.$inferInsert;
export type RunDiff = typeof runDiffs.$inferSelect;
export type NewRunDiff = typeof runDiffs.$inferInsert;
export type TeamInvite = typeof teamInvites.$inferSelect;
export type NewTeamInvite = typeof teamInvites.$inferInsert;

/**
 * Module 04 Phase 4 — `_migration_attempts`. **Postgres-only**; the
 * solo SQLite store has no use for this since migration moves data
 * solo→team, never team→solo at the data layer (`coodra team leave`
 * just clears local team config — it doesn't write a migration row).
 *
 * Tracks the lifecycle of each `coodra team migrate` invocation so:
 *   - A crashed migration can be **resumed** on the next CLI run by
 *     looking up `status='running'` for this (orgId, userId) and
 *     continuing from `last_phase`.
 *   - A failed migration can be **rolled back** by deleting all rows
 *     in `_migration_map` for `attempt_id` and undoing the cloud
 *     INSERTs they tracked.
 *   - Concurrent migrations from the same user are **prevented** at
 *     application level: the executor SELECTs `status='running'` for
 *     (orgId, userId) before INSERTing a new attempt; the second
 *     concurrent CLI sees the existing row and refuses.
 *
 * Schema-parity test does NOT cover this table because it has no
 * SQLite mirror (deliberate — see comment header). Future audits that
 * walk the schema must check for this exception.
 */
export const migrationAttempts = pgTable('_migration_attempts', {
  id: text('id').primaryKey(),
  clerkUserId: text('clerk_user_id').notNull(),
  clerkOrgId: text('clerk_org_id').notNull(),
  // Hostname of the source machine — for triage.
  sourceMachine: text('source_machine').notNull(),
  // 'running' | 'completed' | 'failed' | 'rolled_back'
  status: text('status').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  // Last successfully-completed phase, for resume. e.g. 'projects', 'runs',
  // 'children', 'org_scoped', 'verify', 'commit'.
  lastPhase: text('last_phase'),
  error: text('error'),
});

/**
 * Module 04 Phase 4 — `_migration_map`. Postgres-only. Per-attempt log
 * of every (table, old_id, new_id) tuple the executor wrote, so a
 * resume can skip already-migrated rows and a rollback can DELETE
 * exactly the cloud rows the failed attempt created.
 *
 * Composite primary key on (attempt_id, table_name, old_id). One row
 * per source-table source-id; the new_id is the cloud-side uuid the
 * executor minted (or the same id when the executor preserved it,
 * e.g. for runs where we keep the original `run:{projectId}:{...}`
 * shape per the §3.4 design decision).
 */
export const migrationMap = pgTable(
  '_migration_map',
  {
    attemptId: text('attempt_id')
      .notNull()
      .references(() => migrationAttempts.id, { onDelete: 'cascade' }),
    tableName: text('table_name').notNull(),
    oldId: text('old_id').notNull(),
    newId: text('new_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.attemptId, t.tableName, t.oldId] })],
);

export type MigrationAttempt = typeof migrationAttempts.$inferSelect;
export type NewMigrationAttempt = typeof migrationAttempts.$inferInsert;
export type MigrationMapEntry = typeof migrationMap.$inferSelect;
export type NewMigrationMapEntry = typeof migrationMap.$inferInsert;

/**
 * Module 10 — Deep Wiki (postgres mirror of sqlite.ts::wikis). Both
 * dialects hold rows: solo writes to local SQLite via the MCP tools;
 * team mode keeps cloud Postgres in sync via the sync-daemon so the
 * web `/wiki` render works cross-machine. See `./sqlite.ts::wikis` for
 * the full design rationale + idempotency contract. Schema-parity test
 * enforces column-name + dataType + notNull match.
 */
export const wikis = pgTable(
  'wikis',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    mode: text('mode').notNull().default('comprehensive'),
    schemaVersion: integer('schema_version').notNull().default(1),
    structureJson: text('structure_json').notNull(),
    generatedByRunId: text('generated_by_run_id').references(() => runs.id, { onDelete: 'set null' }),
    createdByUserId: text('created_by_user_id'),
    orgId: text('org_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('wikis_project_slug_uk').on(t.projectId, t.slug),
    index('wikis_project_updated_idx').on(t.projectId, t.updatedAt),
  ],
);

/**
 * Module 10 — Deep Wiki page rows (postgres mirror of
 * sqlite.ts::wikiPages). See `./sqlite.ts::wikiPages` for the full
 * design rationale (skeleton-then-author lifecycle, content/progress
 * store, citations JSON shape).
 */
export const wikiPages = pgTable(
  'wiki_pages',
  {
    id: text('id').primaryKey(),
    wikiId: text('wiki_id')
      .notNull()
      .references(() => wikis.id, { onDelete: 'cascade' }),
    pageId: text('page_id').notNull(),
    state: text('state').notNull().default('pending'),
    contentMarkdown: text('content_markdown').notNull().default(''),
    citations: text('citations').notNull().default('[]'),
    authoredByRunId: text('authored_by_run_id').references(() => runs.id, { onDelete: 'set null' }),
    createdByUserId: text('created_by_user_id'),
    orgId: text('org_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('wiki_pages_wiki_page_uk').on(t.wikiId, t.pageId),
    index('wiki_pages_wiki_state_idx').on(t.wikiId, t.state),
  ],
);

export type Wiki = typeof wikis.$inferSelect;
export type NewWiki = typeof wikis.$inferInsert;
export type WikiPageRow = typeof wikiPages.$inferSelect;
export type NewWikiPageRow = typeof wikiPages.$inferInsert;

/**
 * Phase F.3.c — `knowledge_audit` (2026-05-11). **Postgres-only**.
 *
 * Append-only audit log of every mutation to a knowledge artifact
 * (`features` or `feature_packs`). Captures the "who did what when" so
 * admins can answer:
 *   - "Why did this feature change?" → resource_id + action='update'
 *   - "Who hid this pack?" → resource_id + action='unpublish'
 *   - "What did Alice author this week?" → actor_user_id + created_at range
 *
 * Cloud-only: there's no SQLite mirror because audits are a team-mode
 * concern. Solo machines have no audience to audit toward. The
 * schema-parity test EXEMPTS this table — future audits checking
 * dialect drift must keep that exemption documented (search for
 * "knowledge_audit" in `__tests__/unit/schema-parity.test.ts`).
 *
 * Append-only enforced at the ORM layer: writers only call `INSERT`.
 * No UPDATE / DELETE codepath exists in the application. Cloud
 * Postgres permissions tighten this further (Phase F.4 ops note).
 *
 * Resource_type / action are CHECK-constrained at the DB level:
 *   - resource_type ∈ { 'feature', 'feature_pack' }
 *   - action        ∈ { 'create', 'update', 'publish', 'unpublish', 'delete' }
 *
 * Before / after checksum capture the content-shape transition: create
 * has before=null; delete has after=null; update has both; publish /
 * unpublish typically have before=after (the content didn't change,
 * only visibility).
 */
export const knowledgeAudit = pgTable(
  'knowledge_audit',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    action: text('action').notNull(),
    actorUserId: text('actor_user_id').notNull(),
    beforeChecksum: text('before_checksum'),
    afterChecksum: text('after_checksum'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('knowledge_audit_resource_idx').on(t.orgId, t.resourceType, t.resourceId, t.createdAt),
    index('knowledge_audit_org_recent_idx').on(t.orgId, t.createdAt),
  ],
);

export type KnowledgeAudit = typeof knowledgeAudit.$inferSelect;
export type NewKnowledgeAudit = typeof knowledgeAudit.$inferInsert;
