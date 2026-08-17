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
    // Module 06 — see ./sqlite.ts::runs.baseSha for the full rationale.
    baseSha: text('base_sha'),
    // Module 04 Phase 4 — see ./sqlite.ts::runs.createdByUserId.
    createdByUserId: text('created_by_user_id'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    // Claude Code hook coverage expansion (2026-08-04) — see
    // ./sqlite.ts::runs.compactionNudgedAt for the full rationale.
    compactionNudgedAt: timestamp('compaction_nudged_at', { withTimezone: true, mode: 'date' }),
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
    // COOD-34 — see ./sqlite.ts::runs.activeCapabilitiesJson.
    activeCapabilitiesJson: text('active_capabilities_json').notNull().default('[]'),
  },
  (t) => [uniqueIndex('runs_project_session_idx').on(t.projectId, t.sessionId), index('runs_status_idx').on(t.status)],
);

export const runEvents = pgTable(
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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('run_events_run_created_idx').on(t.runId, t.createdAt)],
);

export const contextPacks = pgTable(
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
    // Module 05 (2026-05-08 reshape): kept through 0009; dropped in 0010.
    summaryEmbedding: vector('summary_embedding', { dimensions: 384 }),
    // Module 05 — see sqlite.ts contextPacks comment. Append-only redesign
    // (2026-08-05): the upgrade-in-place behavior is now narrowed to the
    // most recent row for a run, not "any" row — see context-pack.ts.
    source: text('source').notNull().default('agent'),
    // Module 05 — JSON-encoded agent-curated metadata. Use `text` (not
    // `jsonb`) for parity with SQLite. Handler does JSON.parse/stringify.
    meta: text('meta'),
    // Nullable link to the Work Pack this recap belongs to. Kept as text
    // because context_packs is declared before work_packs in this module.
    workPackId: text('work_pack_id'),
    // Module 04 Phase 4 — see ./sqlite.ts::contextPacks.createdByUserId.
    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    // Append-only redesign (2026-08-05) — see sqlite.ts contextPacks.kind
    // comment for the full rationale. Soft-governed free text.
    kind: text('kind'),
    // See sqlite.ts contextPacks.importance. Soft-governed free text.
    importance: text('importance'),
    // COOD-59 — see sqlite.ts contextPacks.archivedInPackId.
    archivedInPackId: text('archived_in_pack_id'),
    /**
     * COOD-85 — freshness, which is a DIFFERENT property from supersession.
     *
     *   staleness    — is this still TRUE? (derived from code drift)
     *   supersession — has this been REPLACED? (canonical in decision_edges
     *                  for decisions, archived_in_pack_id for packs)
     *
     * Nothing here derives supersession, and there is deliberately no
     * `superseded_by` column: that would be a second source of truth for
     * authority, free to disagree with the edges it duplicates.
     *
     * `verified_against_commit` / `verified_against_files` are the
     * load-bearing pair. They turn "is this still true?" into a
     * mechanical query — have the files this was verified against changed
     * since? — instead of waiting for an agent to volunteer that it is
     * obsolete, which is the whole failure COOD-58's supersede edges
     * still have (they only exist when someone records them).
     *
     * Existing rows backfill to `unverified`, not `fresh`: we have never
     * checked them, and claiming freshness we never established is the
     * error this field exists to prevent.
     */
    freshnessStatus: text('freshness_status').notNull().default('unverified'),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true, mode: 'date' }),
    /** Why it went stale — `files_changed`, `files_deleted`, … */
    staleReason: text('stale_reason'),
    verifiedAgainstCommit: text('verified_against_commit'),
    /** JSON string array of repo-relative paths this was verified against. */
    verifiedAgainstFiles: text('verified_against_files'),
  },
  (t) => [
    // Append-only redesign (2026-08-05) — see sqlite.ts contextPacks
    // run_idx comment for the full rationale. Was unique; now plain.
    index('context_packs_run_idx').on(t.runId),
    index('context_packs_project_created_idx').on(t.projectId, t.createdAt),
    index('context_packs_work_pack_idx').on(t.workPackId, t.createdAt),
    index('context_packs_archived_in_pack_idx').on(t.archivedInPackId),
  ],
);

