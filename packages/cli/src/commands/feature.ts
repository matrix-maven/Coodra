import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  FEATURE_SLUG_RE,
  featuresRoot,
  generateFeaturesIndex,
  parseFeatureMd,
  readFeatureRow,
  renderFeatureMd,
  walkFeatures,
} from '@coodra/shared/features';
import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { deleteFeatureFromDb, upsertFeatureInDb } from '../lib/feature-db.js';
import { readTeamConfig } from '../lib/team-config.js';
import { commandTitle, pc, terminalWidth } from '../ui/index.js';

/**
 * `coodra feature {add|list|show|edit|index|remove}` — admin surface
 * for the skill-style features layer.
 *
 * Each subcommand does exactly one thing. They all share the same IO
 * shape (`FeatureIO`) and `--cwd` resolution so they're trivially
 * testable in isolation. The heavy lifting (parse, walk, generate)
 * lives in `@coodra/shared/features`; this module is just
 * the CLI front-end.
 *
 * Every mutating command (add, edit-via-save, remove) ALWAYS regenerates
 * the index after a successful mutation. The user never has to remember
 * to run `feature index` themselves; they only do that when files
 * landed via some other path (git pull, a sibling tool, etc.).
 *
 * `--json` is supported on the read paths (list, show) for scripting;
 * mutating paths log to stdout in human form because that's where users
 * live.
 */

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

