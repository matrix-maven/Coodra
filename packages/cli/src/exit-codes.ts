// Stable exit-code contract per `docs/feature-packs/08a-cli/techstack.md` §"Process exit codes"
// + `docs/feature-packs/08b-cli-expansion/techstack.md` (codes 5–6 reserved 2026-05-03).
// These codes MUST be stable across versions — shell scripts on user machines depend on them.
// Adding a new code is non-breaking; reusing or removing a code is a major version bump.
export const EXIT_OK = 0;
export const EXIT_USER_RECOVERABLE = 1;
export const EXIT_USER_ACTION_REQUIRED = 2;
export const EXIT_ENVIRONMENT_PROBLEM = 3;
export const EXIT_SERVICE_STARTUP_FAILED = 4;
/**
 * Module 08b S3 (2026-05-03): a `contextos pause` call that would
 * insert a duplicate active switch at the same (scope, target). The
 * CLI returns the existing row's id and exits 5 so shell scripts can
 * branch on "no-op vs newly-paused" without parsing stdout.
 */
export const EXIT_KILL_SWITCH_REFUSAL = 5;
/**
 * Module 08b S6 (planned): `contextos db backup`/`db restore` precondition
 * failures (disk full, source not a SQLite file, daemons running, etc.).
 * Reserved here so the constant stays stable across slices.
 */
export const EXIT_BACKUP_RESTORE_PRECONDITION = 6;
export const EXIT_UNIMPLEMENTED = 99;

export type ExitCode =
  | typeof EXIT_OK
  | typeof EXIT_USER_RECOVERABLE
  | typeof EXIT_USER_ACTION_REQUIRED
  | typeof EXIT_ENVIRONMENT_PROBLEM
  | typeof EXIT_SERVICE_STARTUP_FAILED
  | typeof EXIT_KILL_SWITCH_REFUSAL
  | typeof EXIT_BACKUP_RESTORE_PRECONDITION
  | typeof EXIT_UNIMPLEMENTED;
