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
  // Absolute filesystem path of the project root (where .coodra.json lives).
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
    // Module 06 (Run Diff, 2026-05-09). Git HEAD SHA captured at SessionStart
    // by the bridge (see apps/hooks-bridge/src/lib/capture-base-sha.ts). NULL
    // when the project is not a git repo, when `git rev-parse HEAD` failed,
    // or when SessionStart fired before this column shipped. The SessionEnd
    // run-diff runner uses this as the diff baseline; a NULL baseSha causes
    // the run-diff row to be written with `error = 'no_base_sha'`.
    baseSha: text('base_sha'),
    // Team mode (Module 04 Phase 4, 2026-05-09). Clerk user id of the
    // human running the agent session. Solo mode rows have NULL; team
    // mode rows are stamped at SessionStart by the bridge after reading
    // ~/.coodra/config.json::clerk_user_id. Used by the web app's
    // member-attribution badges and the audit log; never used for
    // authorization (Clerk JWT is the auth-of-record, this is the
    // historical-record-of-actor).
    createdByUserId: text('created_by_user_id'),
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
    // Team mode (Module 04 Phase 4, 2026-05-09). Clerk user id of the
    // member who saved the pack. NULL on solo + bridge_auto rows where
    // no human identity exists. The MCP `save_context_pack` tool reads
    // this from `~/.coodra/config.json` via the actor identity layer.
    createdByUserId: text('created_by_user_id'),
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
  // Team mode (Module 04 Phase 4, 2026-05-09). Clerk user id of the
  // admin who created/last-edited this policy. NULL on solo. Surfaced
  // in the web admin's "created by" badge.
  createdByUserId: text('created_by_user_id'),
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
  // Team mode (Module 04 Phase 4, 2026-05-09). Clerk user id of the
  // admin who pushed the latest revision via the web pack uploader.
  // NULL when the pack landed via git (filesystem-walked) or solo mode.
  createdByUserId: text('created_by_user_id'),
  // Phase F.2 (2026-05-11) — JSON envelope of the four canonical pack
  // files so cloud Postgres carries the pack content across teammate
  // machines. Shape:
  //   { spec: string, implementation: string, techstack: string,
  //     meta: <meta.json parsed>, sourceFiles: string[] }
  // Nullable for backwards compat: pre-Phase-F rows landed via the
  // filesystem walker have content on disk only and this column NULL.
  // The sync-daemon's syncFeaturePacks dispatch case populates this
  // on every web/CLI publish; team-rows-puller renders it back to
  // disk on remote machines.
  contentJson: text('content_json'),
  // Phase F.2 — draft/published lifecycle. 'published' = agent-visible
  // (MCP `get_feature_pack` returns it). 'draft' = web-author-visible
  // only. Default 'published' preserves pre-Phase-F semantics where
  // every pack was reachable by the agent.
  status: text('status').notNull().default('published'),
  // Phase G slice G.9 — multi-tenancy column. Local SQLite is single-
  // tenant per laptop (one ~/.coodra = one active org) so this is
  // informational on the laptop side. The cloud sync includes it for
  // org-scoped reads. Nullable for backward compat; Phase G+1 tightens.
  // See packages/db/drizzle/sqlite/0016_feature_packs_org_id.sql.
  orgId: text('org_id'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

/**
 * Phase F.1 — features (2026-05-11).
 *
 * On-demand "skill recipe" rows (Anthropic Skills pattern). The agent
 * lists frontmatter via `coodra__list_features` at SessionStart and
 * pulls the full body via `coodra__get_feature` ONLY when a user
 * prompt matches the trigger. This is the pull-on-trigger layer that
 * complements feature_packs' push-at-SessionStart module blueprints.
 *
 * Solo mode: `docs/features/<slug>/feature.md` on disk is canonical.
 * Team mode: cloud Postgres is the distribution channel; sync-daemon
 * round-trips file ↔ cloud (with `.cloud.md` conflict sidecars for
 * concurrent edits). Files stay primary for authoring.
 *
 * Status lifecycle (Phase F.3): `'draft'` (visible in web UI to author +
 * admins only; NOT returned by MCP `list_features`) → `'published'`
 * (visible to all teammates + agents). The MCP handler filters on
 * `status='published'` so unfinished drafts never reach an agent.
 *
 * `created_by_user_id` — Clerk user_id of the author. NULL on rows
 * ingested from disk by the sync-daemon's filesystem walker (no human
 * identity available) and on solo-mode rows.
 *
 * Idempotency: UNIQUE(project_id, slug). Sync-daemon dispatch case keys
 * cloud writes by (project_id, slug) so file → cloud round-trips
 * collapse cleanly.
 *
 * Storage shape — frontmatter and body live in separate text columns so
 * the `list_features` response can SELECT only frontmatter (small) and
 * leave the body (potentially many KB per row) for the on-demand
 * `get_feature` fetch.
 */
export const features = sqliteTable(
  'features',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    slug: text('slug').notNull(),
    // YAML or JSON-encoded frontmatter (description, trigger,
    // whenNotToUse, maturity). The CLI's writer keeps this in YAML for
    // round-trip with the on-disk feature.md; the web app may write
    // JSON-encoded for editor convenience. The handler tolerates both.
    frontmatter: text('frontmatter').notNull(),
    // The feature.md body (markdown). Excludes the frontmatter block.
    body: text('body').notNull(),
    // sha256(frontmatter || body) — used by the sync-daemon to short-
    // circuit no-op syncs and by the MCP handler to dedupe redundant
    // file-walker upserts.
    checksum: text('checksum').notNull(),
    // 'draft' | 'published'. MCP filters on status='published'.
    status: text('status').notNull().default('draft'),
    createdByUserId: text('created_by_user_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('features_project_slug_uk').on(t.projectId, t.slug),
    index('features_project_status_idx').on(t.projectId, t.status),
  ],
);

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
    // Team mode (Module 04 Phase 4, 2026-05-09). Clerk user id of the
    // member whose agent recorded the decision. NULL on solo + on
    // pre-Phase-4 rows. The MCP `record_decision` tool reads this from
    // `~/.coodra/config.json` via the actor identity layer.
    createdByUserId: text('created_by_user_id'),
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
 * `mode` defaults to `'hard'` per OQ-1 lock — `coodra pause` with
 * no `--mode` flag yields a deny-on-match switch. Soft mode causes
 * the bridge to allow the event but record an audit row marked
 * `kill_switch_paused:<id>`.
 *
 * Soft-resume semantics: the row is never deleted. `coodra resume`
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
    // Team mode (Module 04 Phase 4, 2026-05-09). Clerk user id of the
    // admin who paused. NULL on solo. Used in admin tables and the
    // "resume your own pause" RBAC rule.
    pausedByUserId: text('paused_by_user_id'),
    // null = no auto-expiry; bridge treats `expires_at < now()` as already-resumed.
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    // null = active; set by `coodra resume` (soft delete).
    resumedAt: integer('resumed_at', { mode: 'timestamp' }),
    resumedBySessionId: text('resumed_by_session_id'),
    // Team mode (Module 04 Phase 4, 2026-05-09). Clerk user id of the
    // member who resumed. Members can resume their own pauses; admins
    // can resume anyone's. NULL while the switch is active.
    resumedByUserId: text('resumed_by_user_id'),
  },
  (t) => [
    // Active-switch lookup is the bridge's hot path (cached 5s; query budget
    // is well within the §6 / §16-pattern-4 50ms PreToolUse latency budget).
    // Leading column `resumed_at` partitions active vs audit history;
    // (scope, target) drives the per-event match.
    index('kill_switches_active_idx').on(t.resumedAt, t.scope, t.target),
  ],
);