export const pendingJobs = pgTable(
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
  orgId: text('org_id'),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  name: text('name').notNull(),
  description: text('description'),
  groupKey: text('group_key').notNull().default('agent_guardrails'),
  profile: text('profile').notNull().default('default'),
  enforcementMode: text('enforcement_mode').notNull().default('detective'),
  // COOD-34 — see ./sqlite.ts::policies.denyOnPolicyError.
  denyOnPolicyError: boolean('deny_on_policy_error').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  // Module 04 Phase 4 — see ./sqlite.ts::policies.createdByUserId.
  createdByUserId: text('created_by_user_id'),
  updatedByUserId: text('updated_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const policyRules = pgTable(
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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }),
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

export const policyVersions = pgTable(
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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true, mode: 'date' }),
    retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('policy_versions_policy_version_uk').on(t.policyId, t.versionNumber),
    index('policy_versions_policy_status_idx').on(t.policyId, t.status, t.versionNumber),
  ],
);

export const policyExceptions = pgTable(
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
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedByUserId: text('revoked_by_user_id'),
  },
  (t) => [
    index('policy_exceptions_active_idx').on(t.projectId, t.status, t.expiresAt),
    index('policy_exceptions_policy_idx').on(t.policyId, t.status),
  ],
);

export const policyGrants = pgTable(
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
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('policy_grants_active_idx').on(t.projectId, t.grantKind, t.expiresAt, t.revokedAt),
    index('policy_grants_target_idx').on(t.targetRuleId, t.targetCapability),
    index('policy_grants_run_idx').on(t.runId, t.scopeType),
  ],
);

export const controls = pgTable(
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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('controls_project_source_key_idx').on(t.projectId, t.source, t.controlKey),
    index('controls_track_idx').on(t.projectId, t.relevanceTrack),
  ],
);

export const controlAttestations = pgTable(
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
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('control_attestations_control_idx').on(t.controlId, t.createdAt),
    index('control_attestations_project_status_idx').on(t.projectId, t.status, t.expiresAt),
  ],
);

export const policyDecisions = pgTable(
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
    askOutcomeAt: timestamp('ask_outcome_at', { withTimezone: true, mode: 'date' }),
    correlatedRunEventId: text('correlated_run_event_id').references(() => runEvents.id),
    evidenceJson: text('evidence_json'),
    resultLabelsJson: text('result_labels_json'),
    activeCapabilitiesJson: text('active_capabilities_json'),
    matchedCapability: text('matched_capability'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('policy_decisions_session_idx').on(t.sessionId, t.createdAt),
    index('policy_decisions_ask_correlation_idx').on(t.sessionId, t.toolUseId, t.toolName, t.askOutcome),
  ],
);

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
 * shared across skill-style knowledge rows).
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
    orgId: text('org_id'),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    slug: text('slug').notNull(),
    frontmatter: text('frontmatter').notNull(),
    body: text('body').notNull(),
    checksum: text('checksum').notNull(),
    status: text('status').notNull().default('draft'),
    createdByUserId: text('created_by_user_id'),
    updatedByUserId: text('updated_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('features_project_slug_uk').on(t.projectId, t.slug),
    index('features_project_status_idx').on(t.projectId, t.status),
  ],
);

/**
 * COOD-12 — Work Packs and agent-mediated external planning sync.
 *
 * See sqlite.ts for the full product boundary: Coodra stores Work Pack
 * content, sync state, and relationships; Atlassian owns Jira auth and all
 * issue reads/writes through the active agent's MCP tools.
 */
export const integrationConnections = pgTable(
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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
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

export const externalWorkItems = pgTable(
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
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('external_work_items_project_provider_key_uk').on(t.projectId, t.provider, t.externalKey),
    index('external_work_items_project_status_idx').on(t.projectId, t.status),
  ],
);

