import { defineConfig } from 'vitest/config';

/**
 * E2E test configuration for Coodra Module 02 closeout (S17).
 *
 * E2E tests live at `__tests__/e2e/<scenario>.test.ts` per
 * `essentialsforclaude/06-testing.md` §6.7 — they cross workspace
 * boundaries (mcp-server + db + shared) by design and so cannot live
 * inside a single workspace's `__tests__/` tree.
 *
 * Discipline:
 *   - `testTimeout: 60_000`: each test exercises a real Postgres
 *     container, a real MCP transport, and a full tool round-trip.
 *     30s is too tight on cold-pull testcontainers + first-call JIT.
 *   - `hookTimeout: 120_000`: `beforeAll` pulls the
 *     `pgvector/pgvector:pg16` image on first run; first-time pulls
 *     are slow on a fresh CI runner.
 *   - `fileParallelism: false`: testcontainers issues port reservations
 *     to the kernel; running scenarios in parallel risks port exhaustion
 *     and noisy "EADDRINUSE" failures on busy CI machines.
 *   - `pool: 'forks'`: each scenario gets a fresh process, isolating
 *     ESM module-load state (the env singleton is a load-time-frozen
 *     object — re-importing in the same vitest worker produces stale
 *     references).
 */
export default defineConfig({
  test: {
    name: 'e2e',
    include: ['__tests__/e2e/**/*.test.ts'],
    exclude: ['**/_helpers/**', 'node_modules/**', 'dist/**'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: 'forks',
    environment: 'node',
    reporters: ['default'],
  },
});
