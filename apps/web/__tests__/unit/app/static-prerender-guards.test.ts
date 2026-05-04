import { describe, expect, it } from 'vitest';

/**
 * M04 Phase 2 S1 — F1 guard.
 *
 * Asserts that every Server-Component page that reads mutable state
 * (DB or filesystem) declares `export const dynamic = 'force-dynamic'`.
 * Without this, Next.js 15 prerenders the route at build time and the
 * served HTML reflects the build-time DB / filesystem snapshot — the
 * 2026-05-04 audit caught the dashboard rendering `Active runs: 3 /
 * Denials: 546` against an empty post-purge DB because of this.
 *
 * This test loads each route module and reads the named export. It
 * fails fast if a future commit drops the directive.
 */

describe('M04 Phase 2 S1 — F1 force-dynamic guards on data-reading routes', () => {
  it('/ (dashboard) declares dynamic = "force-dynamic"', async () => {
    const mod = await import('@/app/page');
    expect(mod.dynamic).toBe('force-dynamic');
  });

  it('/packs declares dynamic = "force-dynamic"', async () => {
    const mod = await import('@/app/packs/page');
    expect(mod.dynamic).toBe('force-dynamic');
  });

  it('/packs/[slug] declares dynamic = "force-dynamic"', async () => {
    const mod = await import('@/app/packs/[slug]/page');
    expect(mod.dynamic).toBe('force-dynamic');
  });

  it('/templates declares dynamic = "force-dynamic"', async () => {
    const mod = await import('@/app/templates/page');
    expect(mod.dynamic).toBe('force-dynamic');
  });
});