export const workPacks = pgTable(
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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    // Append-only redesign (2026-08-05) — see sqlite.ts workPacks.
    // lastActivityAt comment for the full rationale.
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true, mode: 'date' }),
    latestContextPackId: text('latest_context_pack_id').references(() => contextPacks.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('work_packs_project_slug_uk').on(t.projectId, t.slug),
    index('work_packs_project_type_idx').on(t.projectId, t.packType),
    index('work_packs_project_status_idx').on(t.projectId, t.status),
  ],
);

export const workPackExternalLinks = pgTable(
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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('work_pack_external_links_pair_uk').on(t.workPackId, t.externalWorkItemId),
    index('work_pack_external_links_external_idx').on(t.externalWorkItemId),
  ],
);

export const workPackRelationships = pgTable(
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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('work_pack_relationships_project_source_idx').on(t.projectId, t.sourceExternalKey),
    index('work_pack_relationships_project_target_idx').on(t.projectId, t.targetExternalKey),
  ],
);

export const syncEvents = pgTable(
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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('sync_events_project_created_idx').on(t.projectId, t.createdAt),
    index('sync_events_work_pack_idx').on(t.workPackId, t.createdAt),
  ],
);

export const decisions = pgTable(
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
    // Module 05 (2026-05-08 reshape) — structured intent fields. See
    // sqlite.ts decisions comment. NULL on legacy rows; idempotency key
    // unchanged (sha256 of description), so re-recording with new metadata
    // collapses to the original row.
    context: text('context'),
    impact: text('impact'),
    confidence: text('confidence'),
    reversible: boolean('reversible'),
    /**
     * COOD-85 — freshness. See `context_packs` for the full rationale;
     * the short version is that staleness ("is this still true?") and
     * supersession ("has this been replaced?") are different properties,
     * and supersession stays canonical in `decision_edges`.
     */
    freshnessStatus: text('freshness_status').notNull().default('unverified'),
    staleReason: text('stale_reason'),
    verifiedAgainstCommit: text('verified_against_commit'),
    verifiedAgainstFiles: text('verified_against_files'),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true, mode: 'date' }),
    // Module 04 Phase 4 — see ./sqlite.ts::decisions.createdByUserId.
    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('decisions_run_created_idx').on(t.runId, t.createdAt)],
);

/**
 * COOD-58 — durable typed edges for the decision memory layer. Mirrors
 * the SQLite table exactly; see sqlite.ts::decisionEdges for rationale.
 */
export const decisionEdges = pgTable(
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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
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
 * record time. Mirrors `workPackExternalLinks`'s exact shape.
 *
 * Before this, a decision's Work Pack membership was derivable only
 * transitively (decisions.run_id -> runs.id -> runs.work_pack_id), which
 * has two problems: (1) `runs.work_pack_id` is a single mutable column,
 * so a run touching two packs in sequence silently reassigns every
 * earlier decision on that run when queried transitively; (2) a related
 * pack can never see another pack's decisions, since the join only ever
 * reaches runs bound to the pack being queried. These tables fix both —
 * stable at write time, and explicitly many-to-many so a decision or
 * Context Pack can be tagged to more than one pack. The old transitive
 * `runs.work_pack_id` columns are unchanged and still used by
 * `work_pack_status`'s primary-pack resume flow and as a query_decisions
 * fallback for decisions recorded before this migration.
 */
export const workPackDecisionLinks = pgTable(
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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('work_pack_decision_links_pair_uk').on(t.workPackId, t.decisionId),
    index('work_pack_decision_links_decision_idx').on(t.decisionId),
  ],
);

export const workPackContextPackLinks = pgTable(
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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('work_pack_context_pack_links_pair_uk').on(t.workPackId, t.contextPackId),
    index('work_pack_context_pack_links_context_pack_idx').on(t.contextPackId),
  ],
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
    orgId: text('org_id'),
    projectId: text('project_id').references(() => projects.id),
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
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
    orgId: text('org_id'),
    projectId: text('project_id').references(() => projects.id),
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

