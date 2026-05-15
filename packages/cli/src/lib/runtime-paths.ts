import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from './find-repo-root.js';

/**
 * `lib/runtime-paths.ts` — resolves the paths to the bundled runtime
 * artifacts shipped inside `@coodra/cli`'s npm tarball.
 *
 * Two resolution modes, in order:
 *
 *   1. **Bundled / published mode.** The CLI was installed via
 *      `npm i -g @coodra/cli` (or `npx`). The runtime artifacts live
 *      next to the CLI's compiled entry at `<cli-dist>/runtime/<app>/
 *      index.js`. Resolved relative to `import.meta.url` so every
 *      bundled-deploy install finds them deterministically.
 *
 *   2. **Monorepo / dev mode.** The CLI is being run from the
 *      `Coodra/` checkout (e.g. `pnpm --filter @coodra/cli dev`).
 *      `findRepoRoot()` locates `pnpm-workspace.yaml`; the runtime
 *      points at `apps/<app>/dist/index.js` so tsc-built dev binaries
 *      keep working without a bundle step.
 *
 * If neither resolves, `resolveRuntimeBinary` throws a structured
 * error with a clear remediation.
 *
 * Decision dec_83ba10c1 (2026-05-02): prior to this module the
 * published-install path was broken because `mcp-merge.ts` fell back
 * to `npx -y @coodra/cli mcp-stdio`, a subcommand that does not
 * exist. `services.ts:resolveServices` threw outright when
 * `findRepoRoot()` returned null. This module replaces both lookups
 * with one canonical resolver that tries bundled paths first.
 */

export type RuntimeApp = 'mcp-server' | 'hooks-bridge' | 'sync-daemon' | 'web';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Web Bundle W1 (2026-05-13). The web runtime is Next.js's standalone
 * output, which differs from the other runtimes:
 *   - other apps:  `<runtime>/<app>/index.js`
 *   - web:         `<runtime>/web/apps/web-v2/server.js`
 *
 * Reason for the asymmetry: Next.js's standalone tree is itself a
 * directory layout — it includes `node_modules/`, transpiled workspace
 * packages, and the project-relative `apps/web-v2/server.js` entry.
 * Flattening that into `runtime/web/index.js` would break the server's
 * `process.chdir(__dirname)` + relative `require('next')` lookup.
 *
 * Keep this constant in sync with the destination layout produced by
 * `scripts/bundle.mjs` step 6 and the monorepo dev path
 * `apps/web-v2/.next/standalone/apps/web-v2/server.js`.
 */
const WEB_STANDALONE_ENTRY_REL = 'apps/web-v2/server.js';

/**
 * Compute candidate paths to the bundled runtime entry, in resolution
 * order. Exported for unit tests and the doctor checks.
 *
 * The CLI's runtime-paths file is loaded from one of three layouts at
 * runtime; each places `<cli-dist>/runtime/<app>/index.js` at a
 * different walk distance:
 *
 *   - bundled CLI entry:  this file is part of `<cli-dist>/index.js`
 *                          (esbuild bundle). `here = <cli-dist>` and the
 *                          target sits at `here/runtime/<app>/index.js`.
 *   - loose tsc dist:      `<cli-dist>/lib/runtime-paths.js`. `here =
 *                          <cli-dist>/lib`; walk one `..` to reach
 *                          `<cli-dist>/runtime/<app>`.
 *   - vitest tsx (source): `<cli-pkg>/src/lib/runtime-paths.ts`. `here =
 *                          <cli-pkg>/src/lib`; walk `../../dist/runtime`.
 *
 * Listing all three keeps the resolver layout-agnostic so unit tests
 * exercising it from `src/` see the same bundled artifacts the
 * production-ready CLI does.
 */
