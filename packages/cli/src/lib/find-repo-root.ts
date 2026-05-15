import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Walks up from `start` looking for a directory that contains `pnpm-workspace.yaml`.
 * Used by `doctor` checks 9–11 to locate the apps/* binaries when the CLI is run
 * from inside the coodra monorepo. Returns null if no repo root is found
 * (e.g. when the CLI is `npm i -g`-installed from npm registry).
 */
export async function findRepoRoot(start: string): Promise<string | null> {
  let current = resolve(start);
  for (let i = 0; i < 12; i++) {
    try {
      await access(join(current, 'pnpm-workspace.yaml'));
      return current;
    } catch {
      // not here, keep walking up
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}
