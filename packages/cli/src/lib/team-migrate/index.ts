/**
 * `packages/cli/src/lib/team-migrate/` — Module 04 Phase 4.
 *
 * The team-migration engine. Consumed by:
 *   - `coodra team migrate` — solo → team data move.
 *   - `coodra team join`    — full cloud pull seed (uses planner counts).
 *   - `coodra team leave`   — local team cleanup (rollback for already-
 *                                migrated state is out of scope; this is
 *                                local-side only).
 *
 * The module split mirrors the spec § structure:
 *   - planner.ts   → preflight + slug-conflict detection + plan build
 *   - executor.ts  → 12-phase pipeline with checkpointing
 *   - rollback.ts  → undo by attempt_id, restore local snapshot
 *   - types.ts     → shared shapes
 */

export { assertNoInFlightAttempt, executeMigration, snapshotLocalDb } from './executor.js';
export { applyConflictResolutions, buildMigrationPlan } from './planner.js';
export { rollbackMigration } from './rollback.js';
export {
  MIGRATION_PHASES,
  type MigrationAttemptHandle,
  type MigrationCounts,
  type MigrationPhase,
  type MigrationPlan,
  type MigrationProgressEvent,
  type MigrationProgressReporter,
  type MigrationResult,
  type SlugConflict,
  ZERO_COUNTS,
} from './types.js';
