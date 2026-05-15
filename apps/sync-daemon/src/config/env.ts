import { ValidationError } from '@coodra/shared';
import { z } from 'zod';

/**
 * Sync-daemon env contract.
 *
 * - `DATABASE_URL` is required (the daemon has no purpose without a
 *   cloud Postgres to push to).
 * - `COODRA_HOME` and `COODRA_SQLITE_PATH` are read by `@coodra/db`'s
 *   `resolveSqlitePath` directly; we don't re-validate them here.
 * - `COODRA_SYNC_TICK_MS` and `COODRA_SYNC_LEASE_MS` let operators
 *   tune the worker without code changes. Defaults match M03.1's
 *   audit-write OutboxWorker so there is one number to remember.
 */
const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required (sync-daemon has no purpose without a cloud Postgres target)'),
  COODRA_SYNC_TICK_MS: z.coerce.number().int().positive().default(1000),
  COODRA_SYNC_LEASE_MS: z.coerce.number().int().positive().default(30_000),
});

export type SyncDaemonEnv = z.infer<typeof envSchema>;

export function loadSyncDaemonEnv(raw: NodeJS.ProcessEnv = process.env): SyncDaemonEnv {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n');
    throw new ValidationError(`sync-daemon env invalid:\n${issues}`);
  }
  return parsed.data;
}

export const env: SyncDaemonEnv = loadSyncDaemonEnv();
