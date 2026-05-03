import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import pc from 'picocolors';
import { EXIT_OK, EXIT_USER_ACTION_REQUIRED, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { replaceAutoSections } from '../lib/auto-marker/index.js';
import { resolveContextosDataDb, resolveContextosHome } from '../lib/contextos-home.js';
import { populateAutoSections } from '../lib/init/auto-populate.js';
import { openLocalDb } from '../lib/open-local-db.js';
import { listAvailableTemplates, resolveTemplatePath } from '../lib/template-paths.js';
import { detectTemplate } from '../lib/templates/detect.js';
import { loadTemplate, type TemplateDefinition, TemplateLoadError } from '../lib/templates/load-template.js';
import { renderTemplate } from '../lib/templates/render.js';

/**
 * `contextos pack {new|list|show|regenerate|delete}` — admin surface
 * for `docs/feature-packs/<slug>/` directories. Module 08b S16.
 *
 * Reuses S13's template infrastructure (resolveTemplatePath, loadTemplate,
 * renderTemplate), S14's auto-marker parser/serializer
 * (replaceAutoSections), and S15's auto-populator
 * (populateAutoSections). pack new + pack regenerate compose those
 * primitives to render or refresh a feature pack from a template +
 * project shape; pack list / show / delete operate on the directory
 * tree alone.
 *
 * `pack delete <slug>` removes the on-disk directory but does NOT
 * delete the `feature_packs` row (ADR-007 append-only spirit).
 * Instead it sets `is_active=false` so the MCP `search_packs_nl`
 * surface continues to honor previously-saved context packs in that
 * slug.
 */

export interface PackNewOptions {
  readonly template?: string;
  readonly parent?: string;
  readonly mode?: string;
  readonly cwd?: string;
  readonly force?: boolean;
  readonly json?: boolean;
}

export interface PackListOptions {
  readonly cwd?: string;
  readonly json?: boolean;
}

export interface PackShowOptions {
  readonly cwd?: string;
  readonly json?: boolean;
}

export interface PackRegenerateOptions {
  readonly cwd?: string;
  readonly mode?: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly json?: boolean;
}

export interface PackDeleteOptions {
  readonly cwd?: string;
  readonly force?: boolean;
  readonly json?: boolean;
}

export interface PackIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
  readonly contextosHome?: string;
}

