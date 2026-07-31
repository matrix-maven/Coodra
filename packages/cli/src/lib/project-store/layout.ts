import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WriteOutcome } from '../init/types.js';

export const PROJECT_DIR_RELS = ['.coodra/recipes', '.coodra/graphify', '.coodra/wiki', '.coodra/work-packs'] as const;

async function ensureDir(path: string, dryRun: boolean): Promise<WriteOutcome> {
  if (!dryRun) await mkdir(path, { recursive: true });
  return { path, action: 'wrote', notes: 'ensured project directory exists' };
}

export async function ensureProjectLayout(root: string, dryRun: boolean): Promise<WriteOutcome[]> {
  const outcomes: WriteOutcome[] = [];
  for (const rel of PROJECT_DIR_RELS) {
    outcomes.push(await ensureDir(join(root, rel), dryRun));
  }
  return outcomes;
}
