import { type DbHandle, migratePostgres } from '@coodra/db';
import { sql } from 'drizzle-orm';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { createDbClient } from '../../../apps/mcp-server/src/lib/db.js';

/**
 * Boot a real Postgres container with pgvector + run migrations
 * 0000 → 0003. Used by the policy-decisions-idempotency scenario,
 * which needs cross-connection row-level dedupe semantics that
 * sqlite cannot fake (sqlite serialises writes per file).
 *
 * Image: `pgvector/pgvector:pg16` per `system-architecture.md` §4.2.
 *
 * On a fresh CI runner the first pull is slow (~30s); subsequent
 * runs reuse the cached image. `vitest.e2e.config.ts` uses
 * `hookTimeout: 120_000` to absorb this.
 */

export interface PostgresHandle {
  readonly handle: DbHandle;
  readonly databaseUrl: string;
  readonly close: () => Promise<void>;
}

export async function openPostgresHandle(): Promise<PostgresHandle> {
  const container: StartedTestContainer = await new GenericContainer('pgvector/pgvector:pg16')
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: 'coodra',
      POSTGRES_PASSWORD: 'coodra_e2e',
      POSTGRES_DB: 'coodra_e2e',
    })
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const databaseUrl = `postgres://coodra:coodra_e2e@${host}:${port}/coodra_e2e`;

  const { client, asInternalHandle } = createDbClient({
    mode: 'team',
    postgres: { databaseUrl },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'postgres') {
    await client.close();
    await container.stop();
    throw new Error('expected postgres handle');
  }
  // Migration 0000 references `vector(384)` — the pgvector extension
  // must exist BEFORE migrate runs. Drizzle migrations don't ship a
  // CREATE EXTENSION statement at 0000 (only 0001 has the safety net),
  // so the e2e harness creates it explicitly. The
  // `pgvector/pgvector:pg16` image bundles the extension binary; we
  // just have to opt in on this database.
  await handle.db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  await migratePostgres(handle.db);

  return {
    handle,
    databaseUrl,
    close: async () => {
      await client.close().catch(() => {});
      await container.stop().catch(() => {});
    },
  };
}
