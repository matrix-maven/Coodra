/**
 * `packages/cli/src/lib/env-bootstrap-shim` — must be imported in the CLI
 * binary's entry point AFTER `log-destination-shim` and BEFORE any module
 * that reads `process.env` at top level.
 *
 * Closes Finding A from the 2026-04-28 functionality test:
 *   `coodra init` writes a project-level `.env` (per spec §4.1) but
 *   no CLI command ever read it. Doctor check 20 was YELLOW because the
 *   `LOCAL_HOOK_SECRET` `init` wrote never reached `process.env`. Team
 *   mode silently fell back to solo for the same reason.
 *
 * What this shim does:
 *   1. Resolves `<COODRA_HOME>/.env` (user-global daemon defaults).
 *   2. Resolves `<process.cwd()>/.env` (per-project overrides — this is
 *      where `coodra init` writes).
 *   3. Layers them into `process.env`, with project-level winning over
 *      home-level on conflict, and existing `process.env` (shell
 *      exports) winning over both.
 *
 * After this runs:
 *   - `coodra doctor` sees LOCAL_HOOK_SECRET via `ctx.env` → check 20
 *     goes GREEN.
 *   - `coodra start` propagates the layered values to the daemon
 *     spawn env via `services.ts::resolveServices`.
 *   - Every other CLI command sees the same env, so future scripted
 *     callers don't have to re-export everything in their shell.
 *
 * Why a separate file with side-effect import:
 *   ESM evaluates imports in source order. A top-level statement that
 *   mutates `process.env` placed AFTER `import { buildProgram } …` would
 *   run after every transitively-imported `process.env.X` read at
 *   module-init time has already captured the original (undefined)
 *   value. Same ordering rationale as `log-destination-shim`.
 *
 * Test ergonomics:
 *   The shim is conditional on `COODRA_DISABLE_ENV_BOOTSTRAP=1` so
 *   the integration tests in `__tests__/integration/load-home-env.test.ts`
 *   (and the existing `services.test.ts` cases) can drive `loadHomeEnv`
 *   directly without the shim mutating `process.env` underneath them.
 */

import { resolveCoodraHome } from './coodra-home.js';
import { loadHomeEnv } from './load-home-env.js';

if (process.env.COODRA_DISABLE_ENV_BOOTSTRAP !== '1') {
  const coodraHome = resolveCoodraHome({ env: process.env });
  const layered = loadHomeEnv(coodraHome, process.cwd());
  for (const [key, value] of Object.entries(layered)) {
    if (process.env[key] === undefined && typeof value === 'string') {
      process.env[key] = value;
    }
  }
}
