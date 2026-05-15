// `lib/migrations-dir-shim.ts` — when the CLI is running as a bundled
// artifact (`@coodra/cli/dist/runtime/...`), set
// `COODRA_MIGRATIONS_DIR` to the bundled drizzle path BEFORE
// `@coodra/db`'s module-level `MIGRATIONS_FOLDER` constant
// evaluates. Required because that constant is resolved once at
// module load via `import.meta.url`, and the bundled CLI's own
// `import.meta.url` walks land outside the inlined `drizzle/`.
//
// Decision dec_83ba10c1 (2026-05-02). Mirror of
// `log-destination-shim.ts` — fires from the very top of `src/
// index.ts` so every downstream `import '@coodra/db'` sees the
// right env.
//
// In monorepo dev (no bundled artifacts on disk), this is a no-op:
// `bundledMigrationsDir` returns null, the default
// `MIGRATIONS_FOLDER` walks `<db-pkg>/dist/../drizzle/<dialect>`
// correctly, and we leave the env alone.

import { bundledMigrationsDir } from './runtime-paths.js';

const sqlite = bundledMigrationsDir('sqlite');
if (sqlite !== null && typeof process.env.COODRA_MIGRATIONS_DIR !== 'string') {
  // bundledMigrationsDir returns the dialect-specific subfolder
  // (`<...>/sqlite`); strip the suffix because
  // `@coodra/db::MIGRATIONS_FOLDER` re-appends the dialect.
  process.env.COODRA_MIGRATIONS_DIR = sqlite.replace(/[\\/]+sqlite$/, '');
}
