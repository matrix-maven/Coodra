#!/usr/bin/env node
// `npm publish` runs `prepublishOnly` first. This script refuses the
// publish if dist/ is missing the bundled web runtime — which would
// otherwise ship a CLI tarball whose `coodra start` flow has no
// dashboard to launch. bundle.mjs soft-skips the web copy when
// apps/web-v2/.next/standalone is absent (so CI typecheck stays fast);
// this assert is the load-bearing safety net that turns "forgot to
// build web-v2" into a loud refusal at publish time.
//
// 2026-05-18 (beta.7) — added a freshness check after a beta.6
// stale-bundle ship. The Turbo task config was missing `apps/web-v2`'s
// source paths in its `inputs` glob, so source edits in `lib/`, `app/`,
// or `components/` didn't bust the build cache and bundle.mjs copied a
// days-old `.next/standalone`. CI was green (unit tests passed on
// fresh source) but the runtime artifact was stale. The freshness
// check below compares the source's newest .ts mtime against the
// bundled artifact's mtime — if the source is newer than the bundle,
// the publish is refused with a `pnpm --filter @coodra/web-v2 build`
// instruction. The Turbo fix is the durable fix; this assert is the
// last-line defense for cases where local state diverges from CI.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..');
const repoRoot = resolve(cliRoot, '..', '..');

const required = [
  // The Next.js standalone server entrypoint. If missing, the published
  // CLI has no web runtime and `coodra start --web` would fail at boot.
  resolve(cliRoot, 'dist/runtime/web/apps/web-v2/server.js'),
  // The MCP server runtime. Less likely to be missing (its build path
  // doesn't depend on web-v2) but still worth asserting before publish.
  resolve(cliRoot, 'dist/runtime/mcp-server/index.js'),
  resolve(cliRoot, 'dist/runtime/hooks-bridge/index.js'),
  resolve(cliRoot, 'dist/runtime/sync-daemon/index.js'),
];

const missing = required.filter((p) => !existsSync(p));
if (missing.length > 0) {
  console.error('publish refused: required bundle artifacts are missing.');
  console.error('');
  for (const p of missing) console.error('  - ' + p);
  console.error('');
  console.error('Fix:');
  console.error('  pnpm --filter @coodra/web-v2 build');
  console.error('  pnpm --filter @coodra/cli build');
  console.error('  npm publish ...');
  process.exit(1);
}

// Freshness check: walk apps/web-v2 source dirs (lib/, app/, components/,
// middleware.ts) and find the newest mtime, then compare against the
// bundled standalone's mtime. If source is newer, the bundle is stale.
function newestMtime(start) {
  let newest = 0;
  function walk(p) {
    let s;
    try {
      s = statSync(p);
    } catch {
      return;
    }
    if (s.isFile()) {
      if (s.mtimeMs > newest) newest = s.mtimeMs;
      return;
    }
    if (s.isDirectory()) {
      for (const child of readdirSync(p)) {
        if (child === 'node_modules' || child === '.next' || child === 'dist') continue;
        walk(join(p, child));
      }
    }
  }
  walk(start);
  return newest;
}

const webV2 = resolve(repoRoot, 'apps/web-v2');
const sourceRoots = ['lib', 'app', 'components', 'middleware.ts', 'next.config.ts'].map((p) => join(webV2, p));
const newestSource = Math.max(...sourceRoots.filter(existsSync).map(newestMtime));
const bundledServer = resolve(cliRoot, 'dist/runtime/web/apps/web-v2/server.js');
const bundledMtime = statSync(bundledServer).mtimeMs;

if (newestSource > bundledMtime) {
  console.error('publish refused: bundled web-v2 standalone is older than source.');
  console.error('');
  console.error('  newest apps/web-v2 source: ' + new Date(newestSource).toISOString());
  console.error('  bundled server.js:         ' + new Date(bundledMtime).toISOString());
  console.error('');
  console.error('Fix (delete caches + rebuild):');
  console.error('  find . -name ".tsbuildinfo" -not -path "*/node_modules/*" -delete');
  console.error('  rm -rf apps/web-v2/.next packages/cli/dist .turbo');
  console.error('  pnpm --filter @coodra/web-v2 build');
  console.error('  pnpm --filter @coodra/cli build');
  console.error('  npm publish ...');
  process.exit(1);
}

console.log('prepublish-assert: ok (' + required.length + ' artifacts present, web bundle fresher than source)');