export function bundledRuntimeCandidates(app: RuntimeApp): string[] {
  // Web differs from the other runtimes — it ships the Next.js standalone
  // tree with `apps/web-v2/server.js` as the entry. See WEB_STANDALONE_ENTRY_REL.
  const relEntry = app === 'web' ? WEB_STANDALONE_ENTRY_REL : `${app}/index.js`;
  const candidates =
    app === 'web'
      ? [
          resolve(here, 'runtime', 'web', WEB_STANDALONE_ENTRY_REL), // bundled CLI: here = <cli-dist>
          resolve(here, '..', 'runtime', 'web', WEB_STANDALONE_ENTRY_REL), // loose tsc dist
          resolve(here, '..', '..', 'runtime', 'web', WEB_STANDALONE_ENTRY_REL), // deeper loose dist
          resolve(here, '..', '..', 'dist', 'runtime', 'web', WEB_STANDALONE_ENTRY_REL), // vitest from src
          resolve(here, '..', '..', '..', 'dist', 'runtime', 'web', WEB_STANDALONE_ENTRY_REL), // vitest deeper from src
        ]
      : [
          resolve(here, 'runtime', relEntry), // bundled CLI: here = <cli-dist>
          resolve(here, '..', 'runtime', relEntry), // loose tsc dist: here = <cli-dist>/lib
          resolve(here, '..', '..', 'runtime', relEntry), // deeper loose dist
          resolve(here, '..', '..', 'dist', 'runtime', relEntry), // vitest from src: here = <cli-pkg>/src/lib
          resolve(here, '..', '..', '..', 'dist', 'runtime', relEntry), // vitest deeper from src
        ];
  return candidates;
}

/**
 * Resolve the absolute path of the bundled drizzle migrations folder
 * for the given dialect. Used to set `COODRA_MIGRATIONS_DIR` before
 * spawning a bundled mcp-server or hooks-bridge so the embedded
 * `@coodra/db::migrateSqlite` finds the SQL files inside the
 * published tarball.
 *
 * Returns null when the bundled drizzle directory is not present —
 * the caller (boot path) should fall back to leaving the env unset
 * so the workspace-default `MIGRATIONS_FOLDER` resolves via the
 * `@coodra/db` package's own `import.meta.url`.
 */
export function bundledMigrationsDir(dialect: 'sqlite' | 'postgres'): string | null {
  const candidates = [
    resolve(here, 'runtime', 'drizzle', dialect),
    resolve(here, '..', 'runtime', 'drizzle', dialect),
    resolve(here, '..', '..', 'runtime', 'drizzle', dialect),
    // Vitest from src (here = <cli-pkg>/src/lib) — runtime/drizzle is
    // produced by `scripts/bundle.mjs` under `<cli-pkg>/dist/runtime/`.
    resolve(here, '..', '..', 'dist', 'runtime', 'drizzle', dialect),
    resolve(here, '..', '..', '..', 'dist', 'runtime', 'drizzle', dialect),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface ResolveRuntimeBinaryOptions {
  /** Override `process.cwd()` — used by tests to simulate npm-installed runs. */
  readonly cwd?: string;
}

export interface ResolvedRuntimeBinary {
  readonly path: string;
  readonly source: 'bundled' | 'monorepo';
}

/**
 * Returns `{ path, source }` for the bundled or dev binary, in that
 * order. Bundled paths win — they are always self-contained, while
 * monorepo paths require `pnpm --filter ... build` to be up-to-date.
 *
 * Throws a structured `Error` (with a `code` property and remediation
 * line) when neither resolves. The CLI surfaces the message verbatim
 * via `program.ts`'s error handler.
 */
export async function resolveRuntimeBinary(
  app: RuntimeApp,
  options: ResolveRuntimeBinaryOptions = {},
): Promise<ResolvedRuntimeBinary> {
  // Bundled candidates first.
  for (const candidate of bundledRuntimeCandidates(app)) {
    if (existsSync(candidate)) return { path: candidate, source: 'bundled' };
  }
  // Fall back to monorepo lookup.
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = (await findRepoRoot(here)) ?? (await findRepoRoot(cwd));
  if (repoRoot !== null) {
    // Web's monorepo dev path is the in-repo standalone output; if a
    // contributor ran `pnpm --filter @coodra/web-v2 build`, the
    // server lives at apps/web-v2/.next/standalone/apps/web-v2/server.js.
    const monorepoPath =
      app === 'web'
        ? resolve(repoRoot, 'apps', 'web-v2', '.next', 'standalone', WEB_STANDALONE_ENTRY_REL)
        : resolve(repoRoot, 'apps', app, 'dist', 'index.js');
    if (existsSync(monorepoPath)) {
      return { path: monorepoPath, source: 'monorepo' };
    }
  }
  const err = new Error(
    `Cannot resolve @coodra/${app} runtime binary.\n` +
      'Looked in bundled paths (relative to the @coodra/cli install) and in the monorepo at ' +
      `apps/${app}/dist/index.js. ` +
      'If you are developing in the monorepo, run `pnpm --filter @coodra/cli build` to produce the bundle, ' +
      'or `pnpm --filter @coodra/' +
      app +
      ' build` to produce the dev dist.',
  );
  (err as { code?: string }).code = 'COODRA_RUNTIME_BINARY_NOT_FOUND';
  throw err;
}
