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
 *     decisions (append-only, idempotent on
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
  // Absolute filesystem path of the project root (where .coodra/config.json lives).
  // Recorded by the bridge on first SessionStart from a registered cwd, and by
  // the CLI's `init` command. Nullable for older rows with no recorded cwd.
  cwd: text('cwd'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    sessionId: text('session_id').notNull(),
    agentType: text('agent_type').notNull(),
    mode: text('mode').notNull(),
    status: text('status').notNull().default('in_progress'),
    issueRef: text('issue_ref'),
    prRef: text('pr_ref'),
    // COOD-12 smart work sessions. Nullable so normal sessions remain
    // project-scoped; set when a run is actively implementing a Work Pack.
    workPackId: text('work_pack_id'),
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
    // Claude Code hook coverage expansion (2026-08-04). Set the first
    // time PreCompact blocks compaction to nudge the agent to save
    // unsaved decisions/context before the wipe (see
    // apps/mcp-server/src/tools/lifecycle-event/handler.ts). NULL means
    // "not yet nudged this run" — a subsequent PreCompact call for the
    // same run allows compaction unconditionally rather than blocking
    // repeatedly.
    compactionNudgedAt: integer('compaction_nudged_at', { mode: 'timestamp' }),
    /**
     * COOD-84 — compaction generation counter.
     *
     * Incremented on every compaction. Injected context is a disposable
     * hint, not durable truth: a compaction may drop or summarise away
     * everything Coodra surfaced, so a delta computed against the
     * pre-compaction baseline would reference blocks the agent no
     * longer holds. Generations make the baseline explicit, so a delta
     * is always relative to a window that still exists.
     */
    baselineGeneration: integer('baseline_generation').notNull().default(0),
    // COOD-34 — explicit capability context for policy matching. JSON text
    // with an array/object shape owned by the policy layer; default keeps
    // legacy runs capability-free without NULL checks.
    activeCapabilitiesJson: text('active_capabilities_json').notNull().default('[]'),
  },
  (t) => [uniqueIndex('runs_project_session_idx').on(t.projectId, t.sessionId), index('runs_status_idx').on(t.status)],
);

export const runEvents = sqliteTable(
  'run_events',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id').references(() => projects.id),
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
    orgId: text('org_id'),
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
    // 'bridge_auto' = bridge's Pattern-20 auto-save fallback. Historically
    // the two collided on a unique (run_id) index and the tool's handler
    // upgraded 'bridge_auto' rows to 'agent' when an explicit call landed
    // second (ADR-007 relaxation). Append-only redesign (2026-08-05):
    // context_packs is no longer one-row-per-run (see run_idx below) — the
    // upgrade-in-place behavior is now narrowed to specifically the most
    // recent row for a run, not "any" row; see context-pack.ts::write().
    source: text('source').notNull().default('agent'),
    // Module 05 — agent-curated metadata. JSON-encoded text on both
    // dialects for parity. Shape (validated at the tool boundary, not the
    // schema): { decisionIds?, affectedFiles?, testStatus?, openTodos? }.
    // NULL when the caller didn't supply any.
    meta: text('meta'),
    // Nullable link to the Work Pack this recap belongs to. Kept as text
    // because context_packs is declared before work_packs in this module.
    workPackId: text('work_pack_id'),
    // Team mode (Module 04 Phase 4, 2026-05-09). Clerk user id of the
    // member who saved the pack. NULL on solo + bridge_auto rows where
    // no human identity exists. The MCP `save_context_pack` tool reads
    // this from `~/.coodra/config.json` via the actor identity layer.
    createdByUserId: text('created_by_user_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    // Append-only redesign (2026-08-05) — see context-pack.ts::write() and
    // migration 0026_context_packs_append_only. Soft-governed (free text,
    // not a hard enum/CHECK — same rationale as work_packs.packType, so a
    // future kind doesn't require a Coodra code change). Recommended
    // values: 'sync' | 'work_start' | 'implementation_recap' |
    // 'audit_findings' | 'final_recap' | 'bridge_auto'. Deliberately
    // provider-neutral ('sync', not 'jira_sync') — which external
    // provider a sync came from lives on the linked Work Pack's own
    // source.provider, one join away, not duplicated here. NULL when the
    // caller didn't supply one.
    kind: text('kind'),
    // Soft-governed (free text). Recommended values: 'high' | 'medium' |
    // 'low'. NULL when the caller didn't supply one.
    importance: text('importance'),
    // COOD-59 — non-destructive consolidation pointer. When a future lazy
    // compaction job summarizes a cold batch into a digest Context Pack,
    // original rows stay readable and point at that digest instead of being
    // deleted or rewritten.
    archivedInPackId: text('archived_in_pack_id'),
  },
  (t) => [
    // Append-only redesign (2026-08-05): was uniqueIndex(run_idx) — a run
    // could hold exactly one Context Pack, and a second save on the same
    // run silently no-op'd regardless of content (the actual bug this
    // migration fixes — see context-pack.ts::write()). Now a plain index:
    // a run can accumulate many Context Packs, one per unit of work
    // touched in that session, each optionally linked to a Work Pack via
    // workPackId. Retry-safety (an identical re-call not duplicating a
    // row) is now handled in application code by an exact-content match,
    // not by this constraint.
    index('context_packs_run_idx').on(t.runId),
    index('context_packs_project_created_idx').on(t.projectId, t.createdAt),
    index('context_packs_work_pack_idx').on(t.workPackId, t.createdAt),
    index('context_packs_archived_in_pack_idx').on(t.archivedInPackId),
  ],
);