export const auditEvents = pgTable(
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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_events_org_created_idx').on(t.orgId, t.createdAt),
    index('audit_events_project_created_idx').on(t.projectId, t.createdAt),
    index('audit_events_subject_idx').on(t.subjectTable, t.subjectId, t.createdAt),
  ],
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
export type KillSwitch = typeof killSwitches.$inferSelect;
export type NewKillSwitch = typeof killSwitches.$inferInsert;
export type RunDiff = typeof runDiffs.$inferSelect;
export type NewRunDiff = typeof runDiffs.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
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
    updatedByUserId: text('updated_by_user_id'),
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
    projectId: text('project_id').references(() => projects.id),
    wikiId: text('wiki_id')
      .notNull()
      .references(() => wikis.id, { onDelete: 'cascade' }),
    pageId: text('page_id').notNull(),
    state: text('state').notNull().default('pending'),
    contentMarkdown: text('content_markdown').notNull().default(''),
    citations: text('citations').notNull().default('[]'),
    authoredByRunId: text('authored_by_run_id').references(() => runs.id, { onDelete: 'set null' }),
    createdByUserId: text('created_by_user_id'),
    updatedByUserId: text('updated_by_user_id'),
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
export type Control = typeof controls.$inferSelect;
export type NewControl = typeof controls.$inferInsert;
export type ControlAttestation = typeof controlAttestations.$inferSelect;
export type NewControlAttestation = typeof controlAttestations.$inferInsert;

/**
 * Phase F.3.c — `knowledge_audit` (2026-05-11). **Postgres-only**.
 *
 * Append-only audit log of every mutation to a shared knowledge artifact.
 * Captures the "who did what when" so
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
 *   - resource_type identifies the knowledge artifact family
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

/**
 * COOD-78 — memory access log. Postgres mirror of
 * `sqliteSchema.memoryAccessEvents`; see that table's docblock for the
 * design rationale (push vs pull, the naming decision, why policy
 * outcomes stay in `policy_decisions`, and the privacy posture).
 *
 * Column set and notNull flags must stay identical across dialects —
 * `packages/db/__tests__/unit/schema-parity.test.ts` enforces it.
 */
export const memoryAccessEvents = pgTable(
  'memory_access_events',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id').references(() => projects.id),
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    sessionId: text('session_id'),
    actorUserId: text('actor_user_id'),
    agentType: text('agent_type'),
    runEventId: text('run_event_id').references(() => runEvents.id, { onDelete: 'set null' }),
    channel: text('channel').notNull(),
    site: text('site').notNull(),
    memoryType: text('memory_type').notNull(),
    memoryId: text('memory_id'),
    position: integer('position'),
    bytes: integer('bytes'),
    latencyMs: integer('latency_ms'),
    triggerType: text('trigger_type').notNull(),
    queryHash: text('query_hash'),
    triggerTextHash: text('trigger_text_hash'),
    resultCount: integer('result_count'),
    freshnessStatusAtAccess: text('freshness_status_at_access'),
    baselineGeneration: integer('baseline_generation').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('memory_access_events_project_created_idx').on(t.projectId, t.createdAt),
    index('memory_access_events_cohort_idx').on(t.runId, t.baselineGeneration, t.memoryType, t.memoryId),
    index('memory_access_events_memory_idx').on(t.memoryType, t.memoryId, t.createdAt),
  ],
);

export type MemoryAccessEvent = typeof memoryAccessEvents.$inferSelect;
export type NewMemoryAccessEvent = typeof memoryAccessEvents.$inferInsert;

/**
 * COOD-79 — daily volume/cost rollup. Postgres mirror of
 * `sqliteSchema.memoryAccessDaily`; see that table's docblock for why
 * there are no percentile columns.
 */
