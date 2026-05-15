#!/usr/bin/env node
// `scripts/bundle.mjs` — produces the publishable `@coodra/cli` artifact.
//
// Why this exists (decision dec_83ba10c1, 2026-05-02): every workspace
// package in this monorepo is `"private": true`, so the published CLI
// tarball cannot rely on npm-resolving `@coodra/{db,shared,policy}` at
// install time. Instead we bundle every workspace + npm dependency into
// self-contained ESM bundles, leaving only true native modules
// (better-sqlite3, sqlite-vec) as externals. The user installs
// `@coodra/cli`, npm fetches the two native deps from the public
// registry, and the bundles inside `@coodra/cli/dist` Just Work.
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
//      `@coodra/cli/lib/outbox` exports entry.
//   2. This script runs and OVERWRITES `dist/index.js` with the bundle,
//      and writes the `dist/runtime/` tree from scratch.
//
// Native deps left external:
//   better-sqlite3 — prebuilt binaries via npm; bundling would break the
//                    .node loader path.
//   sqlite-vec     — prebuilt extension binary loaded by better-sqlite3.

import { build } from 'esbuild';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
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

// Ink's optional devtools peer. `ink/build/devtools.js` does a static
// `import 'react-devtools-core'`; that module is only ever reached via a
// dynamic `import('./devtools.js')` in `ink/build/reconciler.js`, itself
// gated on a runtime `import.meta.resolve('react-devtools-core')` that
// always throws in the shipped CLI (the package is not a dependency).
//
// It cannot be a bare external: with `format: 'esm'` + a single
// `outfile`, esbuild inlines the dynamically-imported devtools chunk and
// hoists its `import 'react-devtools-core'` to a *static* top-level
// import of the bundle — which Node resolves eagerly at load and
// crashes on. Aliasing to a local no-op stub lets esbuild inline a
// harmless module instead; the devtools code path stays unreachable.
const ALIAS = {
  'react-devtools-core': resolve(here, 'stubs/react-devtools-core.mjs'),
};