/**
 * Module 06 (Run Diff, 2026-05-09).
 *
 * One row per run, written by the hooks-bridge SessionEnd handler after
 * the run is marked completed and before the auto-context-pack save. The
 * row carries a `git diff <runs.base_sha>` scoped to the file paths the
 * agent touched in `run_events` (Edit / Write / MultiEdit tool calls).
 *
 * Soft-failure shape — every row always lands so consumers (auto-pack,
 * MCP tool, web view) have something to read:
 *   - `error = 'no_base_sha'`     — SessionStart didn't capture a HEAD
 *                                   (non-git repo, capture failed, or
 *                                   pre-2026-05-09 run).
 *   - `error = 'no_edits_in_run'` — agent ran but had no Edit/Write
 *                                   tool calls; nothing to diff.
 *   - `error = 'git_diff_failed'` — `git diff` subprocess errored
 *                                   (broken repo, missing object, etc).
 *                                   Detail in `unified_diff` (kept as
 *                                   the truncated stderr for triage).
 *   - `error = NULL`              — diff captured successfully.
 *
 * `truncated = true` means the diff exceeded MAX_UNIFIED_DIFF_BYTES and
 * was clipped at a clean line boundary; the MCP tool surfaces this so
 * the agent can choose whether to read the file directly.
 *
 * Cascade-on-delete on `run_id` — deleting a run wipes its diff row.
 * No analog of context_packs' append-only constraint: a re-run of the
 * SessionEnd diff runner over the same `runId` is treated as an idempotent
 * upsert (DELETE + INSERT in one transaction) so a re-played hook event
 * produces a clean row, not a stale-from-first-attempt one.
 */
