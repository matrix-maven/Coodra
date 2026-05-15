import { defineConfig } from 'vitest/config';

/**
 * Integration-test config for `@coodra/mcp-server`.
 *
 * Separated from `vitest.config.ts` (unit) because:
 *   - integration tests may open real file descriptors (in-memory
 *     SQLite via better-sqlite3) and take longer — the unit config's
 *     aggressive coverage thresholds would penalise that;
 *   - the CI `verify` job runs unit only; the `integration` job
 *     shells to this config via `pnpm test:integration` (see
 *     root package scripts + `.github/workflows/ci.yml`);
 *   - future slices add `testcontainers` Postgres boot to this
 *     config's globalSetup (S17). Keeping the two configs apart lets
 *     us wire that once here without polluting `vitest.config.ts`.
 *
 * The S7a lib modules each ship one integration test under
 * `__tests__/integration/lib/<name>.test.ts`; the guard in the
 * description here is that every lib factory has a named test.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/integration/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 20_000,
  },
});
