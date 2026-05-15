import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Phase F.6+ (2026-05-12) — auto-load ~/.coodra/.env on web boot.
 *
 * Without this, the operator has to pass COODRA_MODE,
 * COODRA_TEAM_ORG_ID, DATABASE_URL etc. inline when starting `pnpm
 * dev`, which is brittle (forget the env → web runs in solo, role
 * checks silently disabled, identity wrong). Auto-loading mirrors what
 * the daemons already do via @coodra/shared::loadHomeEnv and
 * keeps the three surfaces (daemons / web / CLI) in lockstep.
 *
 * Precedence: ~/.coodra/.env OVERRIDES the web's .env.local for
 * Coodra-managed keys (COODRA_*, LOCAL_HOOK_SECRET, DATABASE_URL,
 * CLERK_*). The machine config is the source of truth — .env.local is
 * developer convenience and gets overruled. For non-Coodra keys
 * we preserve .env.local (existing-env-wins).
 *
 * Why this asymmetry: the apps/web-v2/.env.local ships with
 * COODRA_MODE=solo as a baseline; without override, the web stays
 * in solo even after the user has run `team init`. That's exactly the
 * "I'm in team mode but the web shows solo" symptom we just hit.
 */
function loadCoodraHomeEnv(): void {
  const home = process.env.COODRA_HOME ?? resolve(homedir(), '.coodra');
  const envPath = resolve(home, '.env');
  if (!existsSync(envPath)) return;
  const COODRA_MANAGED_PREFIX = /^(COODRA_|CLERK_|LOCAL_HOOK_SECRET$|DATABASE_URL$|NEXT_PUBLIC_CLERK_)/;
  try {
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      // Coodra-managed keys: home env wins (override .env.local).
      // Everything else: existing env wins (preserve dev overrides).
      if (!COODRA_MANAGED_PREFIX.test(key) && process.env[key] !== undefined) continue;
      process.env[key] = value;
    }
  } catch {
    // ignore — web will boot in whatever env it has.
  }
}
loadCoodraHomeEnv();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Web Bundle W1 (2026-05-13) — emit a self-contained .next/standalone/
  // tree so packages/cli/scripts/bundle.mjs can copy it into the npm
  // tarball as `dist/runtime/web/`. With `output: 'standalone'` Next.js
  // runs Vercel's Node File Tracer over the server-side import graph and
  // copies every needed file (including workspace transpiled output and
  // listed serverExternalPackages) into .next/standalone/.
  output: 'standalone',
  // Next.js's monorepo support is keyed off `outputFileTracingRoot` —
  // pin it to the repo root so the tracer follows the workspace symlinks
  // for `@coodra/db` + `@coodra/shared` and copies
  // their compiled `dist/` into the standalone output.
  outputFileTracingRoot: resolve(__dirname, '..', '..'),
  transpilePackages: ['@coodra/db', '@coodra/shared'],
  // Native bindings (better-sqlite3) and packages that ship platform-
  // specific loadable extensions (sqlite-vec) must NOT be webpack-bundled
  // by Next.js — bundling breaks the .node / .dylib / .so loader paths.
  // Listing them here tells Next.js to leave them as runtime `require()`
  // calls and have nft copy the package directory into standalone.
  serverExternalPackages: ['better-sqlite3', 'sqlite-vec'],
  typedRoutes: false,
};

export default nextConfig;
