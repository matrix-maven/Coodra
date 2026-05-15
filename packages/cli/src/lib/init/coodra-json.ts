import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WriteOutcome } from './types.js';

export interface WriteCoodraJsonOptions {
  readonly cwd: string;
  readonly projectSlug: string;
  readonly force: boolean;
  readonly dryRun: boolean;
}

export async function writeCoodraJson(options: WriteCoodraJsonOptions): Promise<WriteOutcome> {
  const path = join(options.cwd, '.coodra.json');
  const baseline = { projectSlug: options.projectSlug };
  const baselineSerialised = `${JSON.stringify(baseline, null, 2)}\n`;
  const exists = await pathExists(path);

  if (!exists) {
    if (!options.dryRun) await writeFile(path, baselineSerialised, 'utf8');
    return { path, action: 'wrote', notes: `wrote projectSlug='${options.projectSlug}'` };
  }

  const raw = await readFile(path, 'utf8');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (options.force) {
      if (!options.dryRun) await writeFile(path, baselineSerialised, 'utf8');
      return { path, action: 'forced', notes: 'replaced corrupt .coodra.json with baseline' };
    }
    return { path, action: 'unchanged', notes: 'corrupt .coodra.json (pass --force to overwrite)' };
  }

  if (options.force) {
    if (!options.dryRun) await writeFile(path, baselineSerialised, 'utf8');
    return { path, action: 'forced', notes: `forced projectSlug='${options.projectSlug}'` };
  }

  if (parsed.projectSlug === options.projectSlug) {
    return { path, action: 'unchanged', notes: `projectSlug already '${options.projectSlug}'` };
  }

  // Drift — preserve user value (Decision 3).
  return {
    path,
    action: 'unchanged',
    notes: `projectSlug='${parsed.projectSlug}' differs from requested '${options.projectSlug}'; pass --force to overwrite`,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
