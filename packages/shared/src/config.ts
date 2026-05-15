import { z } from 'zod';

import { ValidationError } from './errors/index.js';

/**
 * Cross-cutting env variables defined by the Coodra architecture
 * (`system-architecture.md` §1, §19) and referenced by every service:
 *
 * - `NODE_ENV`  — standard Node runtime marker; defaults to `development`.
 * - `COODRA_MODE` — `solo` (SQLite, local loopback) or `team` (Postgres +
 *   Clerk JWT). Defaults to `solo`; a service that needs team-only env
 *   (e.g. `DATABASE_URL`) declares that requirement in its own schema
 *   via `.extend(...)` and feeds the combined schema to `parseEnv`.
 * - `LOG_LEVEL` — pino level. Defaults to `info`.
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  COODRA_MODE: z.enum(['solo', 'team']).default('solo'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

/**
 * Validates a `Record<string, string | undefined>` (typically `process.env`)
 * against a Zod schema and returns the typed result. On failure throws a
 * `ValidationError` whose message lists every invalid field — the service
 * is expected to fail fast at startup per §7.4 of the style guide.
 *
 * Callers should define their schema by extending `baseEnvSchema`:
 *
 *   const envSchema = baseEnvSchema.extend({
 *     DATABASE_URL: z.string().url(),
 *     MCP_SERVER_PORT: z.coerce.number().int().positive().default(3100),
 *   });
 *   export const env = parseEnv(envSchema);
 */
export function parseEnv<Schema extends z.ZodType>(
  schema: Schema,
  env: Record<string, string | undefined> = process.env,
): z.infer<Schema> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `  - ${path}: ${issue.message}`;
      })
      .join('\n');
    throw new ValidationError(`Invalid environment variables:\n${issues}`, result.error, {
      issueCount: result.error.issues.length,
    });
  }
  return result.data;
}

/** Convenience helper: the base env parsed with defaults applied. */
export function loadBaseEnv(env: Record<string, string | undefined> = process.env): BaseEnv {
  return parseEnv(baseEnvSchema, env);
}
