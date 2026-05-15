import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle config for the Postgres dialect (team-mode + integration tests
 * per `system-architecture.md` §4.2). Runs `drizzle-kit generate` against
 * `src/schema/postgres.ts`, writing numbered SQL migrations to
 * `drizzle/postgres/`. Requires `DATABASE_URL` at runtime migration time;
 * a development fallback is provided so `drizzle-kit generate` works
 * without a live Postgres connection (generation is offline — only
 * `drizzle-kit push` / `drizzle-kit studio` need live credentials).
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/postgres.ts',
  out: './drizzle/postgres',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://coodra:coodra_dev_password@127.0.0.1:5432/coodra',
  },
  extensionsFilters: ['postgis'],
  verbose: true,
  strict: true,
});