export const pendingJobs = sqliteTable(
  'pending_jobs',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id'),
    runId: text('run_id'),
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
  orgId: text('org_id'),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  name: text('name').notNull(),
  description: text('description'),
  groupKey: text('group_key').notNull().default('agent_guardrails'),
  profile: text('profile').notNull().default('default'),
  enforcementMode: text('enforcement_mode').notNull().default('detective'),
  // COOD-34 — keeps today's fail-open default while allowing selected
  // preventive policies to fail closed once a compiled local fallback exists.
  denyOnPolicyError: integer('deny_on_policy_error', { mode: 'boolean' }).notNull().default(false),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  // Team mode (Module 04 Phase 4, 2026-05-09). Clerk user id of the
  // admin who created/last-edited this policy. NULL on solo. Surfaced
  // in the web admin's "created by" badge.
  createdByUserId: text('created_by_user_id'),
  updatedByUserId: text('updated_by_user_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

export const policyRules = sqliteTable(
  'policy_rules',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id').references(() => projects.id),
    policyId: text('policy_id')
      .notNull()
      .references(() => policies.id),
    priority: integer('priority').notNull(),
    matchEventType: text('match_event_type').notNull(),
    matchToolName: text('match_tool_name').notNull(),
    matchPathGlob: text('match_path_glob'),
    matchCommandPattern: text('match_command_pattern'),
    matchAgentType: text('match_agent_type'),
    decision: text('decision').notNull(),
    enforcementDecision: text('enforcement_decision'),
    governanceVerdict: text('governance_verdict'),
    enforcementMode: text('enforcement_mode'),
    requiredCapability: text('required_capability'),
    excludedCapability: text('excluded_capability'),
    reason: text('reason').notNull(),
    controlKey: text('control_key'),
    ruleType: text('rule_type').notNull().default('tool_call'),
    severity: text('severity').notNull().default('medium'),
    details: text('details'),
    createdByUserId: text('created_by_user_id'),
    updatedByUserId: text('updated_by_user_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
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

export const policyVersions = sqliteTable(
  'policy_versions',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id').references(() => projects.id),
    policyId: text('policy_id')
      .notNull()
      .references(() => policies.id),
    versionNumber: integer('version_number').notNull(),
    status: text('status').notNull().default('active'),
    snapshotJson: text('snapshot_json').notNull(),
    snapshotHash: text('snapshot_hash').notNull(),
    createdByUserId: text('created_by_user_id'),
    activatedByUserId: text('activated_by_user_id'),
    changeSummary: text('change_summary'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    activatedAt: integer('activated_at', { mode: 'timestamp' }),
    retiredAt: integer('retired_at', { mode: 'timestamp' }),
  },
  (t) => [
    uniqueIndex('policy_versions_policy_version_uk').on(t.policyId, t.versionNumber),
    index('policy_versions_policy_status_idx').on(t.policyId, t.status, t.versionNumber),
  ],
);

export const policyExceptions = sqliteTable(
  'policy_exceptions',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id').references(() => projects.id),
    policyId: text('policy_id')
      .notNull()
      .references(() => policies.id),
    policyVersionId: text('policy_version_id').references(() => policyVersions.id),
    ruleId: text('rule_id').references(() => policyRules.id),
    scopeType: text('scope_type').notNull(),
    scopeJson: text('scope_json').notNull().default('{}'),
    decisionOverride: text('decision_override').notNull(),
    reason: text('reason').notNull(),
    justification: text('justification').notNull(),
    requestedByUserId: text('requested_by_user_id'),
    approvedByUserId: text('approved_by_user_id'),
    updatedByUserId: text('updated_by_user_id'),
    status: text('status').notNull().default('requested'),
    startsAt: integer('starts_at', { mode: 'timestamp' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
    revokedByUserId: text('revoked_by_user_id'),
  },
  (t) => [
    index('policy_exceptions_active_idx').on(t.projectId, t.status, t.expiresAt),
    index('policy_exceptions_policy_idx').on(t.policyId, t.status),
  ],
);

export const policyGrants = sqliteTable(
  'policy_grants',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id').references(() => projects.id),
    runId: text('run_id').references(() => runs.id),
    scopeType: text('scope_type').notNull(),
    scopeJson: text('scope_json').notNull().default('{}'),
    grantKind: text('grant_kind').notNull(),
    targetRuleId: text('target_rule_id').references(() => policyRules.id),
    targetCapability: text('target_capability'),
    grantFingerprint: text('grant_fingerprint'),
    decisionOverride: text('decision_override'),
    sourcePolicyDecisionId: text('source_policy_decision_id'),
    reason: text('reason').notNull(),
    createdByUserId: text('created_by_user_id'),
    approvedByUserId: text('approved_by_user_id'),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index('policy_grants_active_idx').on(t.projectId, t.grantKind, t.expiresAt, t.revokedAt),
    index('policy_grants_target_idx').on(t.targetRuleId, t.targetCapability),
    index('policy_grants_run_idx').on(t.runId, t.scopeType),
  ],
);

export const controls = sqliteTable(
  'controls',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id').references(() => projects.id),
    controlKey: text('control_key').notNull(),
    source: text('source').notNull().default('catalog'),
    domain: text('domain'),
    subdomain: text('subdomain'),
    title: text('title').notNull(),
    description: text('description'),
    owner: text('owner'),
    relevanceTrack: text('relevance_track').notNull(),
    implementationMode: text('implementation_mode').notNull(),
    status: text('status').notNull().default('active'),
    guidance: text('guidance'),
    sourceMetadataJson: text('source_metadata_json').notNull().default('{}'),
    createdByUserId: text('created_by_user_id'),
    updatedByUserId: text('updated_by_user_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index('controls_project_source_key_idx').on(t.projectId, t.source, t.controlKey),
    index('controls_track_idx').on(t.projectId, t.relevanceTrack),
  ],
);

export const controlAttestations = sqliteTable(
  'control_attestations',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id').references(() => projects.id),
    controlId: text('control_id')
      .notNull()
      .references(() => controls.id),
    runId: text('run_id').references(() => runs.id),
    workPackId: text('work_pack_id'),
    status: text('status').notNull().default('recorded'),
    evidenceType: text('evidence_type').notNull().default('note'),
    evidenceRef: text('evidence_ref'),
    evidenceJson: text('evidence_json').notNull().default('{}'),
    notes: text('notes'),
    createdByUserId: text('created_by_user_id'),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index('control_attestations_control_idx').on(t.controlId, t.createdAt),
    index('control_attestations_project_status_idx').on(t.projectId, t.status, t.expiresAt),
  ],
);

export const policyDecisions = sqliteTable(
  'policy_decisions',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    runId: text('run_id').references(() => runs.id),
    sessionId: text('session_id').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    agentType: text('agent_type').notNull(),
    eventType: text('event_type').notNull(),
    toolName: text('tool_name').notNull(),
    toolUseId: text('tool_use_id'),
    permissionMode: text('permission_mode'),
    toolInputSnapshot: text('tool_input_snapshot').notNull(),
    permissionDecision: text('permission_decision').notNull(),
    governanceVerdict: text('governance_verdict'),
    policyVersionId: text('policy_version_id').references(() => policyVersions.id),
    matchedRuleId: text('matched_rule_id').references(() => policyRules.id),
    matchedExceptionId: text('matched_exception_id').references(() => policyExceptions.id),
    matchedGrantId: text('matched_grant_id').references(() => policyGrants.id),
    baseDecision: text('base_decision'),
    effectiveDecision: text('effective_decision'),
    reason: text('reason').notNull(),
    askOutcome: text('ask_outcome'),
    askOutcomeAt: integer('ask_outcome_at', { mode: 'timestamp' }),
    correlatedRunEventId: text('correlated_run_event_id').references(() => runEvents.id),
    evidenceJson: text('evidence_json'),
    resultLabelsJson: text('result_labels_json'),
    activeCapabilitiesJson: text('active_capabilities_json'),
    matchedCapability: text('matched_capability'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index('policy_decisions_session_idx').on(t.sessionId, t.createdAt),
    index('policy_decisions_ask_correlation_idx').on(t.sessionId, t.toolUseId, t.toolName, t.askOutcome),
  ],
);

/**
 * Phase F.1 — features (2026-05-11).
 *
 * On-demand "skill recipe" rows (Anthropic Skills pattern). The agent
 * lists frontmatter via `coodra__list_features` at SessionStart and
 * pulls the full body via `coodra__get_feature` ONLY when a user
 * prompt matches the trigger. This is the pull-on-trigger layer that
 * complements Work Packs' issue-bound implementation records.
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
    orgId: text('org_id'),
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
    updatedByUserId: text('updated_by_user_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('features_project_slug_uk').on(t.projectId, t.slug),
    index('features_project_status_idx').on(t.projectId, t.status),
  ],
);

/**
 * COOD-12 — Work Packs and agent-mediated external planning sync.
 *
 * Work Packs are the repo-local implementation-work artifact for Jira/
 * Atlassian-driven flows. Atlassian remains the owner of auth and issue reads/writes; Coodra
 * stores only local sync state, links, relationship summaries, and generated
 * pack content under `.coodra/work-packs/<slug>/`.
 */
export const integrationConnections = sqliteTable(
  'integration_connections',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    provider: text('provider').notNull(),
    mode: text('mode').notNull().default('agent-mediated'),
    siteUrl: text('site_url').notNull(),
    externalProjectKey: text('external_project_key').notNull(),
    boardId: text('board_id'),
    enabledCapabilitiesJson: text('enabled_capabilities_json').notNull().default('{}'),
    createdByRunId: text('created_by_run_id').references(() => runs.id, { onDelete: 'set null' }),
    updatedByUserId: text('updated_by_user_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('integration_connections_project_provider_uk').on(
      t.projectId,
      t.provider,
      t.siteUrl,
      t.externalProjectKey,
    ),
    index('integration_connections_project_idx').on(t.projectId, t.provider),
  ],
);

export const externalWorkItems = sqliteTable(
  'external_work_items',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    provider: text('provider').notNull(),
    externalKey: text('external_key').notNull(),
    issueType: text('issue_type').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull(),
    url: text('url'),
    parentExternalKey: text('parent_external_key'),
    rawExternalJson: text('raw_external_json').notNull().default('{}'),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('external_work_items_project_provider_key_uk').on(t.projectId, t.provider, t.externalKey),
    index('external_work_items_project_status_idx').on(t.projectId, t.status),
  ],
);

export const workPacks = sqliteTable(
  'work_packs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    packType: text('pack_type').notNull().default('unknown'),
    status: text('status').notNull().default('draft'),
    specMarkdown: text('spec_markdown').notNull().default(''),
    implementationMarkdown: text('implementation_markdown').notNull().default(''),
    syncMarkdown: text('sync_markdown').notNull().default(''),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdByRunId: text('created_by_run_id').references(() => runs.id, { onDelete: 'set null' }),
    createdByUserId: text('created_by_user_id'),
    orgId: text('org_id'),
    updatedByUserId: text('updated_by_user_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    // Append-only redesign (2026-08-05) — activity rollup, distinct from
    // updatedAt (which only moves on explicit work_pack_upsert calls).
    // lastActivityAt moves on ANY context pack saved or decision recorded
    // against this Work Pack — updated mechanically, in the same write as
    // the triggering event (context-pack.ts::write(), record-decision's
    // handler), never by a background job. NULL until first activity.
    lastActivityAt: integer('last_activity_at', { mode: 'timestamp' }),
    // Denormalized pointer to the most recently saved Context Pack linked
    // to this Work Pack — same mechanical-update rule as lastActivityAt.
    // Lets SessionStart's diversified selection cheaply find "the latest
    // pack per Work Pack" without a correlated subquery.
    latestContextPackId: text('latest_context_pack_id').references(() => contextPacks.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('work_packs_project_slug_uk').on(t.projectId, t.slug),
    index('work_packs_project_type_idx').on(t.projectId, t.packType),
    index('work_packs_project_status_idx').on(t.projectId, t.status),
  ],
);

export const workPackExternalLinks = sqliteTable(
  'work_pack_external_links',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id').references(() => projects.id),
    workPackId: text('work_pack_id')
      .notNull()
      .references(() => workPacks.id, { onDelete: 'cascade' }),
    externalWorkItemId: text('external_work_item_id')
      .notNull()
      .references(() => externalWorkItems.id, { onDelete: 'cascade' }),
    syncDirection: text('sync_direction').notNull().default('bidirectional'),
    syncState: text('sync_state').notNull().default('synced'),
    lastSyncedHash: text('last_synced_hash'),
    conflictState: text('conflict_state'),
    updatedByUserId: text('updated_by_user_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('work_pack_external_links_pair_uk').on(t.workPackId, t.externalWorkItemId),
    index('work_pack_external_links_external_idx').on(t.externalWorkItemId),
  ],
);

export const workPackRelationships = sqliteTable(
  'work_pack_relationships',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    sourceWorkPackId: text('source_work_pack_id').references(() => workPacks.id, { onDelete: 'cascade' }),
    targetWorkPackId: text('target_work_pack_id').references(() => workPacks.id, { onDelete: 'set null' }),
    sourceExternalKey: text('source_external_key'),
    targetExternalKey: text('target_external_key').notNull(),
    relationshipType: text('relationship_type').notNull(),
    syncLevel: text('sync_level').notNull().default('summary'),
    metadataJson: text('metadata_json').notNull().default('{}'),
    updatedByUserId: text('updated_by_user_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index('work_pack_relationships_project_source_idx').on(t.projectId, t.sourceExternalKey),
    index('work_pack_relationships_project_target_idx').on(t.projectId, t.targetExternalKey),
  ],
);

export const syncEvents = sqliteTable(
  'sync_events',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    workPackId: text('work_pack_id').references(() => workPacks.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    direction: text('direction').notNull(),
    action: text('action').notNull(),
    result: text('result').notNull(),
    actorRunId: text('actor_run_id').references(() => runs.id, { onDelete: 'set null' }),
    externalKey: text('external_key'),
    summary: text('summary').notNull().default(''),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index('sync_events_project_created_idx').on(t.projectId, t.createdAt),
    index('sync_events_work_pack_idx').on(t.workPackId, t.createdAt),
  ],
);

export const decisions = sqliteTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id').references(() => projects.id),
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
 * COOD-58 — durable typed edges for the decision memory layer.
 *
 * Decisions remain append-only and immutable. Relationships that change
 * their authority or connect them to code artifacts live here instead:
 *   - `supersedes`: from_decision_id -> target_type='decision'/target_id=dec_*
 *   - `affects`:    from_decision_id -> file | work_pack | graph_node
 *
 * `target_id` is intentionally typed by `target_type` instead of being a
 * nullable/overloaded FK column. SQLite cannot express the conditional FK
 * for target_type='decision', so write paths validate decision targets and
 * reject supersession cycles in application code.
 */
export const decisionEdges = sqliteTable(
  'decision_edges',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    fromDecisionId: text('from_decision_id')
      .notNull()
      .references(() => decisions.id, { onDelete: 'cascade' }),
    edgeType: text('edge_type').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    metadataJson: text('metadata_json'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('decision_edges_unique').on(t.fromDecisionId, t.edgeType, t.targetType, t.targetId),
    index('decision_edges_project_target_idx').on(t.projectId, t.edgeType, t.targetType, t.targetId),
    index('decision_edges_from_idx').on(t.fromDecisionId, t.edgeType),
  ],
);

/**
 * coodra-work redesign, round 2 — direct many-to-many links from a
 * decision/context pack to the Work Pack(s) it belongs to, written at
 * record time. Mirrors `workPackExternalLinks`'s exact shape (postgres
 * mirror: `postgres.ts::workPackDecisionLinks`/`workPackContextPackLinks`).
 * See the postgres.ts docblock for the full rationale.
 */
export const workPackDecisionLinks = sqliteTable(
  'work_pack_decision_links',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id').references(() => projects.id),
    workPackId: text('work_pack_id')
      .notNull()
      .references(() => workPacks.id, { onDelete: 'cascade' }),
    decisionId: text('decision_id')
      .notNull()
      .references(() => decisions.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('work_pack_decision_links_pair_uk').on(t.workPackId, t.decisionId),
    index('work_pack_decision_links_decision_idx').on(t.decisionId),
  ],
);

export const workPackContextPackLinks = sqliteTable(
  'work_pack_context_pack_links',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id').references(() => projects.id),
    workPackId: text('work_pack_id')
      .notNull()
      .references(() => workPacks.id, { onDelete: 'cascade' }),
    contextPackId: text('context_pack_id')
      .notNull()
      .references(() => contextPacks.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('work_pack_context_pack_links_pair_uk').on(t.workPackId, t.contextPackId),
    index('work_pack_context_pack_links_context_pack_idx').on(t.contextPackId),
  ],
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
    orgId: text('org_id'),
    projectId: text('project_id').references(() => projects.id),
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
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
    orgId: text('org_id'),
    projectId: text('project_id').references(() => projects.id),
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

/**
 * Append-only canonical audit stream for team/EE reporting. State tables keep
 * current truth; this table records who did what, when, and to which subject.
 * `prev_hash` + `hash` are reserved for server-side tamper-evident chains.
 */
export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    projectId: text('project_id').references(() => projects.id),
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    actorUserId: text('actor_user_id'),
    actorRunId: text('actor_run_id').references(() => runs.id, { onDelete: 'set null' }),
    eventType: text('event_type').notNull(),
    subjectTable: text('subject_table').notNull(),
    subjectId: text('subject_id').notNull(),
    action: text('action').notNull(),
    result: text('result').notNull().default('success'),
    reason: text('reason'),
    metadataJson: text('metadata_json').notNull().default('{}'),
    beforeHash: text('before_hash'),
    afterHash: text('after_hash'),
    prevHash: text('prev_hash'),
    hash: text('hash'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index('audit_events_org_created_idx').on(t.orgId, t.createdAt),
    index('audit_events_project_created_idx').on(t.projectId, t.createdAt),
    index('audit_events_subject_idx').on(t.subjectTable, t.subjectId, t.createdAt),
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
export type Feature = typeof features.$inferSelect;
export type NewFeature = typeof features.$inferInsert;
export type IntegrationConnection = typeof integrationConnections.$inferSelect;
export type NewIntegrationConnection = typeof integrationConnections.$inferInsert;
export type ExternalWorkItem = typeof externalWorkItems.$inferSelect;
export type NewExternalWorkItem = typeof externalWorkItems.$inferInsert;
export type WorkPack = typeof workPacks.$inferSelect;
export type NewWorkPack = typeof workPacks.$inferInsert;
export type WorkPackExternalLink = typeof workPackExternalLinks.$inferSelect;
export type NewWorkPackExternalLink = typeof workPackExternalLinks.$inferInsert;
export type WorkPackRelationship = typeof workPackRelationships.$inferSelect;
export type NewWorkPackRelationship = typeof workPackRelationships.$inferInsert;
export type SyncEvent = typeof syncEvents.$inferSelect;
export type NewSyncEvent = typeof syncEvents.$inferInsert;
export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;
export type DecisionEdge = typeof decisionEdges.$inferSelect;
export type NewDecisionEdge = typeof decisionEdges.$inferInsert;
export type WorkPackDecisionLink = typeof workPackDecisionLinks.$inferSelect;
export type NewWorkPackDecisionLink = typeof workPackDecisionLinks.$inferInsert;
export type WorkPackContextPackLink = typeof workPackContextPackLinks.$inferSelect;
export type NewWorkPackContextPackLink = typeof workPackContextPackLinks.$inferInsert;
export type RunDiff = typeof runDiffs.$inferSelect;
export type NewRunDiff = typeof runDiffs.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
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
 * team mode), matching the attribution columns used by shared project knowledge.
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
    updatedByUserId: text('updated_by_user_id'),
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
    projectId: text('project_id').references(() => projects.id),
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
    updatedByUserId: text('updated_by_user_id'),
    orgId: text('org_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('wiki_pages_wiki_page_uk').on(t.wikiId, t.pageId),
    index('wiki_pages_wiki_state_idx').on(t.wikiId, t.state),
  ],
);

/**
 * COOD-78 — memory access log (`docs/PRD-memory-utilization.md` §W1).
 *
 * One row per Coodra memory item surfaced to an agent, on either
 * channel:
 *   - `push` — Coodra injected it (SessionStart manifest, prompt
 *     context, post-compact re-emission, policy reason text).
 *   - `pull` — the agent explicitly asked for it (`read_context_pack`,
 *     `search_packs_nl`, `query_decisions`, `wiki_ask`, `get_recipe`, …).
 *
 * Why the distinction is the whole point: push only proves Coodra
 * spent tokens. Pull proves the agent wanted the item enough to ask
 * for it — the first real utilization signal Coodra has ever had.
 * Pull-through rate (surfaced → pulled) and stale share (was it still
 * true when shown?) are the two north-star metrics built on this.
 *
 * Naming. Called `memory_*` and not `context_*` because `context_packs`
 * already exists and would make this read pack-scoped, which is the
 * opposite of the generalization it exists for; and not `artifact_*`
 * because `artifact` already means Graphify build output in this repo
 * (`packages/cli/src/commands/graphify-artifacts.ts`).
 *
 * Deliberately NOT here: policy outcomes. `policy_decisions` already
 * carries `ask_outcome`, `matched_rule_id`, `governance_verdict`,
 * `base_decision` and `effective_decision` with more fidelity, and two
 * sources of truth for policy metrics is a bug waiting to happen. The
 * single exception is `site: 'policy_reason'` (COOD-88), which records
 * that a decision was *taught* through deny/ask reason text — something
 * `policy_decisions` cannot observe.
 *
 * Privacy: ids, counts, hashes, byte costs and metadata only. Never
 * raw prompt text or memory content by default; `query_hash` /
 * `trigger_text_hash` carry hashes so repeats can be counted without
 * storing a transcript mirror.
 *
 * Writes go through the durable outbox (`scheduleDurableWrite`, queue
 * `memory_access`) so hook latency is unaffected and a SIGTERM mid-hook
 * cannot lose the row.
 */
export const memoryAccessEvents = sqliteTable(
  'memory_access_events',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id').references(() => projects.id),
    // Nullable for the same reason run_events.run_id is: a surfacing can
    // happen before a `runs` row exists, and COOD-80's attribution chain
    // deliberately writes NULL (plus a counter) rather than guessing when
    // projectSlug → projectId → lookupRunId misses.
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    sessionId: text('session_id'),
    // Who/what caused the access — per-seat and per-agent utilization in
    // team mode. Both nullable: solo mode has no Clerk user.
    actorUserId: text('actor_user_id'),
    agentType: text('agent_type'),
    runEventId: text('run_event_id').references(() => runEvents.id, { onDelete: 'set null' }),
    /** `push` | `pull` */
    channel: text('channel').notNull(),
    /**
     * Which door the item came through — `session_start_manifest`,
     * `prompt_context`, `post_compact`, `search_packs_nl`,
     * `read_context_pack`, `query_decisions`, `query_decisions_by_file`,
     * `wiki_ask`, `get_recipe`, `policy_reason`.
     *
     * Deliberately distinct from `memory_type`: `site` answers "through
     * which door", `memory_type` answers "what came through it".
     * Pull-through rate is naturally a per-site metric.
     */
    site: text('site').notNull(),
    /** `context_pack` | `decision` | `wiki_page` | `recipe` | `work_pack` | `manifest` */
    memoryType: text('memory_type').notNull(),
    /** Nullable — a search that returned nothing still logs a row. */
    memoryId: text('memory_id'),
    /** Rank within the injection or result set. */
    position: integer('position'),
    bytes: integer('bytes'),
    latencyMs: integer('latency_ms'),
    /** `session_start` | `user_prompt` | `post_compact` | `tool_call` */
    triggerType: text('trigger_type').notNull(),
    queryHash: text('query_hash'),
    triggerTextHash: text('trigger_text_hash'),
    /** For search-type sites: how many results came back. */
    resultCount: integer('result_count'),
    /**
     * Point-in-time snapshot of the item's freshness (COOD-85). A pack
     * that goes stale *later* must not rewrite history, so this is
     * copied at access time rather than joined at read time.
     */
    freshnessStatusAtAccess: text('freshness_status_at_access'),
    /**
     * Increments on each compaction within a run (COOD-84). Deltas and
     * invalidations are defined relative to a generation, so a delta is
     * never emitted against a baseline no longer in the context window;
     * `memory_cohorts` keys on it so post-compaction pulls join the new
     * cohort rather than inflating the original manifest's pull-through.
     */
    baselineGeneration: integer('baseline_generation').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    // Daily rollup scan (COOD-79): project + day, grouped by channel/site/type.
    index('memory_access_events_project_created_idx').on(t.projectId, t.createdAt),
    // Cohort rollup (COOD-79) and "was this manifest entry pulled?" lookups.
    index('memory_access_events_cohort_idx').on(t.runId, t.baselineGeneration, t.memoryType, t.memoryId),
    // "Never surfaced" dead-memory LEFT JOIN from the artifact tables.
    index('memory_access_events_memory_idx').on(t.memoryType, t.memoryId, t.createdAt),
  ],
);

/**
 * COOD-79 — daily volume/cost rollup over `memory_access_events`.
 *
 * Dashboard queries (COOD-87) read this, never the raw event table
 * beyond the retention window, so the dashboard cannot degrade on
 * exactly the long-running projects this epic exists to serve.
 *
 * **No percentile columns, deliberately.** p50/p95 do not re-aggregate
 * from stored aggregates — averaging daily percentiles is not the
 * percentile of the union, and it produces confidently wrong numbers.
 * `total_latency_ms` + `access_count` gives an exact mean and
 * `max_latency_ms` an exact max, and both compose across days. If real
 * percentiles are ever needed, add fixed histogram buckets (which
 * *do* compose) rather than trying to roll up a p95.
 *
 * `day` is a UTC `YYYY-MM-DD` string rather than a timestamp: the grain
 * is a calendar day, and storing it as text keeps the unique index and
 * the GROUP BY honest across both dialects without timezone drift.
 */
export const memoryAccessDaily = sqliteTable(
  'memory_access_daily',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id').references(() => projects.id),
    /** UTC calendar day, `YYYY-MM-DD`. */
    day: text('day').notNull(),
    channel: text('channel').notNull(),
    site: text('site').notNull(),
    memoryType: text('memory_type').notNull(),
    accessCount: integer('access_count').notNull().default(0),
    /** Distinct `memory_id`s touched — NULL memory_ids are not counted. */
    distinctItems: integer('distinct_items').notNull().default(0),
    distinctRuns: integer('distinct_runs').notNull().default(0),
    totalBytes: integer('total_bytes').notNull().default(0),
    totalLatencyMs: integer('total_latency_ms').notNull().default(0),
    maxLatencyMs: integer('max_latency_ms').notNull().default(0),
    /** Accesses where the item was already stale when surfaced. */
    staleAtAccessCount: integer('stale_at_access_count').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('memory_access_daily_grain_uk').on(t.projectId, t.day, t.channel, t.site, t.memoryType),
    index('memory_access_daily_day_idx').on(t.day),
  ],
);