export const runDiffs = sqliteTable(
  'run_diffs',
  {
    runId: text('run_id')
      .primaryKey()
      .references(() => runs.id, { onDelete: 'cascade' }),
    // Snapshot of `runs.base_sha` at the time the diff was generated.
    // Mirrored here so the diff row stays interpretable even if the
    // runs row is updated. NULL only when error='no_base_sha'.
    baseSha: text('base_sha'),
    // git rev-parse HEAD at SessionEnd time. NULL when non-git or when
    // base_sha is null (no diff was attempted).
    headSha: text('head_sha'),
    // Unified `git diff` output, scoped to files the agent touched.
    // Empty string when error='no_edits_in_run' or 'no_base_sha'.
    // Capped at MAX_UNIFIED_DIFF_BYTES; truncated=true signals overflow.
    unifiedDiff: text('unified_diff').notNull().default(''),
    // JSON-encoded array of { path, status: 'added'|'modified'|'deleted',
    // additions: number, deletions: number } from `git diff --numstat`
    // + `git diff --name-status`. Default '[]' for the soft-failure rows.
    filesChanged: text('files_changed').notNull().default('[]'),
    truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
    error: text('error'),
    generatedAt: integer('generated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [index('run_diffs_generated_at_idx').on(t.generatedAt)],
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
export type RunDiff = typeof runDiffs.$inferSelect;
export type NewRunDiff = typeof runDiffs.$inferInsert;
export type KillSwitch = typeof killSwitches.$inferSelect;
export type NewKillSwitch = typeof killSwitches.$inferInsert;

/**
 * Module 04 Phase 2 — `team_invites` (2026-05-11). The single durable
 * record per teammate invitation an admin mints from /settings/team in
 * `team-hosted` mode. A row is created when the admin clicks "Invite
 * teammate"; the row is read on every `/install/[token]` page render and
 * every `POST /api/install/[token]` redemption to enforce single-use +
 * expiry + revocation; the row is updated on successful CLI redemption
 * (`used_at`, `used_by_user_id`) or on admin revoke (`revoked_at`,
 * `revoked_by_user_id`).
 *
 * **Dual-dialect parity** is intentional even though only cloud Postgres
 * ever holds rows. The reasons are:
 *   1. The dual-dialect schema-parity test (`__tests__/unit/schema-parity.test.ts`)
 *      enforces structural identity for "shared" tables. `team_invites`
 *      conceptually belongs to that set because the SQLite primary store
 *      could one day hold per-laptop invitation drafts; keeping the
 *      schemas identical avoids retrofit pain.
 *   2. Tests that exercise invite minting / redemption against an
 *      in-memory SQLite (faster than testcontainers Postgres) can use
 *      the same Drizzle querybuilder code paths.
 *
 * Single-use guarantee:
 *   - `jti` is UNIQUE — duplicate JWT IDs are rejected at the DB.
 *   - Redemption is `UPDATE … SET used_at = now() WHERE jti = $1 AND
 *     used_at IS NULL AND revoked_at IS NULL RETURNING *` — exactly one
 *     concurrent caller wins.
 *
 * Revocation:
 *   - Admin click on /settings/team → `revoked_at = now()`,
 *     `revoked_by_user_id = <admin clerk user_id>`. Redemption then 410s.
 *
 * Clerk coupling:
 *   - `clerk_invitation_id` records the Clerk organization invitation we
 *     created via `clerkClient.invitations.createInvitation` so the
 *     revoke action can also revoke the Clerk-side invitation in the
 *     same atomic operation.
 *
 * Bundle delivery (caveat A — security):
 *   - The CLI bundle returned by `POST /api/install/[token]` carries
 *     `LOCAL_HOOK_SECRET` + `DATABASE_URL` (for sync-daemon push) +
 *     identity claims — NOT Clerk admin keys. The bundle is generated
 *     from server env vars per redeem, not stored in this table.
 *
 * Audit trail:
 *   - `invited_by_user_id` + `created_at` capture "who minted, when".
 *   - `used_by_user_id` + `used_at` capture "who redeemed, when".
 *   - `revoked_by_user_id` + `revoked_at` capture "who killed it, when".
 *
 * The SQLite dialect uses `integer({ mode: 'timestamp' })` for all
 * timestamps so the schema-parity test sees identical Drizzle dataType
 * categories against Postgres's `timestamp with time zone`.
 */
export const teamInvites = sqliteTable(
  'team_invites',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    email: text('email').notNull(),
    // 'admin' | 'member' | 'viewer' — matches ADR-014 Tier 2.5 roles.
    role: text('role').notNull(),
    // JWT ID embedded in the signed token payload. UNIQUE for single-use
    // enforcement at the DB layer (last line of defense behind the
    // CONDITIONAL UPDATE in the redeem endpoint).
    jti: text('jti').notNull().unique(),
    // Clerk user_id of the admin who minted this invitation.
    invitedByUserId: text('invited_by_user_id').notNull(),
    // The Clerk organization-invitation id created via
    // `clerkClient.invitations.createInvitation`. Captured so /settings/team
    // revoke can also revoke the Clerk-side invitation atomically.
    // Nullable for two reasons: (a) admin may mint an invite for an
    // email Clerk refuses (already a member of another org), in which
    // case the local row still exists for tracking but with no Clerk
    // invitation; (b) future "copy-link only" flow can skip the Clerk
    // notify step.
    clerkInvitationId: text('clerk_invitation_id'),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    usedAt: integer('used_at', { mode: 'timestamp' }),
    usedByUserId: text('used_by_user_id'),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
    revokedByUserId: text('revoked_by_user_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    // Pending-invite list query — admin's /settings/team renders
    // WHERE org_id = ? AND used_at IS NULL AND revoked_at IS NULL.
    index('team_invites_org_active_idx').on(t.orgId, t.usedAt, t.revokedAt),
    // Email-bound invite lookup for the page that previews an invite
    // before redemption (caveat B — the redeemer must be signed in as
    // the invited email).
    index('team_invites_email_idx').on(t.email),
  ],
);

export type TeamInvite = typeof teamInvites.$inferSelect;
export type NewTeamInvite = typeof teamInvites.$inferInsert;

/**
 * Module 10 — Deep Wiki (2026-06-06). `wikis` holds the structure pass:
 * one row per generated wiki, keyed `(project_id, slug)`. `structure_json`
 * is the `WikiStructure` envelope (title/description/mode + the full
 * page+section hierarchy) validated by `@coodra/shared/wiki`'s
 * `wikiStructureSchema` at the MCP boundary before it lands here.
 *
 * Regeneration semantics: `wiki_save_structure` upserts by
 * `(project_id, slug)` — re-planning the same wiki replaces the row's
 * structure and DELETE-then-INSERTs its `wiki_pages` skeleton in one
 * transaction (parallels `run_diffs`' DELETE-then-INSERT idempotency;
 * a re-plan legitimately supersedes a prior incomplete attempt).
 *
 * `generated_by_run_id` is the run that produced the structure (ON
 * DELETE SET NULL — the wiki outlives its originating session, like
 * decisions). `created_by_user_id` / `org_id` carry team attribution +
 * multi-tenancy (NULL on solo; populated from the verified Clerk JWT in
 * team mode), mirroring `feature_packs`.
 */
export const wikis = sqliteTable(
  'wikis',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    // 'comprehensive' | 'concise' — see @coodra/shared/wiki wikiModeSchema.
    mode: text('mode').notNull().default('comprehensive'),
    // WIKI_SCHEMA_VERSION at write time. Lets a future reader migrate
    // an old structure envelope shape forward.
    schemaVersion: integer('schema_version').notNull().default(1),
    // JSON-encoded WikiStructure (sections + page metadata). text on both
    // dialects for parity; the handler JSON.parses via wikiStructureSchema.
    structureJson: text('structure_json').notNull(),
    generatedByRunId: text('generated_by_run_id').references(() => runs.id, { onDelete: 'set null' }),
    createdByUserId: text('created_by_user_id'),
    orgId: text('org_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('wikis_project_slug_uk').on(t.projectId, t.slug),
    index('wikis_project_updated_idx').on(t.projectId, t.updatedAt),
  ],
);

/**
 * Module 10 — Deep Wiki page rows (the content pass). One row per page
 * in the parent wiki's structure. `wiki_save_structure` inserts the full
 * skeleton (every page `state='pending'`, empty body); `wiki_save_page`
 * flips a row to `state='authored'` with its Markdown body + citations.
 *
 * The render reads page metadata (title/importance/parentId/relevantFiles)
 * from `wikis.structure_json` and joins these rows by `page_id` for state
 * + body — so structure stays single-sourced and these rows are the
 * content/progress store. `wiki_status` (and the CLI) derive "X / Y
 * authored" from `state` counts here.
 *
 * `citations` is a JSON-encoded array of `{ file, startLine?, endLine? }`
 * (default '[]'). `authored_by_run_id` (ON DELETE SET NULL) records which
 * session authored the body. UNIQUE(wiki_id, page_id) makes re-authoring
 * a page an idempotent overwrite. ON DELETE CASCADE on `wiki_id` wipes a
 * wiki's pages when the wiki is deleted / regenerated.
 */
export const wikiPages = sqliteTable(
  'wiki_pages',
  {
    id: text('id').primaryKey(),
    wikiId: text('wiki_id')
      .notNull()
      .references(() => wikis.id, { onDelete: 'cascade' }),
    // The stable page id from the parent structure's `pages[].id`.
    pageId: text('page_id').notNull(),
    // 'pending' | 'authored' — see @coodra/shared/wiki wikiPageStateSchema.
    state: text('state').notNull().default('pending'),
    contentMarkdown: text('content_markdown').notNull().default(''),
    // JSON-encoded WikiCitation[]; '[]' when the page has none / is pending.
    citations: text('citations').notNull().default('[]'),
    authoredByRunId: text('authored_by_run_id').references(() => runs.id, { onDelete: 'set null' }),
    createdByUserId: text('created_by_user_id'),
    orgId: text('org_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
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
