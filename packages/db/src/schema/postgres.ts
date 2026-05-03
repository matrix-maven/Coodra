import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, vector } from 'drizzle-orm/pg-core';

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
    summaryEmbedding: vector('summary_embedding', { dimensions: 384 }),
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
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

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
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    resumedAt: timestamp('resumed_at', { withTimezone: true, mode: 'date' }),
    resumedBySessionId: text('resumed_by_session_id'),
  },
  (t) => [
    // Mirror of the SQLite active-switch index. See sqlite.ts for the
    // hot-path rationale.
    index('kill_switches_active_idx').on(t.resumedAt, t.scope, t.target),
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
export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;
export type KillSwitch = typeof killSwitches.$inferSelect;
export type NewKillSwitch = typeof killSwitches.$inferInsert;
