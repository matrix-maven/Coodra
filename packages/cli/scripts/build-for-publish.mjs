#!/usr/bin/env node
// `scripts/build-for-publish.mjs` — dependency-ordered workspace build for
// the npm publish path. Invoked by `prepublishOnly` before the bundle
// integrity assert.
//
// Why not just `turbo run build` / `pnpm -w run build`?
//   The published CLI tarball is self-contained: esbuild inlines every
//   workspace + JS dep into `dist/`, and `bundle.mjs` copies apps/web-v2's
//   `.next/standalone` into `dist/runtime/web/`. So the cli bundle DEPENDS
//   on web-v2 having been built first. But cli CANNOT declare
//   `@coodra/web-v2` as a dependency — web-v2 already depends on
//   `@coodra/cli` (for the `/lib/outbox` types), and the reverse edge would
//   be a cycle turbo refuses to schedule. Turbo's `^build` graph therefore
//   never orders web-v2 before cli's bundle, so a bare `turbo run build`
//   can bundle the cli BEFORE web-v2's standalone exists → the web copy is
//   soft-skipped → `prepublish-assert.mjs` refuses the publish.
//
//   This script pins the proven order (identical to `.github/workflows/
//   ci.yml`): shared → db → policy → cli(tsc) → web-v2 → cli(bundle). Each
//   step is a turbo-cached `pnpm --filter` build, so warm re-publishes are
//   fast. Exit non-zero on the first failing step.

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** @type {ReadonlyArray<readonly [pkg: string, script: string]>} */
const steps = [
  ['@coodra/shared', 'build'],
  ['@coodra/db', 'build'],
  ['@coodra/policy', 'build'],
  ['@coodra/cli', 'build:tsc-only'],
  ['@coodra/web-v2', 'build'],
  ['@coodra/cli', 'build'],
];

// Windows: apps/web-v2's Next.js `output: 'standalone'` build does not
// complete reliably on Windows, so we skip it to let the publish proceed.
// The consequence is REAL and loud below: a tarball built on Windows omits
// the web dashboard (`dist/runtime/web/`), so `coodra start` on that install
// runs headless (services.ts skips the web when its binary is absent).
// Publish the OFFICIAL, complete package from macOS / Linux / CI, where
// web-v2 builds. `prepublish-assert.mjs` relaxes its web requirement on
// Windows so the two stay consistent.
const isWindows = process.platform === 'win32';
const platformSteps = isWindows ? steps.filter(([pkg]) => pkg !== '@coodra/web-v2') : steps;

if (isWindows) {
  process.stderr.write(
    '\n[build-for-publish] ⚠ Windows detected — SKIPPING the apps/web-v2 build.\n' +
      '    The tarball produced here will NOT include the web dashboard, and\n' +
      '    `coodra start` on the published install will run without it.\n' +
      '    Publish the official, complete package from macOS / Linux / CI.\n',
  );
}

// `pnpm` on PATH is `pnpm.cmd` (or a corepack shim) on Windows, and
// `execFile` does NOT do PATHEXT resolution — a bare `execFileSync('pnpm', …)`
// throws ENOENT. `shell: true` delegates name resolution to the system shell
// (cmd.exe on Windows, /bin/sh elsewhere), which resolves the right shim. All
// arguments here are hardcoded constants, so shell interpolation is safe.
for (const [pkg, script] of platformSteps) {
  process.stdout.write(`\n[build-for-publish] pnpm --filter ${pkg} run ${script}\n`);
  try {
    execFileSync('pnpm', ['--filter', pkg, 'run', script], { cwd: repoRoot, stdio: 'inherit', shell: true });
  } catch (err) {
    process.stderr.write(
      `\n[build-for-publish] FAILED at "${pkg} run ${script}". ` +
        'Fix the build error above, or run `pnpm install` if this is a fresh clone.\n',
    );
    process.exit(typeof err?.status === 'number' ? err.status : 1);
  }
}

process.stdout.write('\n[build-for-publish] ordered workspace build complete.\n');