export const DEFAULT_PACK_IO: PackIO = {
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

const REQUIRED_PACK_FILES = ['spec.md', 'implementation.md', 'techstack.md', 'meta.json'] as const;

// ============================================================================
// pack new <slug>
// ============================================================================

export async function runPackNewCommand(slug: string, options: PackNewOptions, ioOverride?: PackIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_PACK_IO;
  const json = options.json === true;
  const cwd = options.cwd ?? process.cwd();
  if (slug.trim().length === 0) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, 'pack new requires <slug>');
  }
  const sanitized = slug.trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(sanitized)) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, `slug "${slug}" must match [a-z0-9][a-z0-9-]*`);
  }
  const dir = join(cwd, 'docs', 'feature-packs', sanitized);
  if (existsSync(dir) && options.force !== true) {
    return surfaceError(
      io,
      json,
      EXIT_USER_RECOVERABLE,
      `pack ${sanitized} already exists at ${dir}. Pass --force to overwrite.`,
    );
  }
  let template: TemplateDefinition | undefined;
  if (options.template !== undefined && options.template.length > 0) {
    template = await resolveTemplate(options.template, cwd, io, json);
    if (template === undefined) return;
  } else if (options.mode === 'auto') {
    template = await autoDetectTemplate(cwd);
  }
  if (template === undefined) {
    // Default to the bundled `generic` template so every pack new gets
    // real content rather than an empty scaffold.
    const resolved = resolveTemplatePath('generic');
    if (resolved === null) {
      return surfaceError(
        io,
        json,
        EXIT_USER_RECOVERABLE,
        'no template selected and bundled `generic` template missing',
      );
    }
    template = await loadTemplate(resolved.dir);
  }
  await mkdir(dir, { recursive: true });

  const rendered = renderTemplate(template, { slug: sanitized });
  let metaBody = rendered['meta.json'];
  let specBody = rendered['spec.md'];
  let implBody = rendered['implementation.md'];
  let techBody = rendered['techstack.md'];

  if (options.mode === 'auto' && template.meta.autoSections.length > 0) {
    const populated = populateAutoSections(cwd, template.meta.autoSections);
    const replacements = Object.fromEntries(Object.entries(populated).map(([k, v]) => [k, { content: `\n${v}\n` }]));
    specBody = replaceAutoSections(specBody, replacements).markdown;
    implBody = replaceAutoSections(implBody, replacements).markdown;
    techBody = replaceAutoSections(techBody, replacements).markdown;
  }

  // Apply --parent at meta.json level (overrides whatever the template wrote).
  if (options.parent !== undefined && options.parent.length > 0) {
    try {
      const parsed = JSON.parse(metaBody) as Record<string, unknown>;
      parsed.parentSlug = options.parent;
      metaBody = `${JSON.stringify(parsed, null, 2)}\n`;
    } catch {
      // template's meta.json wasn't JSON; skip the parent override.
    }
  }

  await writeFile(join(dir, 'meta.json'), metaBody, 'utf8');
  await writeFile(join(dir, 'spec.md'), specBody, 'utf8');
  await writeFile(join(dir, 'implementation.md'), implBody, 'utf8');
  await writeFile(join(dir, 'techstack.md'), techBody, 'utf8');

  // Register / refresh the feature_packs row so MCP search picks it up.
  const homePath = io.contextosHome ?? resolveContextosHome();
  const dbPath = resolveContextosDataDb(homePath);
  if (existsSync(dbPath)) {
    await registerFeaturePackRow(dbPath, sanitized, options.parent ?? null);
  }

  if (json) {
    io.writeStdout(`${JSON.stringify({ ok: true, slug: sanitized, dir, template: template.meta.name }, null, 2)}\n`);
  } else {
    io.writeStdout(`${pc.green('✓')} Created pack ${sanitized} at ${dir} (template: ${template.meta.name}).\n`);
  }
  io.exit(EXIT_OK);
}

// ============================================================================
// pack list
// ============================================================================

export async function runPackListCommand(options: PackListOptions, ioOverride?: PackIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_PACK_IO;
  const json = options.json === true;
  const cwd = options.cwd ?? process.cwd();
  const root = join(cwd, 'docs', 'feature-packs');
  if (!existsSync(root)) {
    if (json) {
      io.writeStdout(`${JSON.stringify({ ok: true, packs: [] }, null, 2)}\n`);
    } else {
      io.writeStdout(`${pc.dim('—')} no docs/feature-packs/ directory at ${cwd}.\n`);
    }
    io.exit(EXIT_OK);
    return;
  }

  const dirs: string[] = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (e.isDirectory()) dirs.push(e.name);
  }
  dirs.sort();

  // Cross-reference with feature_packs DB rows for is_active.
  const homePath = io.contextosHome ?? resolveContextosHome();
  const dbPath = resolveContextosDataDb(homePath);
  const activeMap = existsSync(dbPath) ? await readActivePacksMap(dbPath) : new Map<string, boolean>();

  const out = dirs.map((slug) => {
    const dir = join(root, slug);
    const files = REQUIRED_PACK_FILES.map((f) => ({ name: f, present: existsSync(join(dir, f)) }));
    const meta = readMetaSafe(join(dir, 'meta.json'));
    return {
      slug,
      dir,
      isActive: activeMap.get(slug) ?? null,
      parentSlug: meta?.parentSlug ?? null,
      files,
    };
  });

  if (json) {
    io.writeStdout(`${JSON.stringify({ ok: true, packs: out }, null, 2)}\n`);
  } else if (out.length === 0) {
    io.writeStdout(`${pc.dim('—')} no feature packs in ${root}.\n`);
  } else {
    for (const p of out) {
      const status = p.isActive === false ? pc.dim(' (inactive)') : '';
      const parent = p.parentSlug !== null ? ` ← ${p.parentSlug}` : '';
      io.writeStdout(`${pc.bold(p.slug)}${status}${parent}\n`);
      const missing = p.files.filter((f) => !f.present).map((f) => f.name);
      if (missing.length > 0) {
        io.writeStdout(`  ${pc.yellow('!')} missing: ${missing.join(', ')}\n`);
      }
    }
  }
  io.exit(EXIT_OK);
}