const SHARED_OPTS = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: EXTERNALS,
  alias: ALIAS,
  sourcemap: 'linked',
  // The interactive TUI (`src/tui/**/*.tsx`, `src/ui/ink/**/*.tsx`) uses
  // the React 17+ automatic JSX runtime — matches `tsconfig.json#jsx:
  // "react-jsx"`. esbuild would otherwise default to the classic
  // runtime and fail on `.tsx` files that never `import React`.
  jsx: 'automatic',
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
    '@coodra/cli',
    resolve(cliRoot, 'src/index.ts'),
    resolve(cliDist, 'index.js'),
  );

  // 2) mcp-server runtime bundle. Spawned by `coodra start` (HTTP
  // transport for daemons) and by Claude Code's `.mcp.json` (stdio transport
  // when the CLI is npm-installed).
  await bundleEntry(
    '@coodra/mcp-server',
    resolve(repoRoot, 'apps/mcp-server/src/index.ts'),
    resolve(cliDist, 'runtime/mcp-server/index.js'),
  );

  // 3) hooks-bridge runtime bundle. Spawned by `coodra start` (HTTP).
  await bundleEntry(
    '@coodra/hooks-bridge',
    resolve(repoRoot, 'apps/hooks-bridge/src/index.ts'),
    resolve(cliDist, 'runtime/hooks-bridge/index.js'),
  );

  // 3b) sync-daemon runtime bundle. Spawned by `coodra start` only
  // when COODRA_MODE=team (services.ts skips it in solo). Drains the
  // outbox `sync_to_cloud` queue and pulls cloud → local rows.
  await bundleEntry(
    '@coodra/sync-daemon',
    resolve(repoRoot, 'apps/sync-daemon/src/index.ts'),
    resolve(cliDist, 'runtime/sync-daemon/index.js'),
  );

  // 4) Drizzle migration SQL files. The runtime resolver
  // (`lib/runtime-paths.ts`) sets `COODRA_MIGRATIONS_DIR` to this
  // location when launching bundles; `@coodra/db::migrateSqlite`
  // reads the env var and falls back to its package-relative default in
  // dev (workspace) mode.
  const drizzleSrc = resolve(repoRoot, 'packages/db/drizzle');
  const drizzleDst = resolve(cliDist, 'runtime/drizzle');
  rmSync(drizzleDst, { recursive: true, force: true });
  mkdirSync(drizzleDst, { recursive: true });
  cpSync(drizzleSrc, drizzleDst, { recursive: true });
  console.log(`bundle: copied drizzle/ → ${drizzleDst}`);

  // 5) Bundled feature-pack templates (Module 08b S13). Resolved at
  // runtime by `lib/template-paths.ts::resolveBundledTemplatesDir`.
  // Shipping every directory under `packages/cli/templates/` lets
  // `init --template <name>` work on a fresh `npm i -g`.
  const templatesSrc = resolve(cliRoot, 'templates');
  const templatesDst = resolve(cliDist, 'templates');
  rmSync(templatesDst, { recursive: true, force: true });
  mkdirSync(templatesDst, { recursive: true });
  cpSync(templatesSrc, templatesDst, { recursive: true });
  console.log(`bundle: copied templates/ → ${templatesDst}`);

  // 6) Web Bundle Initiative W1 (2026-05-13). Bundle apps/web-v2 (Next.js
  // standalone output) as the fifth runtime so `npm i -g @coodra/cli`
  // ships the dashboard. The standalone tree includes Next.js's nft trace —
  // workspace packages (@coodra/db, @coodra/shared) and
  // native bindings (better-sqlite3, sqlite-vec) get copied alongside.
  //
  // Layout produced (because `outputFileTracingRoot` points at the repo root):
  //   apps/web-v2/.next/standalone/
  //     apps/web-v2/server.js   ← entry; `process.chdir(__dirname)` runs first
  //     apps/web-v2/.next/...   ← compiled chunks; static lives separately
  //     node_modules/...
  //     packages/...            ← workspace deps' compiled output
  //
  // Destination at packages/cli/dist/runtime/web/ preserves the structure
  // so the standalone server.js's relative module resolution still works.
  // .next/static/ lives outside the standalone tree by design and must be
  // re-attached at <standalone>/apps/web-v2/.next/static/ for chunk serving.
  const webStandaloneSrc = resolve(repoRoot, 'apps/web-v2/.next/standalone');
  const webStaticSrc = resolve(repoRoot, 'apps/web-v2/.next/static');
  const webPublicSrc = resolve(repoRoot, 'apps/web-v2/public');
  const webDst = resolve(cliDist, 'runtime/web');
  if (!existsSync(webStandaloneSrc)) {
    throw new Error(
      `bundle: web standalone tree not found at ${webStandaloneSrc}. ` +
        'Run `pnpm --filter @coodra/web-v2 build` first (this writes .next/standalone/).',
    );
  }
  rmSync(webDst, { recursive: true, force: true });
  mkdirSync(webDst, { recursive: true });
  cpSync(webStandaloneSrc, webDst, { recursive: true });
  // Reattach the static chunks. Standalone server reads them from
  // <standalone-root>/<project-relative-path>/.next/static.
  const webStaticDst = resolve(webDst, 'apps/web-v2/.next/static');
  if (existsSync(webStaticSrc)) {
    mkdirSync(webStaticDst, { recursive: true });
    cpSync(webStaticSrc, webStaticDst, { recursive: true });
  }
  // Reattach public/ if present. apps/web-v2/ currently has no public/
  // but copying when it exists keeps the bundle script forward-compatible.
  if (existsSync(webPublicSrc)) {
    const webPublicDst = resolve(webDst, 'apps/web-v2/public');
    mkdirSync(webPublicDst, { recursive: true });
    cpSync(webPublicSrc, webPublicDst, { recursive: true });
  }
  console.log(`bundle: copied apps/web-v2/.next/standalone → ${webDst}`);

  // 6a) Restore the top-level node_modules/<pkg> entries that pnpm
  // normally creates. Next.js's standalone tracer copies the .pnpm
  // content-addressable store into node_modules/.pnpm/ but, in pnpm
  // workspaces, does NOT recreate the top-level entries at
  // node_modules/<pkg> that resolve `require('next')` etc. Without
  // these, the standalone server.js fails immediately on boot with
  // `Error: Cannot find module 'next'`.
  //
  // We mirror what pnpm normally does: for every package directory
  // under .pnpm/<pkg-spec>@<version>/node_modules/<pkg>, create a real
  // directory copy at node_modules/<pkg>. Why a copy and not a
  // symlink: `npm pack` / `pnpm pack` follow symlinks when building
  // tarballs (the .tgz never contains the link itself), so when the
  // tarball lands on a user machine all top-level links would be
  // missing. Real directory copies survive the round-trip.
  //
  // .pnpm directory naming convention: `+` substitutes for `/` in
  // scoped package names (`@next+env@15.5.15` ⇒ `@next/env`). The
  // inner `node_modules/<pkg>` uses the real scope syntax.
  // W4 follow-up (2026-05-13) — packages with platform-specific native
  // bindings (.node ELF/Mach-O, .so/.dylib loadable extensions) MUST
  // NOT be copied into the bundle. If we ship the darwin-arm64 binary
  // and a Linux user installs the tarball, they get
  // `Error: invalid ELF header` on first request. Instead, leave them
  // out: they're declared as the CLI's own runtime `dependencies` in
  // package.json, so `npm install` fetches the correct prebuilt for
  // the user's platform AT INSTALL TIME. The web's require() walk
  // climbs out of the bundled standalone and finds them at the
  // CLI-package level (`<cli-pkg>/node_modules/<pkg>`).
  //
  // Keep this set in sync with the CLI's `dependencies` block — any
  // future native dep needs to land here too.
  const NATIVE_PACKAGES_TO_EXTERNALIZE = new Set(['better-sqlite3', 'sqlite-vec']);

  const pnpmDir = resolve(webDst, 'node_modules', '.pnpm');
  if (existsSync(pnpmDir)) {
    let linksCreated = 0;
    let skipped = 0;
    for (const pnpmEntry of readdirSync(pnpmDir)) {
      // Skip dotfiles / .modules.yaml lockfile metadata if pnpm wrote any.
      if (pnpmEntry.startsWith('.')) continue;
      const innerNm = resolve(pnpmDir, pnpmEntry, 'node_modules');
      if (!existsSync(innerNm)) continue;
      // Each `.pnpm/<spec>/node_modules/` may contain the real package
      // dir AND symlinks to that package's own dependencies. We only
      // want to create top-level links for the package whose name
      // matches the spec — derive it from the spec prefix.
      //
      // pnpm specs split on the FIRST `@` that is not at position 0:
      //   `next@15.5.15_react@19.2.5__react@19.2.5` → `next`
      //   `@next+env@15.5.15`                       → `@next/env`
      // Using lastIndexOf('@') breaks for peer-resolved deps where the
      // version segment itself contains another `<peer>@<ver>` suffix.
      const atIndex = pnpmEntry.indexOf('@', 1);
      if (atIndex <= 0) continue;
      const pkgSpec = pnpmEntry.slice(0, atIndex).replace(/\+/g, '/');
      // Externalize native packages — see NATIVE_PACKAGES_TO_EXTERNALIZE.
      if (NATIVE_PACKAGES_TO_EXTERNALIZE.has(pkgSpec)) {
        skipped += 1;
        continue;
      }
      // Verify the real package directory exists inside.
      const realDir = resolve(innerNm, pkgSpec);
      if (!existsSync(realDir)) continue;
      const topLevel = resolve(webDst, 'node_modules', pkgSpec);
      // If already present (pre-existing symlink/dir from cpSync), skip.
      try {
        lstatSync(topLevel);
        continue;
      } catch {
        // not present — proceed
      }
      // For scoped packages, ensure the parent @scope/ dir exists.
      if (pkgSpec.startsWith('@')) {
        mkdirSync(dirname(topLevel), { recursive: true });
      }
      // Deep-copy the package directory. `dereference: true` walks
      // symlinks inside the package (some pnpm-store packages link
      // to siblings in .pnpm/); we want real files at the destination
      // so the tarball is self-contained.
      cpSync(realDir, topLevel, { recursive: true, dereference: true });
      linksCreated += 1;
    }
    console.log(
      `bundle: restored ${linksCreated} top-level node_modules/<pkg> directories in web standalone ` +
        `(skipped ${skipped} native package${skipped === 1 ? '' : 's'} — Node will resolve them via the CLI's own runtime deps)`,
    );
    // After every package is mirrored to the top level, the .pnpm
    // store is redundant — Node's resolver finds packages by walking
    // up from the standalone entry, which lands at top-level
    // `node_modules/<pkg>`. Removing .pnpm halves the bundle size
    // (~60MB → ~25MB compressed in the tarball).
    rmSync(pnpmDir, { recursive: true, force: true });
    console.log(`bundle: removed redundant .pnpm/ store from web standalone`);
  }

  // Belt-and-braces — even if the natives somehow landed at top level
  // (e.g., from a previous Next.js trace strategy), wipe them. The
  // require() walk MUST climb to the CLI package's npm-installed copy.
  for (const pkg of NATIVE_PACKAGES_TO_EXTERNALIZE) {
    const topLevel = resolve(webDst, 'node_modules', pkg);
    if (existsSync(topLevel)) {
      rmSync(topLevel, { recursive: true, force: true });
      console.log(`bundle: cleared top-level node_modules/${pkg} (must resolve via CLI deps)`);
    }
  }

  console.log('bundle: done');
}

main().catch((err) => {
  console.error('bundle: failed:', err);
  process.exit(1);
});
