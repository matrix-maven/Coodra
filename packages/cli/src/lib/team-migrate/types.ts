/**
 * `packages/cli/src/lib/team-migrate/types.ts` — Module 04 Phase 4.
 *
 * Shared types for the team-migration engine. The CLI commands
 * (`coodra team migrate` / `team join` / `team leave`) are thin
 * orchestration over `planner.ts` + `executor.ts` + `rollback.ts`.
 */

/**
 * Phase identifiers — used by the executor to track progress in
 * `_migration_attempts.last_phase` so a crashed migration can resume
 * from the last successfully-completed phase.
 */
export type MigrationPhase =
  | 'preflight'
  | 'snapshot'
  | 'plan'
  | 'reserve'
  | 'projects'
  | 'runs'
  | 'children'
  | 'org_scoped'
  | 'verify'
  | 'rewrite_local'
  | 'commit'
  | 'cleanup';

export const MIGRATION_PHASES: ReadonlyArray<MigrationPhase> = [
  'preflight',
  'snapshot',
  'plan',
  'reserve',
  'projects',
  'runs',
  'children',
  'org_scoped',
  'verify',
  'rewrite_local',
  'commit',
  'cleanup',
] as const;

/**
 * Per-table row counts — used in the dry-run plan summary and the
 * verify-phase parity check (local count must equal cloud count after
 * the migration commits).
 */
export interface MigrationCounts {
  readonly projects: number;
  readonly runs: number;
  readonly runEvents: number;
  readonly contextPacks: number;
  readonly decisions: number;
  readonly policies: number;
  readonly killSwitches: number;
  readonly featurePacks: number;
  readonly runDiffs: number;
}

export const ZERO_COUNTS: MigrationCounts = Object.freeze({
  projects: 0,
  runs: 0,
  runEvents: 0,
  contextPacks: 0,
  decisions: 0,
  policies: 0,
  killSwitches: 0,
  featurePacks: 0,
  runDiffs: 0,
});

/**
 * Slug-conflict descriptor produced by the planner during preflight.
 * Each conflict surfaces a local project whose slug already exists in
 * cloud for the same org. The CLI prompts the user to choose a
 * resolution per conflict before starting the executor.
 */
export interface SlugConflict {
  readonly localProjectId: string;
  readonly slug: string;
  readonly cloudProjectId: string;
  readonly resolution?: 'rename' | 'skip';
  /** When `resolution === 'rename'`, the new slug to use. */
  readonly renamedSlug?: string;
}

export interface MigrationPlan {
  readonly counts: MigrationCounts;
  readonly conflicts: ReadonlyArray<SlugConflict>;
  readonly clerkUserId: string;
  readonly clerkOrgId: string;
  readonly sourceMachine: string;
  /**
   * Map of (local projectId → cloud projectId). The planner pre-mints
   * uuids for new projects so the executor can write them atomically
   * without round-tripping for IDs.
   */
  readonly projectIdMap: Record<string, string>;
}

export interface MigrationAttemptHandle {
  readonly id: string;
  readonly clerkUserId: string;
  readonly clerkOrgId: string;
  readonly startedAt: Date;
  readonly status: 'running' | 'completed' | 'failed' | 'rolled_back';
  readonly lastPhase?: MigrationPhase;
}

export interface MigrationProgressEvent {
  readonly phase: MigrationPhase;
  readonly status: 'started' | 'completed' | 'failed';
  readonly detail?: string;
  readonly counts?: Partial<MigrationCounts>;
  readonly error?: string;
}

export type MigrationProgressReporter = (event: MigrationProgressEvent) => void;

/**
 * Result of a single migrate-or-resume invocation. Returned by the
 * executor after its terminal phase (commit / failed / rolled_back).
 */
export interface MigrationResult {
  readonly attemptId: string;
  readonly status: 'completed' | 'failed' | 'rolled_back';
  readonly counts: MigrationCounts;
  readonly durationMs: number;
  readonly error?: string;
  /** Path of the pre-migrate SQLite snapshot, for rollback recovery. */
  readonly snapshotPath: string;
}