// ============================================================================
// pack show <slug>
// ============================================================================

export async function runPackShowCommand(slug: string, options: PackShowOptions, ioOverride?: PackIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_PACK_IO;
  const json = options.json === true;
  const cwd = options.cwd ?? process.cwd();
  if (slug.trim().length === 0) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, 'pack show requires <slug>');
  }
  const dir = join(cwd, 'docs', 'feature-packs', slug.trim());
  if (!existsSync(dir)) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, `no pack at ${dir}`);
  }
  const meta = readMetaSafe(join(dir, 'meta.json'));
  const fileSummaries = REQUIRED_PACK_FILES.map((name) => {
    const path = join(dir, name);
    if (!existsSync(path)) return { name, present: false, sizeBytes: 0, excerpt: '' };
    try {
      const stats = statSync(path);
      const raw = readFileSync(path, 'utf8');
      return { name, present: true, sizeBytes: stats.size, excerpt: raw.slice(0, 2048) };
    } catch {
      return { name, present: false, sizeBytes: 0, excerpt: '' };
    }
  });
  if (json) {
    io.writeStdout(`${JSON.stringify({ ok: true, slug, dir, meta, files: fileSummaries }, null, 2)}\n`);
  } else {
    io.writeStdout(`${pc.bold(slug)} — ${dir}\n`);
    if (meta !== null) {
      io.writeStdout(`  template: ${meta.template ?? '(unknown)'}\n`);
      io.writeStdout(`  parent: ${meta.parentSlug ?? 'none'}\n`);
      io.writeStdout(`  isActive (meta.json): ${meta.isActive ?? 'true'}\n`);
    }
    for (const f of fileSummaries) {
      const tag = f.present ? `${pc.green('•')} ${f.name} (${f.sizeBytes} B)` : `${pc.red('✗')} ${f.name} (missing)`;
      io.writeStdout(`  ${tag}\n`);
    }
  }
  io.exit(EXIT_OK);
}

// ============================================================================
// pack regenerate <slug>
// ============================================================================

