#!/usr/bin/env node
/*
 * Migration-lock guard — per decision "Addition B" and the S4 refinement
 * landed 2026-04-22 22:10 ("entries must be { file, blockMarker, sha256,
 * lineRange, generatedAt } — CI failures must be diffable").
 *
 * What it does:
 *   1. Walks `packages/db/drizzle/{sqlite,postgres}/ *.sql`.
 *   2. For every `-- @preserve-begin hand-written:<marker>` block, captures
 *      the inclusive line range, the marker name, and computes a sha256
 *      over the block BODY (exclusive of the begin/end sentinels).
 *   3. Diffs the computed set against the committed lock file at
 *      `packages/db/migrations.lock.json`.
 *   4. Exits 0 on match, exits 1 with a human-readable diff on mismatch.
 *
 * Three failure modes are surfaced explicitly:
 *   - MISSING_IN_FILE:     a lock entry exists but its block is gone from
 *                          the SQL file (drizzle-kit regenerated and wiped
 *                          the hand-written block).
 *   - MISSING_IN_LOCK:     a block exists in the SQL file but has no lock
 *                          entry (contributor added a new hand-written
 *                          block without running --write first).
 *   - SHA256_MISMATCH:     block exists in both places but its content
 *                          drifted — manual edit without re-lock.
 *
 * Run modes:
 *   --check   (default)   read-only verification, exits non-zero on drift.
 *                         Used by CI `verify` job and the `.githooks/pre-commit`
 *                         hook.
 *   --write               rewrite `migrations.lock.json` with the current
 *                         blocks. Used by a contributor after intentionally
 *                         editing a block: `pnpm --filter @coodra/db
 *                         check:migration-lock --write`.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const LOCK_PATH = join(PACKAGE_ROOT, 'migrations.lock.json');
const DRIZZLE_DIALECTS = ['sqlite', 'postgres'];

const BEGIN_RE = /^--\s*@preserve-begin\s+hand-written:([a-z0-9-]+)\s*$/i;
const END_RE = /^--\s*@preserve-end\s+hand-written:([a-z0-9-]+)\s*$/i;

const mode = process.argv.includes('--write') ? 'write' : 'check';

/**
 * @typedef {{ file: string; blockMarker: string; sha256: string; lineRange: [number, number]; generatedAt: string }} LockEntry
 */

/** Build the current entry set by scanning all drizzle migration files. */
async function extractEntries() {
  /** @type {LockEntry[]} */
  const entries = [];
  for (const dialect of DRIZZLE_DIALECTS) {
    const dir = join(PACKAGE_ROOT, 'drizzle', dialect);
    /** @type {string[]} */
    let files;
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') continue;
      throw err;
    }
    for (const file of files) {
      const relPath = relative(REPO_ROOT, join(dir, file));
      const content = await readFile(join(dir, file), 'utf8');
      const lines = content.split('\n');
      let open = null; // { marker: string; startLine: number; bodyLines: string[] }
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const beginMatch = BEGIN_RE.exec(line);
        const endMatch = END_RE.exec(line);
        if (beginMatch) {
          if (open) throw new Error(`${relPath}:${i + 1}: nested @preserve-begin before @preserve-end for marker "${open.marker}"`);
          open = { marker: beginMatch[1], startLine: i + 1, bodyLines: [] };
          continue;
        }
        if (endMatch) {
          if (!open) throw new Error(`${relPath}:${i + 1}: @preserve-end without matching @preserve-begin`);
          if (open.marker !== endMatch[1]) {
            throw new Error(
              `${relPath}:${i + 1}: marker mismatch — begin "${open.marker}" vs end "${endMatch[1]}"`,
            );
          }
          const body = open.bodyLines.join('\n');
          const sha256 = createHash('sha256').update(body).digest('hex');
          entries.push({
            file: relPath,
            blockMarker: open.marker,
            sha256,
            lineRange: [open.startLine, i + 1],
            generatedAt: new Date().toISOString(),
          });
          open = null;
          continue;
        }
        if (open) open.bodyLines.push(line);
      }
      if (open) throw new Error(`${relPath}: unterminated @preserve-begin marker "${open.marker}"`);
    }
  }
  return entries;
}

/**
 * @param {LockEntry[]} entries
 * @returns {string}
 */
