import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '../../../../..');

/**
 * Regression guard for the COOD-34 capability axis.
 *
 * Originally this compared the live mcp-server path against
 * `apps/hooks-bridge` — the capability bootstrap had landed ONLY in the
 * bridge, which COOD-53 had already retired from the runtime path, so
 * the whole axis was inert for every real agent until `eb9ade3` wired
 * it natively.
 *
 * COOD-67 deleted the bridge, so the comparison half is moot (there is
 * no other path left to drift into). The load-bearing half is kept:
 * the live lifecycle + policy path must retain the capability wiring.
 */
describe('lifecycle capability wiring — live-path guard', () => {
  it('keeps active capability logic in the live mcp-server lifecycle path', async () => {
    const [liveLifecycle, liveCheckPolicy] = await Promise.all([
      readFile(join(repoRoot, 'apps/mcp-server/src/tools/lifecycle-event/handler.ts'), 'utf8'),
      readFile(join(repoRoot, 'apps/mcp-server/src/tools/check-policy/handler.ts'), 'utf8'),
    ]);

    // SessionStart bootstrap + per-event rehydrate.
    expect(liveLifecycle).toContain('updateRunActiveCapabilities');
    expect(liveLifecycle).toContain('getRunActiveCapabilities');
    // Capabilities reach the evaluator, and are stamped on the audit row.
    expect(liveCheckPolicy).toContain('activeCapabilities');
  });
});
