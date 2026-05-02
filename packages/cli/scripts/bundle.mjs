#!/usr/bin/env node
// `scripts/bundle.mjs` — produces the publishable `@coodra/contextos-cli` artifact.
//
// Why this exists (decision dec_83ba10c1, 2026-05-02): every workspace
// package in this monorepo is `"private": true`, so the published CLI
// tarball cannot rely on npm-resolving `@coodra/contextos-{db,shared,policy}` at
// install time. Instead we bundle every workspace + npm dependency into
// self-contained ESM bundles, leaving only true native modules
// (better-sqlite3, sqlite-vec) as externals. The user installs
// `@coodra/contextos-cli`, npm fetches the two native deps from the public
// registry, and the bundles inside `@coodra/contextos-cli/dist` Just Work.
//
// Outputs (all under packages/cli/dist):
//   - dist/index.js            — bundled CLI entry (replaces tsc output)
//   - dist/runtime/mcp-server/index.js
//   - dist/runtime/hooks-bridge/index.js
//   - dist/runtime/drizzle/{sqlite,postgres}/...   ← migration SQL files
//
// Run order (wired in package.json#build):
//   1. tsc emits .d.ts + the loose `dist/lib/outbox/*.js` files that
//      workspace consumers (apps in dev) import via the
//      `@coodra/contextos-cli/lib/outbox` exports entry.
//   2. This script runs and OVERWRITES `dist/index.js` with the bundle,
//      and writes the `dist/runtime/` tree from scratch.
//
// Native deps left external:
//   better-sqlite3 — prebuilt binaries via npm; bundling would break the
//                    .node loader path.
//   sqlite-vec     — prebuilt extension binary loaded by better-sqlite3.

import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..');
const repoRoot = resolve(cliRoot, '..', '..');
const cliDist = resolve(cliRoot, 'dist');

const EXTERNALS = [
  'better-sqlite3',
  'sqlite-vec',
];

const SHARED_OPTS = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: EXTERNALS,
  sourcemap: 'linked',
  // ESM bundles that transitively import a CommonJS module need a working
  // `require`. esbuild emits `import { createRequire } from 'module'`
  // automatically when the banner is set; we provide it explicitly so the
  // bundle is robust against esbuild version drift.
  banner: {
    js: "import { createRequire as __cliCreateRequire } from 'node:module';\nconst require = __cliCreateRequire(import.meta.url);",
  },
  legalComments: 'none',
  logLevel: 'info',
};

async function bundleEntry(label, entry, outfile) {
  console.log(`bundle: ${label} → ${outfile}`);
  await build({
    ...SHARED_OPTS,
    entryPoints: [entry],
    outfile,
  });
}

async function main() {
  // 1) CLI entry. Overwrites the tsc output. We rebundle (rather than letting
  // tsc emit it) so workspace deps land inlined in the published tarball.
  await bundleEntry(
    '@coodra/contextos-cli',
    resolve(cliRoot, 'src/index.ts'),
    resolve(cliDist, 'index.js'),
  );

  // 2) mcp-server runtime bundle. Spawned by `contextos start` (HTTP
  // transport for daemons) and by Claude Code's `.mcp.json` (stdio transport
  // when the CLI is npm-installed).
  await bundleEntry(
    '@coodra/contextos-mcp-server',
    resolve(repoRoot, 'apps/mcp-server/src/index.ts'),
    resolve(cliDist, 'runtime/mcp-server/index.js'),
  );

  // 3) hooks-bridge runtime bundle. Spawned by `contextos start` (HTTP).
  await bundleEntry(
    '@coodra/contextos-hooks-bridge',
    resolve(repoRoot, 'apps/hooks-bridge/src/index.ts'),
    resolve(cliDist, 'runtime/hooks-bridge/index.js'),
  );

  // 4) Drizzle migration SQL files. The runtime resolver
  // (`lib/runtime-paths.ts`) sets `CONTEXTOS_MIGRATIONS_DIR` to this
  // location when launching bundles; `@coodra/contextos-db::migrateSqlite`
  // reads the env var and falls back to its package-relative default in
  // dev (workspace) mode.
  const drizzleSrc = resolve(repoRoot, 'packages/db/drizzle');
  const drizzleDst = resolve(cliDist, 'runtime/drizzle');
  rmSync(drizzleDst, { recursive: true, force: true });
  mkdirSync(drizzleDst, { recursive: true });
  cpSync(drizzleSrc, drizzleDst, { recursive: true });
  console.log(`bundle: copied drizzle/ → ${drizzleDst}`);

  console.log('bundle: done');
}

main().catch((err) => {
  console.error('bundle: failed:', err);
  process.exit(1);
});
