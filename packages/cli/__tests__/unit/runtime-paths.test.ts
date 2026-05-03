import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bundledMigrationsDir, bundledRuntimeCandidates, resolveRuntimeBinary } from '../../src/lib/runtime-paths.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..', '..');

/**
 * Locks the runtime-paths.ts contract from decision dec_83ba10c1
 * (2026-05-02) — the resolver replaces the pre-fix `findRepoRoot`
 * walk in `init.ts` and `services.ts`. Three guarantees:
 *   1. The bundled artifact takes precedence when both are on disk.
 *   2. The candidate list covers the three runtime layouts (bundled
 *      CLI single-file, loose tsc dist, vitest-from-src).
 *   3. The migrations dir is co-located with the runtime tree.
 */
describe('runtime-paths.ts — bundled-wins resolver', () => {
  describe('bundledRuntimeCandidates', () => {
    it('lists candidates that include the dist/runtime/<app>/index.js shape', () => {
      const candidates = bundledRuntimeCandidates('mcp-server');
      const matchesShape = candidates.filter((c) => /[\\/]runtime[\\/]mcp-server[\\/]index\.js$/.test(c));
      expect(matchesShape.length).toBeGreaterThanOrEqual(1);
    });

    it('returns the same shape for hooks-bridge', () => {
      const candidates = bundledRuntimeCandidates('hooks-bridge');
      const matchesShape = candidates.filter((c) => /[\\/]runtime[\\/]hooks-bridge[\\/]index\.js$/.test(c));
      expect(matchesShape.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('resolveRuntimeBinary — bundled present', () => {
    it('prefers bundled `dist/runtime/mcp-server/index.js` over a monorepo path', async () => {
      const expectedBundle = resolve(cliRoot, 'dist', 'runtime', 'mcp-server', 'index.js');
      // Skip the assertion when the bundle has not been built yet; the
      // CI build step does this for the test job.
      if (!existsSync(expectedBundle)) {
        return;
      }
      const resolved = await resolveRuntimeBinary('mcp-server');
      expect(resolved.source).toBe('bundled');
      expect(resolved.path).toBe(expectedBundle);
    });

    it('returns the same shape for hooks-bridge', async () => {
      const expectedBundle = resolve(cliRoot, 'dist', 'runtime', 'hooks-bridge', 'index.js');
      if (!existsSync(expectedBundle)) {
        return;
      }
      const resolved = await resolveRuntimeBinary('hooks-bridge');
      expect(resolved.source).toBe('bundled');
      expect(resolved.path).toBe(expectedBundle);
    });
  });

  describe('bundledMigrationsDir', () => {
    it('returns the bundled drizzle/sqlite path when the runtime is built', () => {
      const expected = resolve(cliRoot, 'dist', 'runtime', 'drizzle', 'sqlite');
      if (!existsSync(expected)) {
        // Bundle not built — the resolver returns null, which is the
        // documented monorepo-fallback behaviour.
        expect(bundledMigrationsDir('sqlite')).toBeNull();
        return;
      }
      expect(bundledMigrationsDir('sqlite')).toBe(expected);
    });
  });
});