export const memoryAccessDaily = pgTable(
  'memory_access_daily',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    projectId: text('project_id').references(() => projects.id),
    day: text('day').notNull(),
    channel: text('channel').notNull(),
    site: text('site').notNull(),
    memoryType: text('memory_type').notNull(),
    /**
     * COOD-100 — who the utilization belongs to.
     *
     * `memory_access_events` has always carried `actor_user_id`; the
     * rollup aggregated it away, which cost two things at once.
     *
     * 1. **Per-seat utilization**, which the PRD listed as the reason
     *    the column exists ("needed for per-seat and per-agent
     *    utilization in team mode") but the rollup never delivered.
     * 2. **Safe team sync.** Without an actor in the grain, two
     *    developers on one project produce the SAME
     *    (project, day, channel, site, memory_type) row, so pushing to
     *    a shared cloud loses one of them under any conflict policy —
     *    DO UPDATE overwrites, DO NOTHING discards (COOD-98).
     *
     * NOT NULL with a `local` sentinel rather than a nullable column.
     * Solo mode has no Clerk actor, and a NULL here would land in a
     * UNIQUE index where SQL treats NULLs as distinct — the precise
     * trap COOD-79 hit, which is why the rollup recomputes by
     * delete-then-insert instead of upserting. A sentinel keeps the
     * grain a real key and gives the dashboard something to label.
     */
    actorUserId: text('actor_user_id').notNull().default('local'),
    accessCount: integer('access_count').notNull().default(0),
    distinctItems: integer('distinct_items').notNull().default(0),
    distinctRuns: integer('distinct_runs').notNull().default(0),
    totalBytes: integer('total_bytes').notNull().default(0),
    totalLatencyMs: integer('total_latency_ms').notNull().default(0),
    maxLatencyMs: integer('max_latency_ms').notNull().default(0),
    staleAtAccessCount: integer('stale_at_access_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('memory_access_daily_grain_uk').on(t.projectId, t.day, t.channel, t.site, t.memoryType, t.actorUserId),
    index('memory_access_daily_day_idx').on(t.day),
  ],
);

/**
 * COOD-79 — per-item cohort rollup. Postgres mirror of
 * `sqliteSchema.memoryCohorts`; see that table's docblock for why the
 * grain includes `baseline_generation` and why it outlives raw events.
 */
export const memoryCohorts = pgTable(
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
    /**
     * COOD-101 — WHERE the item was first surfaced, and first pulled.
     *
     * Derived attributes, deliberately NOT part of the grain. A cohort
     * exists precisely to pair a push at one site
     * (`session_start_manifest`) with a pull at another
     * (`read_context_pack`); putting either site in the grain would
     * split those two rows apart and destroy the pairing the table
     * exists for.
     *
     * Without these, `/memory` could not attribute pull-through to a
     * surface. It grouped cohorts by `memory_type` alone and showed that
     * single number under every site carrying that type, so four
     * context-pack surfaces displayed identical pull-through — a
     * per-surface column that was never per-surface.
     */
    surfacedSite: text('surfaced_site'),
    pulledSite: text('pulled_site'),
    firstSurfacedAt: timestamp('first_surfaced_at', { withTimezone: true, mode: 'date' }),
    firstPulledAt: timestamp('first_pulled_at', { withTimezone: true, mode: 'date' }),
    timeToFirstPullMs: integer('time_to_first_pull_ms'),
    staleAtAccess: boolean('stale_at_access').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('memory_cohorts_grain_uk').on(t.runId, t.baselineGeneration, t.memoryType, t.memoryId),
    index('memory_cohorts_item_idx').on(t.memoryType, t.memoryId),
    index('memory_cohorts_project_idx').on(t.projectId, t.createdAt),
  ],
);

export type MemoryAccessDailyRow = typeof memoryAccessDaily.$inferSelect;
export type NewMemoryAccessDailyRow = typeof memoryAccessDaily.$inferInsert;
export type MemoryCohortRow = typeof memoryCohorts.$inferSelect;
export type NewMemoryCohortRow = typeof memoryCohorts.$inferInsert;