export async function runPackRegenerateCommand(
  slug: string,
  options: PackRegenerateOptions,
  ioOverride?: PackIO,
): Promise<void> {
  const io = ioOverride ?? DEFAULT_PACK_IO;
  const json = options.json === true;
  const cwd = options.cwd ?? process.cwd();
  if (slug.trim().length === 0) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, 'pack regenerate requires <slug>');
  }
  const dir = join(cwd, 'docs', 'feature-packs', slug.trim());
  if (!existsSync(dir)) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, `no pack at ${dir}`);
  }
  const meta = readMetaSafe(join(dir, 'meta.json'));
  const templateName = meta?.template;
  if (templateName === undefined || templateName === null || templateName.length === 0) {
    return surfaceError(
      io,
      json,
      EXIT_USER_RECOVERABLE,
      `meta.json for ${slug} has no "template" field — pack regenerate needs to know which template to refresh against. Run \`contextos pack new <slug> --template <name>\` to migrate.`,
    );
  }
  const resolved = resolveTemplatePath(templateName, { cwd });
  if (resolved === null) {
    return surfaceError(
      io,
      json,
      EXIT_USER_RECOVERABLE,
      `template "${templateName}" referenced by meta.json not found`,
    );
  }
  const template = await loadTemplate(resolved.dir);

  // Refresh ONLY the @auto sections — never overwrite user-edited content
  // outside markers. Read each on-disk file, replace its @auto sections
  // with newly-rendered template content, write back.
  const populated =
    options.mode === 'auto' && template.meta.autoSections.length > 0
      ? populateAutoSections(cwd, template.meta.autoSections)
      : Object.fromEntries(
          template.meta.autoSections.map((s) => [
            s,
            '_(no auto-population requested; pass --mode auto to populate from project shape)_',
          ]),
        );
  const replacements = Object.fromEntries(Object.entries(populated).map(([k, v]) => [k, { content: `\n${v}\n` }]));

  const writes: { path: string; before: string; after: string }[] = [];
  for (const fname of REQUIRED_PACK_FILES) {
    if (fname === 'meta.json') continue; // meta.json doesn't carry @auto markers
    const path = join(dir, fname);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, 'utf8');
    const result = replaceAutoSections(before, replacements);
    writes.push({ path, before, after: result.markdown });
  }

  if (options.dryRun === true) {
    if (json) {
      io.writeStdout(
        `${JSON.stringify(
          {
            ok: true,
            dryRun: true,
            wouldChange: writes.filter((w) => w.before !== w.after).map((w) => w.path),
          },
          null,
          2,
        )}\n`,
      );
    } else {
      const changes = writes.filter((w) => w.before !== w.after);
      io.writeStdout(`${pc.cyan('—')} dry-run: would update ${changes.length} file(s):\n`);
      for (const w of changes) io.writeStdout(`  ${w.path}\n`);
    }
    io.exit(EXIT_OK);
    return;
  }

  let updated = 0;
  for (const w of writes) {
    if (w.before === w.after) continue;
    await writeFile(w.path, w.after, 'utf8');
    updated += 1;
  }
  if (json) {
    io.writeStdout(`${JSON.stringify({ ok: true, slug, template: templateName, filesUpdated: updated }, null, 2)}\n`);
  } else {
    io.writeStdout(
      `${pc.green('✓')} Regenerated ${slug} from template "${templateName}" (${updated} file(s) updated).\n`,
    );
  }
  io.exit(EXIT_OK);
}

// ============================================================================
// pack delete <slug>
// ============================================================================

export async function runPackDeleteCommand(
  slug: string,
  options: PackDeleteOptions,
  ioOverride?: PackIO,
): Promise<void> {
  const io = ioOverride ?? DEFAULT_PACK_IO;
  const json = options.json === true;
  const cwd = options.cwd ?? process.cwd();
  if (slug.trim().length === 0) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, 'pack delete requires <slug>');
  }
  const dir = join(cwd, 'docs', 'feature-packs', slug.trim());
  if (!existsSync(dir)) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, `no pack at ${dir}`);
  }
  if (options.force !== true) {
    return surfaceError(
      io,
      json,
      EXIT_USER_ACTION_REQUIRED,
      `pack delete will remove ${dir} from disk and mark feature_packs.is_active=false (preserves the row per ADR-007). Re-run with --force to confirm.`,
    );
  }
  await rm(dir, { recursive: true, force: true });

  // Soft-flip the feature_packs row.
  const homePath = io.contextosHome ?? resolveContextosHome();
  const dbPath = resolveContextosDataDb(homePath);
  let dbAffected = false;
  if (existsSync(dbPath)) {
    dbAffected = await deactivatePackRow(dbPath, slug.trim());
  }

  if (json) {
    io.writeStdout(`${JSON.stringify({ ok: true, slug, dir, dbRowDeactivated: dbAffected }, null, 2)}\n`);
  } else {
    io.writeStdout(`${pc.green('✓')} Deleted ${dir}.\n`);
    if (dbAffected) {
      io.writeStdout(`  ${pc.dim('feature_packs.is_active flipped to false (row preserved per ADR-007).')}\n`);
    }
  }
  io.exit(EXIT_OK);
}

// ============================================================================
// helpers
// ============================================================================