export interface FeatureIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_FEATURE_IO: FeatureIO = {
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

// ---------------------------------------------------------------------------
// Common option shapes
// ---------------------------------------------------------------------------

export interface FeatureBaseOptions {
  /** Override the project root. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Emit machine-readable JSON instead of human-readable lines. */
  readonly json?: boolean;
}

export interface FeatureAddOptions extends FeatureBaseOptions {
  /**
   * Trigger description for the new feature. Optional on the CLI;
   * when omitted, the scaffolded `feature.md` ships with a placeholder
   * that the user is expected to edit. The placeholder is intentionally
   * obvious so the agent's quality-warning lint catches an unedited
   * stub on the first index pass.
   */
  readonly description?: string;
  /** Optional initial maturity tag. Defaults to `draft`. */
  readonly maturity?: string;
  /** Replace an existing feature.md if one already exists. */
  readonly force?: boolean;
}

export interface FeatureRemoveOptions extends FeatureBaseOptions {
  readonly force?: boolean;
}

// ---------------------------------------------------------------------------
// Slug derivation + cwd resolution
// ---------------------------------------------------------------------------

interface ResolvedProject {
  readonly cwd: string;
  /** Slug from `<cwd>/.coodra.json` if present, else basename. */
  readonly projectSlug: string;
}

function resolveProject(rawCwd: string | undefined, io: FeatureIO): ResolvedProject {
  const cwd = resolve(rawCwd ?? process.cwd());
  const sidecarPath = join(cwd, '.coodra.json');
  let projectSlug: string | undefined;
  if (existsSync(sidecarPath)) {
    try {
      const json = JSON.parse(readFileSync(sidecarPath, 'utf8')) as { projectSlug?: unknown };
      if (typeof json.projectSlug === 'string') projectSlug = json.projectSlug;
    } catch {
      // ignore — fall through to basename derivation
    }
  }
  if (projectSlug === undefined || projectSlug.length === 0) {
    projectSlug = basenameSlug(cwd);
  }
  if (!FEATURE_SLUG_RE.test(projectSlug)) {
    io.writeStderr(
      `${pc.red('coodra feature')}: derived project slug "${projectSlug}" doesn't match [a-z0-9_-]+. Add "projectSlug" to ${sidecarPath} or run from a project root.\n`,
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }
  return { cwd, projectSlug };
}

function basenameSlug(cwd: string): string {
  const base =
    cwd
      .split('/')
      .filter((seg) => seg.length > 0)
      .pop() ?? '';
  return base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sanitizeFeatureSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// feature add
// ---------------------------------------------------------------------------

/**
 * Sentinel placeholder. `validateFrontmatterQuality` (in
 * `@coodra/shared/features/schema`) explicitly flags any
 * description matching `TODO: describe …` so the index records
 * `hasWarnings=true` until the user edits it. Pre-fix the placeholder
 * was a well-formed sentence that accidentally passed every quality
 * heuristic, hiding the fact that the user hadn't filled it in.
 */
const PLACEHOLDER_DESCRIPTION = 'TODO: describe when this feature applies.';

export async function runFeatureAddCommand(
  rawSlug: string,
  options: FeatureAddOptions = {},
  io: FeatureIO = DEFAULT_FEATURE_IO,
): Promise<never> {
  const { cwd, projectSlug } = resolveProject(options.cwd, io);
  const slug = sanitizeFeatureSlug(rawSlug);
  if (!FEATURE_SLUG_RE.test(slug)) {
    io.writeStderr(
      `${pc.red('coodra feature add')}: slug "${rawSlug}" couldn't be sanitized into [a-z0-9_-]+ form.\n`,
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }
  const root = featuresRoot(cwd);
  const dir = join(root, slug);
  const featureMdPath = join(dir, 'feature.md');
  const force = options.force === true;

  if (existsSync(featureMdPath) && !force) {
    io.writeStderr(
      `${pc.red('coodra feature add')}: feature "${slug}" already exists at ${featureMdPath}. Pass --force to overwrite, or use \`coodra feature edit ${slug}\` to modify it in your editor.\n`,
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  mkdirSync(dir, { recursive: true });
  const description =
    options.description?.trim() && options.description.trim().length > 0
      ? options.description.trim()
      : PLACEHOLDER_DESCRIPTION;
  const maturity = (options.maturity as 'draft' | 'beta' | 'stable' | 'deprecated' | undefined) ?? 'draft';
  const body = scaffoldBody(slug);
  const rendered = renderFeatureMd({
    frontmatter: {
      name: slug,
      description,
      maturity,
    },
    body,
  });
  writeFileSync(featureMdPath, rendered, 'utf8');

  // Auto-regenerate so INDEX is correct without a separate step.
  const indexResult = generateFeaturesIndex({ projectCwd: cwd, projectSlug });

  // Phase F.1.c — mirror the feature into ~/.coodra/data.db so
  // team mode can sync it via the sync-daemon. Solo mode keeps the
  // row purely for the future web /features list to read off the
  // same shape. The filesystem write above is the source of truth
  // for authoring; the DB row is the distribution shape.
  //
  // The frontmatter we store is the literal YAML the user will see
  // on disk (without the `---` fences), so the puller's filesystem
  // writeback can render it back to identical bytes — keeping the
  // checksum stable across the round-trip and preventing puller-vs-
  // CLI anti-loops.
  const storedFrontmatter = renderFrontmatterYamlOnly({ name: slug, description, maturity });
  const dbResult = await upsertFeatureInDb({
    projectSlug,
    slug,
    frontmatter: storedFrontmatter,
    body,
    status: 'published',
  });

  if (options.json === true) {
    io.writeStdout(
      `${JSON.stringify(
        {
          status: 'ok',
          slug,
          dir,
          indexEntries: indexResult.index.features.length,
          dbSync: dbResult.ok ? { created: dbResult.created, enqueued: dbResult.enqueued } : { error: dbResult.error },
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.writeStdout(`${pc.green('✓')} Created feature "${slug}" at ${featureMdPath}\n`);
    if (description === PLACEHOLDER_DESCRIPTION) {
      io.writeStdout(
        `${pc.yellow('⚠')} description is the placeholder — edit ${featureMdPath} and run \`coodra feature index\` (or just save via the web UI) to refresh.\n`,
      );
    }
    io.writeStdout(
      `${pc.green('✓')} Index regenerated (${indexResult.index.features.length} feature${indexResult.index.features.length === 1 ? '' : 's'} total)\n`,
    );
    if (dbResult.ok) {
      if (dbResult.enqueued) {
        io.writeStdout(`${pc.green('✓')} Queued for cloud sync (team mode) — teammates will pull within ~10s.\n`);
      } else if (readTeamConfig().mode === 'team') {
        io.writeStdout(`${pc.gray('·')} Local DB mirror updated (team-mode sync skipped — local-only project org).\n`);
      } else {
        io.writeStdout(`${pc.gray('·')} Local DB mirror updated (solo mode — no cloud sync).\n`);
      }
    } else {
      io.writeStdout(`${pc.yellow('⚠')} Local DB mirror skipped: ${dbResult.howToFix}\n`);
    }
  }
  return io.exit(EXIT_OK);
}

/**
 * Phase F.1.c — render frontmatter as raw YAML body (no `---` fences).
 * Mirrors `renderFeatureMd` shape but emits only the YAML block so we
 * can store the literal authored YAML in the `features.frontmatter`
 * column. The puller's filesystem writeback wraps this back in fences
 * so the round-trip is lossless.
 */
function renderFrontmatterYamlOnly(fm: {
  name: string;
  description: string;
  whenNotToUse?: string;
  maturity?: 'draft' | 'beta' | 'stable' | 'deprecated';
  owners?: ReadonlyArray<string>;
  tags?: ReadonlyArray<string>;
}): string {
  // The canonical renderFeatureMd wraps in `---` fences + appends body.
  // We strip both to get the pure YAML block.
  const full = renderFeatureMd({ frontmatter: fm, body: '' });
  // Strip opening `---\n`, trailing `---\n\n`, and any trailing newlines.
  const stripped = full.replace(/^---\r?\n/, '').replace(/\r?\n---\r?\n*$/, '');
  return stripped.trimEnd();
}

function scaffoldBody(slug: string): string {
  return [
    `# ${slug}`,
    '',
    '> The body of this feature is what the agent loads on demand via',
    '> `coodra__get_feature({slug:"' + slug + '"})`. Keep the most',
    '> load-bearing context here; deeper detail goes in supporting files',
    '> alongside this `feature.md`.',
    '',
    '## What this feature is',
    '',
    'TODO',
    '',
    '## Concrete operations / entities',
    '',
    '- TODO: function names',
    '- TODO: file paths',
    '- TODO: external services',
    '',
    '## Things to watch out for',
    '',
    'TODO',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// feature list
// ---------------------------------------------------------------------------

export async function runFeatureListCommand(
  options: FeatureBaseOptions = {},
  io: FeatureIO = DEFAULT_FEATURE_IO,
): Promise<never> {
  const { cwd, projectSlug } = resolveProject(options.cwd, io);
  const rows = walkFeatures(cwd);

  if (options.json === true) {
    const payload = {
      projectSlug,
      featuresRoot: featuresRoot(cwd),
      features: rows.map((r) => ({
        slug: r.slug,
        name: r.frontmatter.name,
        description: r.frontmatter.description,
        whenNotToUse: r.frontmatter.whenNotToUse ?? null,
        maturity: r.frontmatter.maturity ?? 'draft',
        owners: r.frontmatter.owners ?? [],
        tags: r.frontmatter.tags ?? [],
        fileCount: r.files.length + 1,
        totalBytes: r.totalBytes,
        lastUpdatedAt: r.lastUpdatedAt,
        warnings: r.warnings,
      })),
    };
    io.writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
    return io.exit(EXIT_OK);
  }

  io.writeStdout(`${commandTitle('Features', projectSlug, { width: terminalWidth() })}\n`);
  if (rows.length === 0) {
    io.writeStdout(`No features yet. Run \`coodra feature add <name>\` to create one.\n`);
    io.writeStdout(`(Looked in ${featuresRoot(cwd)})\n`);
    return io.exit(EXIT_OK);
  }
  io.writeStdout(`${rows.length} feature${rows.length === 1 ? '' : 's'} for ${pc.bold(projectSlug)}\n`);
  io.writeStdout(`(Indexed root: ${featuresRoot(cwd)})\n\n`);
  for (const row of rows) {
    const maturity = row.frontmatter.maturity ?? 'draft';
    const maturityTag = maturity === 'stable' ? '' : pc.dim(` [${maturity}]`);
    io.writeStdout(`${pc.bold(row.slug)}${maturityTag}\n`);
    io.writeStdout(`  ${truncate(row.frontmatter.description, 200)}\n`);
    io.writeStdout(
      `  ${pc.dim(`${row.files.length + 1} file${row.files.length === 0 ? '' : 's'} · ${formatBytes(row.totalBytes)} · last updated ${row.lastUpdatedAt}`)}\n`,
    );
    if (row.warnings.length > 0) {
      io.writeStdout(`  ${pc.yellow(`⚠ ${row.warnings.length} warning${row.warnings.length === 1 ? '' : 's'}`)}\n`);
    }
    io.writeStdout('\n');
  }
  return io.exit(EXIT_OK);
}

// ---------------------------------------------------------------------------
// feature show
// ---------------------------------------------------------------------------

export async function runFeatureShowCommand(
  rawSlug: string,
  options: FeatureBaseOptions = {},
  io: FeatureIO = DEFAULT_FEATURE_IO,
): Promise<never> {
  const { cwd } = resolveProject(options.cwd, io);
  const slug = sanitizeFeatureSlug(rawSlug);
  const dir = join(featuresRoot(cwd), slug);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    io.writeStderr(`${pc.red('coodra feature show')}: no feature at ${dir}\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }
  const row = readFeatureRow(slug, dir);
  if (row === null) {
    io.writeStderr(`${pc.red('coodra feature show')}: ${dir} has no feature.md\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }
  if (options.json === true) {
    io.writeStdout(`${JSON.stringify(row, null, 2)}\n`);
    return io.exit(EXIT_OK);
  }
  io.writeStdout(`${pc.bold(row.slug)}\n`);
  io.writeStdout(`  description: ${row.frontmatter.description}\n`);
  if (row.frontmatter.whenNotToUse !== undefined) {
    io.writeStdout(`  not for: ${row.frontmatter.whenNotToUse}\n`);
  }
  io.writeStdout(`  maturity: ${row.frontmatter.maturity ?? 'draft'}\n`);
  if ((row.frontmatter.tags ?? []).length > 0) {
    io.writeStdout(`  tags: ${(row.frontmatter.tags ?? []).join(', ')}\n`);
  }
  if ((row.frontmatter.owners ?? []).length > 0) {
    io.writeStdout(`  owners: ${(row.frontmatter.owners ?? []).join(', ')}\n`);
  }
  io.writeStdout(`  dir: ${row.dir}\n`);
  io.writeStdout(`  files (${row.files.length + 1}):\n`);
  io.writeStdout(`    feature.md\n`);
  for (const f of row.files) {
    io.writeStdout(`    ${f.path}  ${pc.dim(`(${formatBytes(f.bytes)})`)}\n`);
  }
  if (row.warnings.length > 0) {
    io.writeStdout(`\n${pc.yellow(`⚠ ${row.warnings.length} warning${row.warnings.length === 1 ? '' : 's'}:`)}\n`);
    for (const w of row.warnings) {
      io.writeStdout(`  - ${w}\n`);
    }
  }
  return io.exit(EXIT_OK);
}

// ---------------------------------------------------------------------------
// feature edit (open in $EDITOR)
// ---------------------------------------------------------------------------

export async function runFeatureEditCommand(
  rawSlug: string,
  options: FeatureBaseOptions = {},
  io: FeatureIO = DEFAULT_FEATURE_IO,
): Promise<never> {
  const { cwd, projectSlug } = resolveProject(options.cwd, io);
  const slug = sanitizeFeatureSlug(rawSlug);
  const featureMdPath = join(featuresRoot(cwd), slug, 'feature.md');
  if (!existsSync(featureMdPath)) {
    io.writeStderr(
      `${pc.red('coodra feature edit')}: no feature.md at ${featureMdPath}. Create it with \`coodra feature add ${slug}\` first.\n`,
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }
  const editor = process.env.VISUAL ?? process.env.EDITOR ?? 'vi';
  io.writeStdout(`Opening ${featureMdPath} in ${editor}...\n`);
  await new Promise<void>((resolveSpawn) => {
    const child = spawn(editor, [featureMdPath], { stdio: 'inherit' });
    child.on('exit', () => resolveSpawn());
    child.on('error', () => resolveSpawn());
  });
  // Re-validate after the editor exits.
  const raw = readFileSync(featureMdPath, 'utf8');
  const parsed = parseFeatureMd(raw);
  if (parsed.errors.length > 0) {
    io.writeStderr(`${pc.yellow('⚠')} feature.md has parse errors after edit:\n`);
    for (const e of parsed.errors) io.writeStderr(`  - ${e}\n`);
    io.writeStderr(`Index NOT regenerated. Fix the errors and run \`coodra feature index\`.\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }
  const indexResult = generateFeaturesIndex({ projectCwd: cwd, projectSlug });

  // Phase F.1.c — mirror the saved feature into local DB + enqueue
  // sync. Same shape as `feature add` (see comment there). Uses the
  // raw on-disk frontmatter YAML so the puller's filesystem writeback
  // produces identical bytes and the checksum stays stable.
  if (parsed.frontmatter !== null) {
    const storedFrontmatter = renderFrontmatterYamlOnly({
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      ...(parsed.frontmatter.whenNotToUse !== undefined ? { whenNotToUse: parsed.frontmatter.whenNotToUse } : {}),
      ...(parsed.frontmatter.maturity !== undefined ? { maturity: parsed.frontmatter.maturity } : {}),
      ...(parsed.frontmatter.owners !== undefined ? { owners: parsed.frontmatter.owners } : {}),
      ...(parsed.frontmatter.tags !== undefined ? { tags: parsed.frontmatter.tags } : {}),
    });
    const dbResult = await upsertFeatureInDb({
      projectSlug,
      slug,
      frontmatter: storedFrontmatter,
      body: parsed.body,
      status: 'published',
    });
    if (dbResult.ok) {
      if (dbResult.enqueued) {
        io.writeStdout(`${pc.green('✓')} Queued for cloud sync (team mode) — teammates will pull within ~10s.\n`);
      } else if (dbResult.created) {
        io.writeStdout(`${pc.gray('·')} Local DB row created (no cloud sync — solo mode or local-only project).\n`);
      }
    } else {
      io.writeStdout(`${pc.yellow('⚠')} Local DB sync skipped: ${dbResult.howToFix}\n`);
    }
  }

  io.writeStdout(
    `${pc.green('✓')} Index regenerated (${indexResult.index.features.length} feature${indexResult.index.features.length === 1 ? '' : 's'} total)\n`,
  );
  return io.exit(EXIT_OK);
}

// ---------------------------------------------------------------------------
// feature index (re-generate INDEX.md / INDEX.json)
// ---------------------------------------------------------------------------

export async function runFeatureIndexCommand(
  options: FeatureBaseOptions = {},
  io: FeatureIO = DEFAULT_FEATURE_IO,
): Promise<never> {
  const { cwd, projectSlug } = resolveProject(options.cwd, io);
  const result = generateFeaturesIndex({ projectCwd: cwd, projectSlug });
  if (options.json === true) {
    io.writeStdout(
      `${JSON.stringify(
        {
          status: 'ok',
          changed: result.changed,
          features: result.index.features.length,
          slugsWithWarnings: result.slugsWithWarnings,
        },
        null,
        2,
      )}\n`,
    );
    return io.exit(EXIT_OK);
  }
  if (result.changed) {
    io.writeStdout(
      `${pc.green('✓')} Index regenerated — ${result.index.features.length} feature${result.index.features.length === 1 ? '' : 's'} indexed at ${result.indexJsonPath}\n`,
    );
  } else {
    io.writeStdout(
      `${pc.gray('=')} Index unchanged — already up to date (${result.index.features.length} feature${result.index.features.length === 1 ? '' : 's'})\n`,
    );
  }
  if (result.slugsWithWarnings.length > 0) {
    io.writeStdout(
      `${pc.yellow('⚠')} ${result.slugsWithWarnings.length} feature${result.slugsWithWarnings.length === 1 ? ' has' : 's have'} warnings: ${result.slugsWithWarnings.join(', ')}\n`,
    );
  }
  return io.exit(EXIT_OK);
}

// ---------------------------------------------------------------------------
// feature remove
// ---------------------------------------------------------------------------

export async function runFeatureRemoveCommand(
  rawSlug: string,
  options: FeatureRemoveOptions = {},
  io: FeatureIO = DEFAULT_FEATURE_IO,
): Promise<never> {
  const { cwd, projectSlug } = resolveProject(options.cwd, io);
  const slug = sanitizeFeatureSlug(rawSlug);
  const dir = join(featuresRoot(cwd), slug);
  if (!existsSync(dir)) {
    io.writeStderr(`${pc.red('coodra feature remove')}: no feature at ${dir}\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }
  if (options.force !== true) {
    io.writeStderr(
      `${pc.red('coodra feature remove')}: refusing to delete ${dir} without --force. This is irreversible.\n`,
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }
  rmSync(dir, { recursive: true, force: true });
  const indexResult = generateFeaturesIndex({ projectCwd: cwd, projectSlug });

  // Phase F.1.c — delete the local DB row too. The cloud row stays
  // until F.3.c (audit table + cloud DELETE flow) ships; the web's
  // upcoming /features list will surface "orphaned cloud row" markers
  // for any cloud feature whose local SQLite mirror is absent.
  const dbResult = deleteFeatureFromDb({ projectSlug, slug });

  io.writeStdout(
    `${pc.green('✓')} Removed feature "${slug}" (${dir}). Index regenerated (${indexResult.index.features.length} feature${indexResult.index.features.length === 1 ? '' : 's'} total).\n`,
  );
  if (dbResult.ok) {
    if (dbResult.deleted) {
      io.writeStdout(`${pc.gray('·')} Local DB mirror row deleted.\n`);
    }
  } else {
    io.writeStdout(`${pc.yellow('⚠')} Local DB delete skipped: ${dbResult.howToFix}\n`);
  }
  return io.exit(EXIT_OK);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  const oneline = s.replace(/\s+/g, ' ').trim();
  if (oneline.length <= max) return oneline;
  return `${oneline.slice(0, max - 1)}…`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
