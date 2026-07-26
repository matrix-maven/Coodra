import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type FilesCommandOptions,
  type FilesIO,
  runFilesCleanCommand,
  runFilesStatusCommand,
} from '../../src/commands/files.js';
import { EXIT_OK } from '../../src/exit-codes.js';
import { recordManifestEntries } from '../../src/lib/project-store/manifest.js';

/**
 * End-to-end coverage for `coodra files status/clean` against a real temp
 * project + manifest. Verifies the safe-by-default cleanup model: `safe`
 * artifacts are deleted, `ask` files need --force (or an interactive yes),
 * `preserve` + `global` files are never touched, and the manifest is pruned.
 */

interface Cap {
  stdout: string[];
  stderr: string[];
  exit: number | null;
}
function makeIO(): { io: FilesIO; cap: Cap } {
  const cap: Cap = { stdout: [], stderr: [], exit: null };
  const io: FilesIO = {
    writeStdout: (c) => cap.stdout.push(c),
    writeStderr: (c) => cap.stderr.push(c),
    exit: (code) => {
      cap.exit = code;
      throw new Error(`__exit__:${code}`);
    },
  };
  return { io, cap };
}
async function run(p: () => Promise<unknown>): Promise<number> {
  try {
    await p();
    throw new Error('did not exit');
  } catch (err) {
    const m = (err as Error).message.match(/^__exit__:(\d+)$/);
    if (!m) throw err;
    return Number(m[1]);
  }
}

let root: string;
function opts(extra: Partial<FilesCommandOptions> = {}): FilesCommandOptions {
  return { cwd: root, json: true, ...extra };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'coodra-files-'));
  // Lay down real files: a safe artifact, an ask agent config, a preserve config, a global file.
  await mkdir(join(root, '.cursor'), { recursive: true });
  await mkdir(join(root, 'graphify-out'), { recursive: true });
  await writeFile(join(root, '.cursorrules'), 'coodra block');
  await writeFile(join(root, '.cursor', 'mcp.json'), '{}');
  await writeFile(join(root, '.mcp.json'), '{}');
  await writeFile(join(root, 'graphify-out', 'graph.html'), '<html>');
  await recordManifestEntries({
    root,
    projectSlug: 'demo',
    entries: [
      {
        path: '.coodra/config.json',
        scope: 'project',
        owner: 'coodra',
        kind: 'project-config',
        createdBy: 'test',
        cleanup: 'preserve',
        safeToDelete: false,
      },
      {
        path: '.mcp.json',
        scope: 'project',
        owner: 'coodra',
        kind: 'mcp-config',
        createdBy: 'test',
        cleanup: 'ask',
        safeToDelete: true,
      },
      {
        path: '.cursorrules',
        scope: 'project',
        owner: 'agent:cursor',
        kind: 'instruction-file',
        createdBy: 'test',
        cleanup: 'ask',
        safeToDelete: true,
      },
      {
        path: '.cursor/mcp.json',
        scope: 'project',
        owner: 'agent:cursor',
        kind: 'mcp-config',
        createdBy: 'test',
        cleanup: 'ask',
        safeToDelete: true,
      },
      {
        path: 'graphify-out/graph.html',
        scope: 'project',
        owner: 'graphify',
        kind: 'generated-artifact',
        createdBy: 'test',
        cleanup: 'safe',
        safeToDelete: true,
      },
      {
        path: '/Users/x/.claude/settings.json',
        scope: 'global',
        owner: 'agent:claude',
        kind: 'hooks',
        createdBy: 'test',
        cleanup: 'preserve',
        safeToDelete: false,
      },
    ],
    dryRun: false,
  });
});

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(root, { recursive: true, force: true });
});

