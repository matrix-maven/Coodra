import { rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { detectProjectRoot } from '../lib/detect.js';
import { type ManifestEntry, pruneManifestEntries, readManifest } from '../lib/project-store/index.js';
import { terminalReadPrompt } from '../lib/terminal-prompt.js';
import { commandTitle, hintLine, type KvRow, kvBlock, pc, sectionHead, terminalWidth } from '../ui/index.js';

/**
 * `coodra files status|clean` — read/act on the generated-file manifest
 * (`.coodra/manifest.json`). `status` shows every file Coodra generated with
 * its owner + cleanup policy + on-disk presence. `clean` removes files by
 * policy, SAFE BY DEFAULT: it deletes only `safe` artifacts; `ask` files
 * (agent configs, which may carry user content) need `--force` or an
 * interactive yes; `preserve` files and `global` (cross-project) files are
 * never touched — those are managed by `coodra agent remove` / `coodra
 * uninstall`.
 */

export interface FilesCommandOptions {
  readonly force?: boolean;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  // Test / advanced overrides.
  readonly cwd?: string;
  readonly userHome?: string;
  readonly readPrompt?: (prompt: string) => Promise<string>;
}

export interface FilesIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_FILES_IO: FilesIO = {
  writeStdout: (chunk) => {
    process.stdout.write(chunk);
  },
  writeStderr: (chunk) => {
    process.stderr.write(chunk);
  },
  exit: (code) => {
    process.exit(code);
  },
};

/** Resolve a manifest entry's path to an absolute path for stat/rm. */
function absOf(entry: ManifestEntry, root: string): string {
  return isAbsolute(entry.path) ? entry.path : join(root, entry.path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveRoot(options: FilesCommandOptions): Promise<string> {
  const userHome = options.userHome ?? homedir();
  return options.cwd ?? (await detectProjectRoot(process.cwd(), { homeDir: userHome })).root;
}

async function noManifest(io: FilesIO, root: string, json: boolean, command: string): Promise<never> {
  if (json) {
    io.writeStdout(`${JSON.stringify({ ok: true, command, projectRoot: root, entries: [] }, null, 2)}\n`);
  } else {
    io.writeStdout(`${commandTitle('Files', command, { width: terminalWidth(), indent: 0 })}\n`);
    io.writeStdout(`  ${pc.gray(`project root: ${root}`)}\n`);
    io.writeStdout(
      `\n  ${pc.gray('No .coodra/manifest.json yet — run `coodra init` from the project root to generate it.')}\n`,
    );
  }
  return io.exit(EXIT_OK);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function runFilesStatusCommand(
  options: FilesCommandOptions = {},
  io: FilesIO = DEFAULT_FILES_IO,
): Promise<never> {
  const json = options.json === true;
  const root = await resolveRoot(options);
  const manifest = await readManifest(root);
  if (manifest === null) return noManifest(io, root, json, 'status');

  const rows = await Promise.all(manifest.entries.map(async (e) => ({ ...e, present: await exists(absOf(e, root)) })));

  if (json) {
    io.writeStdout(
      `${JSON.stringify({ ok: true, command: 'status', projectRoot: root, projectSlug: manifest.projectSlug, entries: rows }, null, 2)}\n`,
    );
    return io.exit(EXIT_OK);
  }

  io.writeStdout(`${commandTitle('Files', 'generated-file manifest', { width: terminalWidth(), indent: 0 })}\n`);
  io.writeStdout(`  ${pc.gray(`project root: ${root}  ·  ${rows.length} tracked file(s)`)}\n`);

  // Group by owner for a readable report.
  const owners = [...new Set(rows.map((r) => r.owner))].sort();
  let slot = 1;
  for (const owner of owners) {
    io.writeStdout(`${sectionHead(String(slot).padStart(2, '0'), owner)}\n`);
    slot += 1;
    const kv: KvRow[] = rows
      .filter((r) => r.owner === owner)
      .map((r) => ({
        glyph: r.present ? pc.green('✓') : pc.gray('✗'),
        key: r.path,
        value: `${r.kind} · ${r.cleanup}${r.scope === 'global' ? ' · global' : ''}${r.present ? '' : ' · (deleted)'}`,
      }));
    io.writeStdout(`${kvBlock(kv, { keyWidth: 44, indent: 2 })}\n`);
  }
  io.writeStdout(`\n${hintLine('`coodra files clean` removes safe generated files · preserve/global files stay.')}\n`);
  return io.exit(EXIT_OK);
}

// ---------------------------------------------------------------------------
// clean
// ---------------------------------------------------------------------------

interface CleanPlanItem {
  readonly entry: ManifestEntry;
  readonly abs: string;
  readonly action: 'delete' | 'ask' | 'skip-preserve' | 'skip-global' | 'skip-missing';
}

export async function runFilesCleanCommand(
  options: FilesCommandOptions = {},
  io: FilesIO = DEFAULT_FILES_IO,
): Promise<never> {
  const json = options.json === true;
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const root = await resolveRoot(options);
  const manifest = await readManifest(root);
  if (manifest === null) return noManifest(io, root, json, 'clean');

  // Classify each entry into a clean action.
  const plan: CleanPlanItem[] = [];
  for (const entry of manifest.entries) {
    const abs = absOf(entry, root);
    if (entry.scope === 'global') {
      plan.push({ entry, abs, action: 'skip-global' });
    } else if (entry.cleanup === 'preserve') {
      plan.push({ entry, abs, action: 'skip-preserve' });
    } else if (!(await exists(abs))) {
      plan.push({ entry, abs, action: 'skip-missing' });
    } else if (entry.cleanup === 'safe') {
      plan.push({ entry, abs, action: 'delete' });
    } else {
      // cleanup === 'ask' — delete only with --force or an interactive yes.
      plan.push({ entry, abs, action: force ? 'delete' : 'ask' });
    }
  }

  // Interactive prompt for `ask` items when a TTY / injected prompt exists.
  const interactive = options.readPrompt !== undefined || process.stdin.isTTY === true;
  const readPrompt = options.readPrompt ?? terminalReadPrompt;
  const toDelete: CleanPlanItem[] = [];
  const skippedAsk: CleanPlanItem[] = [];
  for (const item of plan) {
    if (item.action === 'delete') {
      toDelete.push(item);
    } else if (item.action === 'ask') {
      if (dryRun) {
        skippedAsk.push(item);
      } else if (interactive) {
        const answer = (await readPrompt(`  Delete ${item.entry.path} (${item.entry.owner})? [y/N]: `))
          .trim()
          .toLowerCase();
        if (answer === 'y' || answer === 'yes') toDelete.push(item);
        else skippedAsk.push(item);
      } else {
        skippedAsk.push(item); // non-interactive without --force → keep
      }
    }
  }

  const deleted: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  if (!dryRun) {
    for (const item of toDelete) {
      try {
        await rm(item.abs, { force: true });
        deleted.push(item.entry.path);
      } catch (err) {
        failed.push({ path: item.entry.path, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (deleted.length > 0) await pruneManifestEntries(root, deleted, { dryRun: false });
  }

  if (json) {
    io.writeStdout(
      `${JSON.stringify(
        {
          ok: failed.length === 0,
          command: 'clean',
          projectRoot: root,
          dryRun,
          deleted: dryRun ? toDelete.map((i) => i.entry.path) : deleted,
          skippedAsk: skippedAsk.map((i) => i.entry.path),
          preserved: plan
            .filter((p) => p.action === 'skip-preserve' || p.action === 'skip-global')
            .map((p) => p.entry.path),
          failed,
        },
        null,
        2,
      )}\n`,
    );
    return io.exit(failed.length === 0 ? EXIT_OK : EXIT_USER_RECOVERABLE);
  }

  io.writeStdout(
    `${commandTitle('Files', `clean${dryRun ? ' (dry-run)' : ''}`, { width: terminalWidth(), indent: 0 })}\n`,
  );
  io.writeStdout(`  ${pc.gray(`project root: ${root}`)}\n`);
  const shownDeleted = dryRun ? toDelete.map((i) => i.entry.path) : deleted;
  if (shownDeleted.length === 0) {
    io.writeStdout(`  ${pc.gray(dryRun ? 'Nothing would be deleted.' : 'Nothing to delete.')}\n`);
  } else {
    io.writeStdout(`  ${pc.green('•')} ${dryRun ? 'Would delete' : 'Deleted'} ${shownDeleted.length} file(s):\n`);
    for (const p of shownDeleted) io.writeStdout(`    ${pc.gray('-')} ${p}\n`);
  }
  if (skippedAsk.length > 0) {
    io.writeStdout(
      `  ${pc.yellow('◌')} ${skippedAsk.length} agent file(s) kept (cleanup=ask). Use ${pc.cyan('--force')}, or remove surgically with ${pc.cyan('coodra agent remove <agent>')}:\n`,
    );
    for (const i of skippedAsk)
      io.writeStdout(`    ${pc.gray('-')} ${i.entry.path} ${pc.gray(`(${i.entry.owner})`)}\n`);
  }
  if (failed.length > 0) {
    io.writeStderr(`  ${pc.red('✗')} ${failed.length} file(s) could not be removed:\n`);
    for (const f of failed) io.writeStderr(`    ${pc.gray('-')} ${f.path}: ${f.error}\n`);
  }
  io.writeStdout(
    `\n${hintLine('Preserved config/env/data + global agent files are never auto-removed. `coodra uninstall` strips everything.')}\n`,
  );
  return io.exit(failed.length === 0 ? EXIT_OK : EXIT_USER_RECOVERABLE);
}
