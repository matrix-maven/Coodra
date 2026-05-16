#!/usr/bin/env node
// `npm publish` runs `prepublishOnly` first. This script refuses the
// publish if dist/ is missing the bundled web runtime — which would
// otherwise ship a CLI tarball whose `coodra start` flow has no
// dashboard to launch. bundle.mjs soft-skips the web copy when
// apps/web-v2/.next/standalone is absent (so CI typecheck stays fast);
// this assert is the load-bearing safety net that turns "forgot to
// build web-v2" into a loud refusal at publish time.

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..');
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

console.log('prepublish-assert: ok (' + required.length + ' artifacts present)');