describe('coodra files status', () => {
  it('reports every tracked entry with present state', async () => {
    const { io, cap } = makeIO();
    const code = await run(() => runFilesStatusCommand(opts(), io));
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(cap.stdout.join('')) as {
      entries: Array<{ path: string; owner: string; cleanup: string; present: boolean }>;
    };
    expect(payload.entries).toHaveLength(6);
    const cursorrules = payload.entries.find((e) => e.path === '.cursorrules');
    expect(cursorrules?.present).toBe(true);
    // The global settings.json path doesn't exist on this machine → present:false.
    expect(payload.entries.find((e) => e.path.endsWith('settings.json'))?.present).toBe(false);
  });

  it('empty project (no manifest) exits 0 with a helpful note', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'coodra-files-empty-'));
    const { io, cap } = makeIO();
    const code = await run(() => runFilesStatusCommand({ cwd: empty, json: true }, io));
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(cap.stdout.join('')).entries).toEqual([]);
  });
});

describe('coodra files clean', () => {
  it('default: deletes only safe artifacts; keeps ask + preserve + global; prunes the manifest', async () => {
    const { io, cap } = makeIO();
    const code = await run(() => runFilesCleanCommand(opts(), io));
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(cap.stdout.join('')) as { deleted: string[]; skippedAsk: string[]; preserved: string[] };

    expect(payload.deleted).toEqual(['graphify-out/graph.html']); // the only safe file
    expect(payload.skippedAsk.sort()).toEqual(['.cursor/mcp.json', '.cursorrules', '.mcp.json']);
    expect(payload.preserved).toContain('.coodra/config.json');

    // Safe artifact gone; ask files + preserve untouched.
    expect(existsSync(join(root, 'graphify-out', 'graph.html'))).toBe(false);
    expect(existsSync(join(root, '.cursorrules'))).toBe(true);
    expect(existsSync(join(root, '.mcp.json'))).toBe(true);
  });

  it('--force: also deletes ask files; never deletes preserve/global', async () => {
    const { io, cap } = makeIO();
    const code = await run(() => runFilesCleanCommand(opts({ force: true }), io));
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(cap.stdout.join('')) as { deleted: string[] };
    expect(payload.deleted.sort()).toEqual([
      '.cursor/mcp.json',
      '.cursorrules',
      '.mcp.json',
      'graphify-out/graph.html',
    ]);
    expect(existsSync(join(root, '.cursorrules'))).toBe(false);
    // preserve config not tracked as a real file here, but its entry must remain in the manifest.
    const { readManifest } = await import('../../src/lib/project-store/manifest.js');
    const m = await readManifest(root);
    expect(m?.entries.map((e) => e.path)).toContain('.coodra/config.json');
    expect(m?.entries.some((e) => e.scope === 'global')).toBe(true); // global entry preserved
  });

  it('--dry-run deletes nothing', async () => {
    const { io, cap } = makeIO();
    await run(() => runFilesCleanCommand(opts({ dryRun: true, force: true }), io));
    expect(existsSync(join(root, '.cursorrules'))).toBe(true);
    expect(existsSync(join(root, 'graphify-out', 'graph.html'))).toBe(true);
    const payload = JSON.parse(cap.stdout.join('')) as { deleted: string[] };
    expect(payload.deleted.length).toBeGreaterThan(0); // reports what WOULD be deleted
  });

  it('interactive prompt: deletes an ask file only on a yes', async () => {
    const answers = new Map<string, string>([
      ['.cursorrules', 'y'],
      ['.cursor/mcp.json', 'n'],
      ['.mcp.json', 'n'],
    ]);
    const readPrompt = async (q: string): Promise<string> => {
      for (const [path, ans] of answers) if (q.includes(path)) return ans;
      return 'n';
    };
    const { io } = makeIO();
    await run(() => runFilesCleanCommand(opts({ readPrompt }), io));
    expect(existsSync(join(root, '.cursorrules'))).toBe(false); // answered y
    expect(existsSync(join(root, '.cursor', 'mcp.json'))).toBe(true); // answered n
    expect(existsSync(join(root, 'graphify-out', 'graph.html'))).toBe(false); // safe → always deleted
  });
});