async function resolveTemplate(
  selector: string,
  cwd: string,
  io: PackIO,
  json: boolean,
): Promise<TemplateDefinition | undefined> {
  const resolved = resolveTemplatePath(selector, { cwd });
  if (resolved === null) {
    surfaceError(io, json, EXIT_USER_RECOVERABLE, `template "${selector}" not found`);
    return undefined;
  }
  try {
    return await loadTemplate(resolved.dir);
  } catch (err) {
    const message = err instanceof TemplateLoadError ? err.message : (err as Error).message;
    surfaceError(io, json, EXIT_USER_RECOVERABLE, `template load failed: ${message}`);
    return undefined;
  }
}

async function autoDetectTemplate(cwd: string): Promise<TemplateDefinition | undefined> {
  const all = listAvailableTemplates();
  const definitions: TemplateDefinition[] = [];
  for (const t of all) {
    try {
      definitions.push(await loadTemplate(t.dir));
    } catch {
      // skip unloadable
    }
  }
  const sorted = [...definitions].sort((a, b) => {
    if (a.meta.name === 'generic') return 1;
    if (b.meta.name === 'generic') return -1;
    return a.meta.name.localeCompare(b.meta.name);
  });
  const detected = detectTemplate(cwd, sorted);
  return detected.chosen ?? undefined;
}

interface PackMeta {
  readonly slug?: string;
  readonly parentSlug?: string | null;
  readonly template?: string;
  readonly templateVersion?: string;
  readonly isActive?: boolean;
}

function readMetaSafe(path: string): PackMeta | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PackMeta;
  } catch {
    return null;
  }
}

interface RawSqliteHandle {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown;
  };
}

async function registerFeaturePackRow(dbPath: string, slug: string, parentSlug: string | null): Promise<void> {
  const handle = await openLocalDb(dbPath);
  try {
    const raw = handle.raw as unknown as RawSqliteHandle;
    const existing = raw.prepare('SELECT id FROM feature_packs WHERE slug = ?').get(slug) as { id: string } | undefined;
    if (existing !== undefined) {
      raw
        .prepare('UPDATE feature_packs SET is_active = 1, parent_slug = ?, updated_at = unixepoch() WHERE id = ?')
        .run(parentSlug, existing.id);
    } else {
      const id = `fp_${Math.random().toString(36).slice(2, 14)}_${Date.now()}`;
      raw
        .prepare('INSERT INTO feature_packs (id, slug, parent_slug, is_active, checksum) VALUES (?, ?, ?, 1, ?)')
        .run(id, slug, parentSlug, '0');
    }
  } finally {
    handle.close();
  }
}

async function readActivePacksMap(dbPath: string): Promise<Map<string, boolean>> {
  const handle = await openLocalDb(dbPath);
  try {
    const raw = handle.raw as unknown as RawSqliteHandle;
    const rows = raw.prepare('SELECT slug, is_active FROM feature_packs').all() as Array<{
      slug: string;
      is_active: number;
    }>;
    const out = new Map<string, boolean>();
    for (const r of rows) out.set(r.slug, Boolean(r.is_active));
    return out;
  } finally {
    handle.close();
  }
}

async function deactivatePackRow(dbPath: string, slug: string): Promise<boolean> {
  const handle = await openLocalDb(dbPath);
  try {
    const raw = handle.raw as unknown as RawSqliteHandle;
    const result = raw
      .prepare('UPDATE feature_packs SET is_active = 0, updated_at = unixepoch() WHERE slug = ?')
      .run(slug) as { changes?: number };
    return (result.changes ?? 0) > 0;
  } finally {
    handle.close();
  }
}

function surfaceError(io: PackIO, json: boolean, exitCode: number, message: string): void {
  if (json) {
    io.writeStdout(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  } else {
    io.writeStderr(`${pc.red('error')}: ${message}\n`);
  }
  io.exit(exitCode);
}

void resolve; // reserved for future absolute-path display