function serializeLock(entries) {
  // Stable sort for deterministic output: by file, then by blockMarker.
  const sorted = [...entries].sort(
    (a, b) => a.file.localeCompare(b.file) || a.blockMarker.localeCompare(b.blockMarker),
  );
  return `${JSON.stringify(
    {
      $schema: 'https://coodra.dev/schemas/migrations-lock.v1.json',
      description:
        'Hand-written preserve-blocks inside drizzle migrations. Regenerate via `pnpm --filter @coodra/db check:migration-lock --write` after intentional edits. CI enforces drift via `pnpm --filter @coodra/db check:migration-lock`.',
      entries: sorted,
    },
    null,
    2,
  )}\n`;
}

async function main() {
  const current = await extractEntries();

  if (mode === 'write') {
    // Preserve generatedAt when the block sha256 is unchanged; otherwise
    // a second --write run against the same content would noisily churn the
    // lock file with new timestamps on every invocation.
    let previous = null;
    try {
      previous = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    const previousByKey = new Map((previous?.entries ?? []).map((e) => [`${e.file}::${e.blockMarker}`, e]));
    const merged = current.map((entry) => {
      const prior = previousByKey.get(`${entry.file}::${entry.blockMarker}`);
      if (prior && prior.sha256 === entry.sha256 && typeof prior.generatedAt === 'string') {
        return { ...entry, generatedAt: prior.generatedAt };
      }
      return entry;
    });
    await writeFile(LOCK_PATH, serializeLock(merged));
    console.log(`wrote ${relative(REPO_ROOT, LOCK_PATH)} with ${merged.length} entr${merged.length === 1 ? 'y' : 'ies'}`);
    return;
  }

  /** @type {{ entries: LockEntry[] }} */
  let locked;
  try {
    locked = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      console.error(`migration-lock: ${relative(REPO_ROOT, LOCK_PATH)} does not exist.`);
      console.error('run `pnpm --filter @coodra/db check:migration-lock --write` to create it.');
      process.exit(1);
    }
    throw err;
  }

  const keyOf = (/** @type {Pick<LockEntry, 'file' | 'blockMarker'>} */ e) => `${e.file}::${e.blockMarker}`;
  const currentByKey = new Map(current.map((e) => [keyOf(e), e]));
  const lockedByKey = new Map((locked.entries ?? []).map((e) => [keyOf(e), e]));

  /** @type {string[]} */
  const problems = [];

  for (const [key, lockedEntry] of lockedByKey) {
    const liveEntry = currentByKey.get(key);
    if (!liveEntry) {
      problems.push(
        `  MISSING_IN_FILE   ${key}\n` +
          `    locked sha256: ${lockedEntry.sha256}\n` +
          `    locked lineRange: ${JSON.stringify(lockedEntry.lineRange)}\n` +
          `    the hand-written block is gone from the file. drizzle-kit probably\n` +
          `    regenerated the migration and wiped it. restore the block from git\n` +
          `    history (git log -p ${lockedEntry.file}) and retry.`,
      );
      continue;
    }
    if (liveEntry.sha256 !== lockedEntry.sha256) {
      problems.push(
        `  SHA256_MISMATCH   ${key}\n` +
          `    expected sha256: ${lockedEntry.sha256}\n` +
          `    current  sha256: ${liveEntry.sha256}\n` +
          `    line range now : ${JSON.stringify(liveEntry.lineRange)} (was ${JSON.stringify(lockedEntry.lineRange)})\n` +
          `    the block body has drifted. if the edit was intentional, run\n` +
          `    \`pnpm --filter @coodra/db check:migration-lock --write\` and commit.`,
      );
    }
  }

  for (const [key, liveEntry] of currentByKey) {
    if (!lockedByKey.has(key)) {
      problems.push(
        `  MISSING_IN_LOCK   ${key}\n` +
          `    current sha256: ${liveEntry.sha256}\n` +
          `    current lineRange: ${JSON.stringify(liveEntry.lineRange)}\n` +
          `    a new hand-written block exists but is not in the lock file.\n` +
          `    run \`pnpm --filter @coodra/db check:migration-lock --write\` and commit.`,
      );
    }
  }

  if (problems.length > 0) {
    console.error(
      `migration-lock: ${problems.length} problem${problems.length === 1 ? '' : 's'} detected\n\n${problems.join('\n\n')}\n`,
    );
    process.exit(1);
  }

  console.log(`migration-lock: ok (${current.length} block${current.length === 1 ? '' : 's'} verified)`);
}

main().catch((err) => {
  console.error('migration-lock: unexpected error');
  console.error(err);
  process.exit(2);
});
