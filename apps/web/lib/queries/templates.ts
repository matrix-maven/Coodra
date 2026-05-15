import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * `apps/web/lib/queries/templates.ts` — server-only scanner for the
 * feature-pack templates library. Walks the same two tiers as the CLI's
 * `listAvailableTemplates` (M08b S17) — user-installed under
 * `~/.coodra/templates/` then bundled under
 * `<cli-pkg>/templates/`. User templates shadow bundled ones with the
 * same name.
 *
 * Bundled-templates resolution: read from
 * `node_modules/@coodra/cli/templates/` (or, in workspace
 * dev, `<repo>/packages/cli/templates/` via the workspace symlink).
 * Falls back to `<cli-dist>/templates/` if the package layout differs.
 */

const TEMPLATE_JSON_SCHEMA = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    version: z.string().optional(),
    languages: z.array(z.string()).optional(),
    autoSections: z.array(z.union([z.string(), z.object({ name: z.string() }).passthrough()])).optional(),
  })
  .passthrough();

export interface TemplateRow {
  readonly name: string;
  readonly source: 'bundled' | 'user';
  readonly dir: string;
  readonly description: string | null;
  readonly version: string | null;
  readonly languages: ReadonlyArray<string>;
  readonly autoSections: ReadonlyArray<string>;
}

function isTemplateDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
    return existsSync(join(dir, 'template.json'));
  } catch {
    return false;
  }
}

function readTemplateMeta(dir: string): {
  description: string | null;
  version: string | null;
  languages: ReadonlyArray<string>;
  autoSections: ReadonlyArray<string>;
} {
  const metaPath = join(dir, 'template.json');
  try {
    const parsed = TEMPLATE_JSON_SCHEMA.parse(JSON.parse(readFileSync(metaPath, 'utf8')));
    return {
      description: parsed.description ?? null,
      version: parsed.version ?? null,
      languages: parsed.languages ?? [],
      autoSections: (parsed.autoSections ?? []).map((s) => (typeof s === 'string' ? s : s.name)),
    };
  } catch {
    return { description: null, version: null, languages: [], autoSections: [] };
  }
}

function userTemplatesDir(): string {
  const home = process.env.COODRA_HOME ?? resolve(homedir(), '.coodra');
  return join(home, 'templates');
}

function bundledTemplatesDir(): string | null {
  // Try the published-package path first.
  const here = dirname(fileURLToPath(import.meta.url));
  // Search up to 6 levels for `node_modules/@coodra/cli/templates`
  // OR `packages/cli/templates` (workspace dev).
  const candidates: string[] = [];
  let cursor = here;
  for (let i = 0; i < 6; i++) {
    candidates.push(join(cursor, 'node_modules', '@coodra', 'coodra-cli', 'templates'));
    candidates.push(join(cursor, 'packages', 'cli', 'templates'));
    candidates.push(join(cursor, 'packages', 'cli', 'dist', 'templates'));
    cursor = dirname(cursor);
  }
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isDirectory()) return c;
  }
  return null;
}

export function listTemplates(): TemplateRow[] {
  const seen = new Set<string>();
  const out: TemplateRow[] = [];

  const userDir = userTemplatesDir();
  if (existsSync(userDir)) {
    for (const name of readdirSync(userDir)) {
      const dir = join(userDir, name);
      if (isTemplateDir(dir)) {
        seen.add(name);
        out.push({ name, source: 'user', dir, ...readTemplateMeta(dir) });
      }
    }
  }

  const bundledDir = bundledTemplatesDir();
  if (bundledDir !== null) {
    for (const name of readdirSync(bundledDir)) {
      if (seen.has(name)) continue;
      const dir = join(bundledDir, name);
      if (isTemplateDir(dir)) {
        out.push({ name, source: 'bundled', dir, ...readTemplateMeta(dir) });
      }
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}
