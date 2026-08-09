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

import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledMigrationsDir } from './runtime-paths.js';

const here = dirname(fileURLToPath(import.meta.url));

const sqlite = bundledMigrationsDir('sqlite');
if (sqlite !== null && typeof process.env.COODRA_MIGRATIONS_DIR !== 'string') {
  const source = fresherSourceMigrationsDir('sqlite', sqlite);
  const selected = source ?? sqlite;
  // bundledMigrationsDir returns the dialect-specific subfolder
  // (`<...>/sqlite`); strip the suffix because
  // `@coodra/db::MIGRATIONS_FOLDER` re-appends the dialect.
  process.env.COODRA_MIGRATIONS_DIR = selected.replace(/[\\/]+sqlite$/, '');
}

function fresherSourceMigrationsDir(dialect: 'sqlite' | 'postgres', bundledDialectDir: string): string | null {
  const bundledCount = sqlMigrationCount(bundledDialectDir);
  const candidates = [
    resolve(here, '..', '..', '..', 'db', 'drizzle', dialect),
    resolve(here, '..', '..', 'db', 'drizzle', dialect),
    resolve(here, '..', '..', '..', '..', 'packages', 'db', 'drizzle', dialect),
  ];
  for (const candidate of candidates) {
    const sourceCount = sqlMigrationCount(candidate);
    if (sourceCount > bundledCount) return candidate;
  }
  return null;
}

function sqlMigrationCount(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((entry) => /^\d{4,}_.+\.sql$/.test(entry)).length;
}
