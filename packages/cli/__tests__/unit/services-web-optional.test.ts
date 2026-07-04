import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Windows-readiness / core-only build (2026-06-16): the `web` dashboard is
 * OPTIONAL. A core build (Windows CI that skips the expensive Next.js
 * standalone, or a contributor who hasn't run `pnpm --filter @coodra/web-v2
 * build`) ships no web runtime. `resolveServices` must SKIP web in that case
 * instead of aborting the whole batch — otherwise `coodra start` (and every
 * caller) fails outright because the optional dashboard binary is absent.
 * mcp-server / hooks-bridge / sync-daemon stay strict.
 *
 * This file mocks `runtime-paths` so resolution is deterministic regardless
 * of whether the bundle exists on disk — hence its own file (the sibling
 * services.test.ts asserts against the REAL bundled paths and must not see
 * this mock).
 */
vi.mock('../../src/lib/runtime-paths.js', () => ({
  resolveRuntimeBinary: vi.fn(async (app: string) => {
    if (app === 'web') {
      const err = new Error('Cannot resolve @coodra/web runtime binary.');
      (err as { code?: string }).code = 'COODRA_RUNTIME_BINARY_NOT_FOUND';
      throw err;
    }
    return { path: `/fake/runtime/${app}/index.js`, source: 'bundled' as const };
  }),
  bundledMigrationsDir: vi.fn(() => null),
}));

import { resolveRuntimeBinary } from '../../src/lib/runtime-paths.js';
import { resolveServices } from '../../src/lib/services.js';

describe('resolveServices — web is optional when its runtime bundle is absent', () => {
  afterEach(() => {
    vi.mocked(resolveRuntimeBinary).mockClear();
  });

  it('omits web (does NOT throw) when the web binary cannot be resolved', async () => {
    const resolved = await resolveServices({
      coodraHome: '/var/test/.coodra',
      env: { COODRA_MODE: 'solo' } as NodeJS.ProcessEnv,
    });
    const names = resolved.map((r) => r.descriptor.name);
    expect(names).toContain('mcp-server');
    expect(names).toContain('hooks-bridge');
    expect(names).not.toContain('web');
  });

  it('STILL throws when an essential service (mcp-server) binary cannot be resolved', async () => {
    // mcp-server is the first SERVICES entry, so the one-shot override hits it.
    vi.mocked(resolveRuntimeBinary).mockImplementationOnce(async () => {
      const err = new Error('Cannot resolve @coodra/mcp-server runtime binary.');
      (err as { code?: string }).code = 'COODRA_RUNTIME_BINARY_NOT_FOUND';
      throw err;
    });
    await expect(
      resolveServices({ coodraHome: '/var/test/.coodra', env: { COODRA_MODE: 'solo' } as NodeJS.ProcessEnv }),
    ).rejects.toThrow(/mcp-server runtime binary/);
  });
});
