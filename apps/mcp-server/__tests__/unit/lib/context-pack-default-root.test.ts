import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultContextPacksRoot } from '../../../src/lib/context-pack.js';

/**
 * Locks F13 closure (verification 2026-04-27) — `save_context_pack`'s
 * auto-saved markdown lands in `~/.coodra/packs/` by default,
 * separate from the curated archive at `docs/context-packs/` which
 * holds hand-named module closeouts.
 *
 * Before this fix the default was `<cwd>/docs/context-packs`, which
 * meant every save_context_pack call dropped a runId-named file into
 * the repo. Module 03's S15 commit forgot to track its auto-saved
 * counterpart, leaving an orphan untracked file in the working tree.
 * The new default keeps runtime artefacts out of the repo entirely;
 * the override knob (`COODRA_CONTEXT_PACKS_ROOT` env or
 * `contextPacksRoot` constructor option) still applies.
 */

describe('defaultContextPacksRoot — F13 closure', () => {
  it('returns ~/.coodra/packs (NOT <cwd>/docs/context-packs)', () => {
    expect(defaultContextPacksRoot()).toBe(resolve(homedir(), '.coodra', 'packs'));
  });

  it('does NOT contain "docs/context-packs"', () => {
    expect(defaultContextPacksRoot()).not.toContain('docs/context-packs');
  });
});
