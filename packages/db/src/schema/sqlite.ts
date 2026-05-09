import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * SQLite schema — solo-mode primary store (`system-architecture.md` §4.1).
 *
 * Ten tables total after Module 02:
 *   - Module-01 core (append-only where noted in §4.3):
 *     projects, runs, run_events, context_packs, pending_jobs
 *   - Module-02 additions:
 *     policies, policy_rules, policy_decisions (append-only),
 *     feature_packs, decisions (append-only, idempotent on
 *     `dec:{runId}:{sha256(description)}`)
 *
 * Every timestamp column uses `integer({ mode: 'timestamp' })` so Drizzle
 * returns `Date` instances; the underlying storage is Unix seconds. Every
 * boolean column uses `integer({ mode: 'boolean' })` which stores 0/1 but
 * maps to JS boolean at the ORM layer; this keeps the schema-parity test
 * green against Postgres's native `boolean` type (Drizzle reports the same
 * `dataType: 'boolean'` for both).
 *
 * `context_packs.summary_embedding` is `text` here — the sqlite-vec
 * virtual table `context_packs_vec` shipped in Module 02 holds the real
 * vector and is created by a hand-appended SQL block in migration 0001
 * (sha256-locked per `packages/db/migrations.lock.json`). The Postgres
 * dialect keeps `vector(384)` on the main table with an HNSW index.
 * The schema-parity test allows this single intentional dialect drift.
 *
 * `context_packs.content_excerpt` is populated at save time by
 * `save_context_pack` with the first 500 Unicode code points of
 * `content` (trailing whitespace trimmed). Powers the `search_packs_nl`
 * LIKE fallback when `summary_embedding` is still NULL (pre-Module-05).
 */

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  orgId: text('org_id').notNull(),
  name: text('name').notNull(),
  // Absolute filesystem path of the project root (where .contextos.json lives).
  // Recorded by the bridge on first SessionStart from a registered cwd, and by
  // the CLI's `init` command. Nullable for back-compat — pre-2026-05-08 rows
  // have no recorded cwd; consumers must fall back to process.cwd() in that
  // case. Used by the web app's pack uploader to write into the project's own
  // `<cwd>/docs/feature-packs/<slug>/` instead of the web-v2 server's cwd.
  cwd: text('cwd'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

export const runs = sqliteTable(
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
    startedAt: integer('started_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    endedAt: integer('ended_at', { mode: 'timestamp' }),
  },
  (t) => [uniqueIndex('runs_project_session_idx').on(t.projectId, t.sessionId), index('runs_status_idx').on(t.status)],
);

export const runEvents = sqliteTable(
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
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [index('run_events_run_created_idx').on(t.runId, t.createdAt)],
);

export const contextPacks = sqliteTable(
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
    // Module 05 (2026-05-08 reshape): kept here through 0009 migration so
    // the dialect schemas stay aligned; 0010_drop_embeddings.sql removes
    // it. New code does not write this column. Will be NULL on every row
    // post-reshape until the column is dropped.
    summaryEmbedding: text('summary_embedding'),
    // Module 05 — provenance of the pack. 'agent' = explicit MCP call;
    // 'bridge_auto' = bridge's Pattern-20 auto-save fallback. The two
    // collide on the unique (run_id) index — the tool's handler upgrades
    // 'bridge_auto' rows to 'agent' when an explicit call lands second
    // (single ADR-007 relaxation, narrow + documented).
    source: text('source').notNull().default('agent'),
    // Module 05 — agent-curated metadata. JSON-encoded text on both
    // dialects for parity. Shape (validated at the tool boundary, not the
    // schema): { decisionIds?, affectedFiles?, testStatus?, openTodos? }.
    // NULL when the caller didn't supply any.
    meta: text('meta'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('context_packs_run_idx').on(t.runId),
    index('context_packs_project_created_idx').on(t.projectId, t.createdAt),
  ],
);

export const pendingJobs = sqliteTable(
  'pending_jobs',
  {
    id: text('id').primaryKey(),
    queue: text('queue').notNull(),
    payload: text('payload').notNull(),
    attempts: integer('attempts').notNull().default(0),
    // 'pending' | 'picked' | 'dead'. Module 03.1 outbox lifecycle.
    status: text('status').notNull().default('pending'),
    runAfter: integer('run_after', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    // Lease bookkeeping (Module 03.1). Set when status flips to 'picked';
    // an in-flight row whose pickedAt is older than leaseMs is treated as
    // orphaned and reclaimable by another worker (lease serialization).
    pickedAt: integer('picked_at', { mode: 'timestamp' }),
    // Set when the worker exhausts maxAttempts (status='dead').
    failedAt: integer('failed_at', { mode: 'timestamp' }),
    // Last dispatch error string. Retained on dead rows for the doctor
    // dead-letter check and any future audit-trail UI.
    lastError: text('last_error'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index('pending_jobs_poll_idx').on(t.queue, t.status, t.runAfter),
    // Fast orphan recovery: status='picked' rows ordered by pickedAt
    // surface lease-expired rows for reclaim without a full scan.
    index('pending_jobs_picked_idx').on(t.status, t.pickedAt),
  ],
);

export const policies = sqliteTable('policies', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  name: text('name').notNull(),
  description: text('description'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

export const policyRules = sqliteTable(
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
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index('policy_rules_policy_priority_idx').on(t.policyId, t.priority),
    // Slice 7 (2026-05-03 audit §14.2): backstops ensureDefaultPolicy's
    // application-layer idempotency. Pre-Slice-7 the table had no UNIQUE
    // constraint, so any raw INSERT (presentation/setup.sh's pre-Fix-F
    // hand-rolled block, future admin commands, debugging sessions) could
    // introduce duplicate rows. Slice 6 deletes the setup.sh inserter;
    // Slice 7 makes the schema enforce what ensureDefaultPolicy already
    // checks via WHERE NOT EXISTS so the invariant survives even when
    // the application layer is bypassed.
    uniqueIndex('policy_rules_dedup_uk').on(t.policyId, t.priority, t.matchEventType, t.matchToolName, t.matchPathGlob),
  ],
);

export const policyDecisions = sqliteTable(
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
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [index('policy_decisions_session_idx').on(t.sessionId, t.createdAt)],
);

export const featurePacks = sqliteTable('feature_packs', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  parentSlug: text('parent_slug'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  checksum: text('checksum').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

export const decisions = sqliteTable(
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
    // Module 05 (2026-05-08 reshape) — structured intent fields. All
    // optional; NULL on legacy rows written before M05 landed. The
    // idempotency key (sha256 of description) does NOT include these
    // — same description re-recorded with different metadata collapses
    // to the first row. Update semantics are out of M05's scope.
    // What triggered this decision (user request, error, design review).
    context: text('context'),
    // JSON-encoded string[] of affected modules / API surfaces / files.
    impact: text('impact'),
    // 'high' | 'medium' | 'low' | NULL (legacy rows have NULL = unknown).
    confidence: text('confidence'),
    // Boolean stored as integer per better-sqlite3 convention; NULL = unknown.
    reversible: integer('reversible', { mode: 'boolean' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [index('decisions_run_created_idx').on(t.runId, t.createdAt)],
);

/**
 * Module 08b S1 — kill switches.
 *
 * Polymorphic `(scope, target)` shape per OQ-2 lock (2026-05-03).
 * `scope` is one of `'global' | 'project' | 'tool' | 'agent_type'`;
 * `target` is null when scope='global' and otherwise carries the
 * scope's value (projectId / toolName / agentType). Adding a fifth
 * scope is a one-line CHECK-constraint update — no schema migration.
 *
 * `mode` defaults to `'hard'` per OQ-1 lock — `contextos pause` with
 * no `--mode` flag yields a deny-on-match switch. Soft mode causes
 * the bridge to allow the event but record an audit row marked
 * `kill_switch_paused:<id>`.
 *
 * Soft-resume semantics: the row is never deleted. `contextos resume`
 * sets `resumed_at` + `resumed_by_session_id` so the row remains as
 * audit history (parallels ADR-007's append-only spirit for decisions
 * and context_packs). The active-switch query is
 *   `WHERE resumed_at IS NULL AND (expires_at IS NULL OR expires_at > now())`
 * which is what the bridge runs on every PreToolUse (cached for 5s).
 *
 * Local-only in M08b per OQ-8: no sync-daemon enqueue. The cross-
 * developer admin surface lands in M04.
 */
export const killSwitches = sqliteTable(
  'kill_switches',
  {
    id: text('id').primaryKey(),
    // 'global' | 'project' | 'tool' | 'agent_type' — see OQ-2 (polymorphic).
    scope: text('scope').notNull(),
    // null when scope='global'; projectId / toolName / agentType otherwise.
    target: text('target'),
    // 'hard' (bridge denies on match) | 'soft' (bridge allows + audits). OQ-1: default = hard.
    mode: text('mode').notNull().default('hard'),
    reason: text('reason').notNull(),
    pausedAt: integer('paused_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    // null when CLI-initiated (no session); set if the bridge ever flips a switch programmatically (post-M08b).
    pausedBySessionId: text('paused_by_session_id'),
    // null = no auto-expiry; bridge treats `expires_at < now()` as already-resumed.
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    // null = active; set by `contextos resume` (soft delete).
    resumedAt: integer('resumed_at', { mode: 'timestamp' }),
    resumedBySessionId: text('resumed_by_session_id'),
  },
  (t) => [
    // Active-switch lookup is the bridge's hot path (cached 5s; query budget
    // is well within the §6 / §16-pattern-4 50ms PreToolUse latency budget).
    // Leading column `resumed_at` partitions active vs audit history;
    // (scope, target) drives the per-event match.
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