/**
 * COOD-79 — per-item cohort rollup: the pull-through primitive.
 *
 * The daily grain above loses `memory_id`, so it can count accesses but
 * cannot answer the actual north-star question: *this manifest entry
 * was shown — was this specific body then pulled?* One row per
 * (run, generation, item) answers it.
 *
 * **Keyed on `baseline_generation`** so a pull is attributed to the
 * manifest generation that actually surfaced it. After a compaction
 * re-emits the manifest (COOD-84), the next pull belongs to the new
 * cohort — without this, post-compaction pulls would be credited to the
 * original manifest and pull-through would read artificially high on
 * exactly the long sessions this epic exists to fix.
 *
 * Small by construction (one row per item per generation, not per
 * access), so it carries a **longer retention than raw events**:
 * dead-memory detection needs months of history, raw access rows do
 * not. "Never surfaced" is an artifact-table LEFT JOIN against this
 * rather than a scan of raw events.
 *
 * Rows are only written for accesses that carry a `memory_id` — a
 * zero-result search is a real access event (and is counted in the
 * daily rollup) but has no item to have a pull-through rate for.
 */
export const memoryCohorts = sqliteTable(
  'memory_cohorts',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id').references(() => projects.id),
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    baselineGeneration: integer('baseline_generation').notNull().default(0),
    memoryType: text('memory_type').notNull(),
    memoryId: text('memory_id').notNull(),
    surfacedCount: integer('surfaced_count').notNull().default(0),
    pulledCount: integer('pulled_count').notNull().default(0),
    firstSurfacedAt: integer('first_surfaced_at', { mode: 'timestamp' }),
    firstPulledAt: integer('first_pulled_at', { mode: 'timestamp' }),
    /** NULL unless the item was both surfaced and later pulled. */
    timeToFirstPullMs: integer('time_to_first_pull_ms'),
    staleAtAccess: integer('stale_at_access', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('memory_cohorts_grain_uk').on(t.runId, t.baselineGeneration, t.memoryType, t.memoryId),
    // Drives "never surfaced" / "never pulled" dead-memory queries.
    index('memory_cohorts_item_idx').on(t.memoryType, t.memoryId),
    index('memory_cohorts_project_idx').on(t.projectId, t.createdAt),
  ],
);

export type Wiki = typeof wikis.$inferSelect;
export type NewWiki = typeof wikis.$inferInsert;
export type MemoryAccessEvent = typeof memoryAccessEvents.$inferSelect;
export type NewMemoryAccessEvent = typeof memoryAccessEvents.$inferInsert;
export type MemoryAccessDailyRow = typeof memoryAccessDaily.$inferSelect;
export type NewMemoryAccessDailyRow = typeof memoryAccessDaily.$inferInsert;
export type MemoryCohortRow = typeof memoryCohorts.$inferSelect;
export type NewMemoryCohortRow = typeof memoryCohorts.$inferInsert;
export type WikiPageRow = typeof wikiPages.$inferSelect;
export type NewWikiPageRow = typeof wikiPages.$inferInsert;
export type Control = typeof controls.$inferSelect;
export type NewControl = typeof controls.$inferInsert;
export type ControlAttestation = typeof controlAttestations.$inferSelect;
export type NewControlAttestation = typeof controlAttestations.$inferInsert;
