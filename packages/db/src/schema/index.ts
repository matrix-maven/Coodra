/**
 * Dialect-neutral re-export.
 *
 * Consumers that know which dialect they want should import directly
 * from `@coodra/db/schema/sqlite` or `@coodra/db/schema/postgres`
 * — the two namespaces have identical column sets but different
 * underlying types, and mixing them in one file defeats drizzle's
 * dialect-specific query builder.
 *
 * This index re-exports both as namespaces for places (schema-parity
 * tests, documentation generators) that need to compare them.
 */

export * as postgresSchema from './postgres.js';
export * as sqliteSchema from './sqlite.js';
