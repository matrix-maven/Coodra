import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join, win32 } from 'node:path';

export interface FindExecutableOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly pathExt?: string;
}

/**
 * Resolve a command from PATH without shelling out to Unix-only `which`.
 *
 * Node's `execFile('which', ...)` fails on native Windows unless Git Bash or
 * WSL happens to be in play. This helper mirrors the minimum behavior Coodra
 * needs: search PATH, honor PATHEXT on Windows, and return the absolute path
 * that can then be passed to `execFile` directly.
 */
export async function findExecutableOnPath(
  command: string,
  options: FindExecutableOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathValue = env.PATH ?? env.Path ?? env.path ?? '';
  const pathDelimiter = platform === 'win32' ? ';' : delimiter;
  const pathDirs = pathValue.split(pathDelimiter).filter((part) => part.length > 0);
  const candidates = isAbsoluteForPlatform(command, platform)
    ? [command]
    : pathDirs.map((dir) => joinForPlatform(dir, command, platform));
  const names = platform === 'win32' ? expandWindowsCandidates(candidates, options.pathExt ?? env.PATHEXT) : candidates;

  for (const candidate of names) {
    if (await isRunnable(candidate, platform)) return candidate;
  }
  return null;
}

function isAbsoluteForPlatform(path: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? win32.isAbsolute(path) || isAbsolute(path) : isAbsolute(path);
}

function joinForPlatform(dir: string, command: string, platform: NodeJS.Platform): string {
  if (platform === 'win32' && /^[A-Za-z]:[\\/]/.test(dir)) return win32.join(dir, command);
  if (platform === 'win32' && dir.startsWith('\\\\')) return win32.join(dir, command);
  return join(dir, command);
}

function expandWindowsCandidates(candidates: readonly string[], pathExt: string | undefined): string[] {
  const extensions = (pathExt ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0)
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));

  const out: string[] = [];
  for (const candidate of candidates) {
    out.push(candidate);
    if (win32.extname(candidate).length === 0) {
      for (const ext of extensions) out.push(`${candidate}${ext.toLowerCase()}`);
      for (const ext of extensions) out.push(`${candidate}${ext.toUpperCase()}`);
    }
  }
  return out;
}

async function isRunnable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(path, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
