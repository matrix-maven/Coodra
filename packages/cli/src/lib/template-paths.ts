import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveCoodraHome } from './coodra-home.js';

/**
 * `packages/cli/src/lib/template-paths` — resolves a template name to
 * its on-disk directory.
 *
 * Resolution order (Module 08b S13):
 *   1. Absolute / relative file-system path (when the user passes
 *      `--template /path/to/dir` or `--template ./local-dir`).
 *   2. User templates: `~/.coodra/templates/<name>/`. Installed via
 *      `coodra template install <path>` (S17). Override bundled
 *      templates of the same name when present.
 *   3. Bundled templates: `<cli-dist>/templates/<name>/` — shipped
 *      inside the npm tarball for the seven starters
 *      (generic, node-monorepo, nextjs-saas, python-ml, python-fastapi,
 *      rust-cli, go-service).
 *
 * `resolveTemplatePath` returns null when no match is found at any
 * tier; the caller surfaces `"template not found"` with the resolution
 * chain printed for debuggability.
 */

export interface ResolvedTemplate {
  readonly name: string;
  readonly source: 'bundled' | 'user' | 'path';
  readonly dir: string;
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Bundled templates land at `<cli-dist>/templates/`. In dev (running
 * via tsx from `src/`) we look at `<cli-root>/templates/`. The
 * runtime-paths.ts pattern uses the same dual-detection.
 */
function resolveBundledTemplatesDir(): string {
  // `here` is dist/lib/ (after build) OR src/lib/ (in dev). Either way,
  // the templates dir lives one level up under a `templates/` folder.
  const distCandidate = resolve(here, '..', 'templates');
  if (existsSync(distCandidate)) return distCandidate;
  const srcCandidate = resolve(here, '..', '..', 'templates');
  return srcCandidate;
}

function resolveUserTemplatesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveCoodraHome({ env }), 'templates');
}

export interface ResolveTemplatePathOptions {
  /** Override the coodra home for tests. */
  readonly coodraHome?: string;
  /** Override the bundled-templates dir for tests. */
  readonly bundledDir?: string;
  /** Working directory for relative paths. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

export function resolveTemplatePath(
  nameOrPath: string,
  options: ResolveTemplatePathOptions = {},
): ResolvedTemplate | null {
  const cwd = options.cwd ?? process.cwd();
  const trimmed = nameOrPath.trim();
  if (trimmed.length === 0) return null;

  // (1) Path: absolute, relative-with-prefix, or any string containing a
  // path separator. Avoids ambiguity with bare names like 'generic'.
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('~/') ||
    trimmed.includes('/')
  ) {
    const expanded = trimmed.startsWith('~/')
      ? join(process.env.HOME ?? '', trimmed.slice(2))
      : trimmed.startsWith('/')
        ? trimmed
        : resolve(cwd, trimmed);
    if (isTemplateDir(expanded)) {
      return { name: nameOrPath, source: 'path', dir: expanded };
    }
    return null;
  }

  // (2) User templates.
  const userDir =
    options.coodraHome !== undefined ? join(options.coodraHome, 'templates') : resolveUserTemplatesDir();
  const userCandidate = join(userDir, trimmed);
  if (isTemplateDir(userCandidate)) {
    return { name: trimmed, source: 'user', dir: userCandidate };
  }

  // (3) Bundled templates.
  const bundledDir = options.bundledDir ?? resolveBundledTemplatesDir();
  const bundledCandidate = join(bundledDir, trimmed);
  if (isTemplateDir(bundledCandidate)) {
    return { name: trimmed, source: 'bundled', dir: bundledCandidate };
  }

  return null;
}

/**
 * Lists every available template name across user + bundled tiers.
 * User-installed templates with the same name as a bundled template
 * shadow the bundled one (consistent with `resolveTemplatePath`).
 */
export function listAvailableTemplates(
  options: ResolveTemplatePathOptions = {},
): ReadonlyArray<{ readonly name: string; readonly source: 'bundled' | 'user'; readonly dir: string }> {
  const seen = new Set<string>();
  const out: { name: string; source: 'bundled' | 'user'; dir: string }[] = [];

  const userDir =
    options.coodraHome !== undefined ? join(options.coodraHome, 'templates') : resolveUserTemplatesDir();
  if (existsSync(userDir)) {
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    for (const name of readdirSync(userDir)) {
      const dir = join(userDir, name);
      if (isTemplateDir(dir)) {
        seen.add(name);
        out.push({ name, source: 'user', dir });
      }
    }
  }

  const bundledDir = options.bundledDir ?? resolveBundledTemplatesDir();
  if (existsSync(bundledDir)) {
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    for (const name of readdirSync(bundledDir)) {
      if (seen.has(name)) continue;
      const dir = join(bundledDir, name);
      if (isTemplateDir(dir)) {
        out.push({ name, source: 'bundled', dir });
      }
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function isTemplateDir(dir: string): boolean {
  try {
    const s = statSync(dir);
    if (!s.isDirectory()) return false;
    return existsSync(join(dir, 'template.json'));
  } catch {
    return false;
  }
}
