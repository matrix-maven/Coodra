import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { lookupProjectBySlug, sqliteSchema } from '@coodra/db';
import { generateFeaturesIndex, renderFeatureMd } from '@coodra/shared/features';
import { WIKI_ID_RE, WIKI_JOB_RELPATH, type WikiMode, wikiModeSchema } from '@coodra/shared/wiki';
import { and, desc, eq } from 'drizzle-orm';

import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { openBrowser } from '../lib/browser-handoff.js';
import { resolveCoodraDataDb, resolveCoodraHome } from '../lib/coodra-home.js';
import { openLocalDb } from '../lib/open-local-db.js';
import { assembleGrounding, renderGroundingMarkdown } from '../lib/wiki/grounding.js';
import {
  buildWikiJob,
  deepWikiFeatureFrontmatter,
  renderDeepWikiFeatureBody,
  renderWikiRecipe,
} from '../lib/wiki/recipe.js';
import { pc } from '../ui/compat.js';
import { commandTitle, hintLine, terminalWidth } from '../ui/index.js';

/**
 * `coodra wiki {generate,status,list,open,clean}` — Module 10 Deep Wiki.
 *
 * Coodra runs no LLM. `generate` writes a grounding snapshot + an
 * authoring recipe that the user's coding agent (Claude Code / Codex /
 * Cursor) executes against Coodra's wiki_* MCP tools; the result lands in
 * the local SQLite store (and syncs to cloud in team mode) and renders in
 * the web app at `/wiki`. `status` / `list` read that store; `clean`
 * deletes a wiki; `open` opens the web view.
 */

const WIKI_GROUNDING_RELPATH = '.coodra/wiki-grounding.md';
const WIKI_JOB_MD_RELPATH = '.coodra/wiki-job.md';

export interface WikiIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_WIKI_IO: WikiIO = {
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

interface ResolvedProject {
  readonly cwd: string;
  readonly projectSlug: string;
}

/** Resolve the project: `.coodra.json::projectSlug` if present, else the directory basename. */
function resolveProject(cwdOverride: string | undefined): ResolvedProject {
  const cwd = cwdOverride ?? process.cwd();
  let projectSlug: string | undefined;
  const sidecar = join(cwd, '.coodra.json');
  if (existsSync(sidecar)) {
    try {
      const json = JSON.parse(readFileSync(sidecar, 'utf8')) as { projectSlug?: unknown };
      if (typeof json.projectSlug === 'string' && json.projectSlug.length > 0) projectSlug = json.projectSlug;
    } catch {
      // ignore malformed sidecar — fall back to basename.
    }
  }
  return { cwd, projectSlug: projectSlug ?? basename(cwd) };
}

/** Sanitise an arbitrary string into a wiki slug (kebab, matches WIKI_ID_RE). */
function toWikiSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

export interface WikiGenerateOptions {
  readonly slug?: string;
  readonly mode?: string;
  readonly cwd?: string;
  readonly json?: boolean;
  /** Overwrite the `deep-wiki-author` Feature recipe if it already exists. */
  readonly force?: boolean;
}

export async function runWikiGenerateCommand(
  options: WikiGenerateOptions = {},
  io: WikiIO = DEFAULT_WIKI_IO,
): Promise<never> {
  const { cwd, projectSlug } = resolveProject(options.cwd);
  const json = options.json === true;

  // Mode.
  const modeParse = wikiModeSchema.safeParse(options.mode ?? 'comprehensive');
  if (!modeParse.success) {
    const msg = 'mode must be "comprehensive" or "concise".';
    if (json) io.writeStdout(`${JSON.stringify({ ok: false, error: 'bad_mode', message: msg }, null, 2)}\n`);
    else io.writeStderr(`${pc.red('✗')} ${msg}\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }
  const mode: WikiMode = modeParse.data;

  // Slug.
  const slug = toWikiSlug(options.slug ?? projectSlug);
  if (!WIKI_ID_RE.test(slug)) {
    const msg = `Could not derive a valid wiki slug from "${options.slug ?? projectSlug}". Pass --slug <kebab-case>.`;
    if (json) io.writeStdout(`${JSON.stringify({ ok: false, error: 'bad_slug', message: msg }, null, 2)}\n`);
    else io.writeStderr(`${pc.red('✗')} ${msg}\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  // 1. Grounding snapshot.
  const grounding = assembleGrounding({ cwd, projectSlug });
  const groundingPath = join(cwd, WIKI_GROUNDING_RELPATH);
  mkdirSync(dirname(groundingPath), { recursive: true });
  writeFileSync(groundingPath, renderGroundingMarkdown(grounding), 'utf8');

  // 2. Job descriptor (machine) + recipe (agent-readable).
  const job = buildWikiJob({ projectSlug, slug, mode, groundingPath: WIKI_GROUNDING_RELPATH });
  const jobJsonPath = join(cwd, WIKI_JOB_RELPATH);
  mkdirSync(dirname(jobJsonPath), { recursive: true });
  writeFileSync(jobJsonPath, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
  const jobMdPath = join(cwd, WIKI_JOB_MD_RELPATH);
  writeFileSync(
    jobMdPath,
    renderWikiRecipe({ projectSlug, slug, mode, groundingPath: WIKI_GROUNDING_RELPATH, includeJobHeader: true }),
    'utf8',
  );

  // 3. Scaffold the `deep-wiki-author` Feature (pulled on trigger). Idempotent
  //    unless --force: a feature.md the user has edited is preserved.
  const featureDir = join(cwd, 'docs', 'features', 'deep-wiki-author');
  const featurePath = join(featureDir, 'feature.md');
  let featureWritten = false;
  if (!existsSync(featurePath) || options.force === true) {
    mkdirSync(featureDir, { recursive: true });
    const fm = deepWikiFeatureFrontmatter();
    writeFileSync(
      featurePath,
      renderFeatureMd({
        frontmatter: {
          name: fm.name,
          description: fm.description,
          whenNotToUse: fm.whenNotToUse,
          maturity: fm.maturity,
        },
        body: renderDeepWikiFeatureBody(),
      }),
      'utf8',
    );
    featureWritten = true;
    // Refresh the features index so the bridge/MCP surface the new recipe.
    try {
      generateFeaturesIndex({ projectCwd: cwd, projectSlug });
    } catch {
      // Non-fatal: the recipe still works via .coodra/wiki-job.md.
    }
  }

  if (json) {
    io.writeStdout(
      `${JSON.stringify(
        {
          ok: true,
          command: 'wiki generate',
          projectSlug,
          slug,
          mode,
          grounding: {
            path: WIKI_GROUNDING_RELPATH,
            fileCount: grounding.fileCount,
            hasReadme: grounding.readme !== null,
            hasGraphify: grounding.graphify !== null,
          },
          job: WIKI_JOB_RELPATH,
          recipe: WIKI_JOB_MD_RELPATH,
          featureScaffolded: featureWritten,
        },
        null,
        2,
      )}\n`,
    );
    return io.exit(EXIT_OK);
  }

  io.writeStdout(`${commandTitle('Deep Wiki', 'generate', { width: terminalWidth(), indent: 0 })}\n\n`);
  io.writeStdout(
    `  ${pc.green('✓')} Grounding   ${pc.gray(`${WIKI_GROUNDING_RELPATH} — ${grounding.fileCount} files${grounding.graphify ? ', graphify graph found' : ''}`)}\n`,
  );
  io.writeStdout(
    `  ${pc.green('✓')} Recipe      ${pc.gray(`${WIKI_JOB_MD_RELPATH} (slug "${slug}", mode "${mode}")`)}\n`,
  );
  io.writeStdout(
    featureWritten
      ? `  ${pc.green('✓')} Feature     ${pc.gray('docs/features/deep-wiki-author/feature.md — pulled when you ask the agent to build the wiki')}\n`
      : `  ${pc.yellow('◌')} Feature     ${pc.gray('docs/features/deep-wiki-author/feature.md already exists (use --force to refresh)')}\n`,
  );
  io.writeStdout('\n');
  io.writeStdout(`  ${pc.bold('Next:')} open your coding agent in this project and paste this prompt:\n`);
  io.writeStdout('\n');
  io.writeStdout(`      ${pc.cyan('Read .coodra/wiki-job.md and follow it exactly. Build the deep wiki by')}\n`);
  io.writeStdout(`      ${pc.cyan('calling the coodra__wiki_save_structure and coodra__wiki_save_page MCP tools.')}\n`);
  io.writeStdout(`      ${pc.cyan('Do NOT write any markdown/JSON files — persist only via the MCP tools.')}\n`);
  io.writeStdout('\n');
  io.writeStdout(
    `${hintLine('  (A vague "generate the deep wiki" makes some agents free-write DEEP_WIKI.md instead of')}\n`,
  );
  io.writeStdout(
    `${hintLine('  calling the tools — those files never reach ')}${pc.cyan('coodra wiki status')}${pc.gray(' or the web app.)')}\n`,
  );
  io.writeStdout('\n');
  io.writeStdout(
    `${hintLine('  If the agent says the wiki_* tools are missing: ')}${pc.cyan('coodra stop && coodra start')}${pc.gray(', then reconnect the agent.')}\n`,
  );
  io.writeStdout(
    `${hintLine('  Track it with ')}${pc.cyan('coodra wiki status')}${pc.gray('; view it with ')}${pc.cyan('coodra wiki open')}.\n`,
  );
  io.writeStdout('\n');
  return io.exit(EXIT_OK);
}

// ---------------------------------------------------------------------------
// shared DB read helpers
// ---------------------------------------------------------------------------

interface WikiListRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly mode: string;
  readonly updatedAt: Date;
  readonly pageCount: number;
  readonly authoredCount: number;
}

async function loadWikis(
  dataDb: string,
  projectSlug: string,
): Promise<{ projectFound: boolean; wikis: WikiListRow[] }> {
  const handle = await openLocalDb(dataDb);
  try {
    const project = await lookupProjectBySlug(handle, projectSlug);
    if (project === null) return { projectFound: false, wikis: [] };
    const wikiRows = await handle.db
      .select({
        id: sqliteSchema.wikis.id,
        slug: sqliteSchema.wikis.slug,
        title: sqliteSchema.wikis.title,
        mode: sqliteSchema.wikis.mode,
        updatedAt: sqliteSchema.wikis.updatedAt,
      })
      .from(sqliteSchema.wikis)
      .where(eq(sqliteSchema.wikis.projectId, project.id))
      .orderBy(desc(sqliteSchema.wikis.updatedAt));
    const out: WikiListRow[] = [];
    for (const w of wikiRows) {
      const pages = await handle.db
        .select({ state: sqliteSchema.wikiPages.state })
        .from(sqliteSchema.wikiPages)
        .where(eq(sqliteSchema.wikiPages.wikiId, w.id));
      out.push({
        id: w.id,
        slug: w.slug,
        title: w.title,
        mode: w.mode,
        updatedAt: w.updatedAt,
        pageCount: pages.length,
        authoredCount: pages.filter((p) => p.state === 'authored').length,
      });
    }
    return { projectFound: true, wikis: out };
  } finally {
    handle.close();
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export interface WikiStatusOptions {
  readonly slug?: string;
  readonly cwd?: string;
  readonly json?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export async function runWikiStatusCommand(
  options: WikiStatusOptions = {},
  io: WikiIO = DEFAULT_WIKI_IO,
): Promise<never> {
  const { projectSlug } = resolveProject(options.cwd);
  const env = options.env ?? process.env;
  const dataDb = resolveCoodraDataDb(resolveCoodraHome({ env }));
  const { projectFound, wikis } = await loadWikis(dataDb, projectSlug);

  const targetSlug = options.slug !== undefined ? toWikiSlug(options.slug) : toWikiSlug(projectSlug);
  const wiki = wikis.find((w) => w.slug === targetSlug) ?? wikis[0];

  if (options.json === true) {
    io.writeStdout(`${JSON.stringify({ ok: true, projectSlug, projectFound, wiki: wiki ?? null }, null, 2)}\n`);
    return io.exit(EXIT_OK);
  }

  io.writeStdout(`${commandTitle('Deep Wiki', `status — ${projectSlug}`, { width: terminalWidth(), indent: 0 })}\n\n`);
  if (!wiki) {
    io.writeStdout(`  ${pc.yellow('◌')} ${pc.gray('No wiki yet for this project.')}\n\n`);
    io.writeStdout(
      `${hintLine('  Run ')}${pc.cyan('coodra wiki generate')}${pc.gray(' then ask your agent to build it.')}\n\n`,
    );
    return io.exit(EXIT_OK);
  }
  const pending = wiki.pageCount - wiki.authoredCount;
  const done = pending === 0 && wiki.pageCount > 0;
  const glyph = done ? pc.green('✓') : pc.yellow('◌');
  io.writeStdout(`  ${glyph} ${pc.bold(wiki.title)} ${pc.gray(`(${wiki.slug}, ${wiki.mode})`)}\n`);
  io.writeStdout(
    `    ${pc.gray(`${wiki.authoredCount} / ${wiki.pageCount} pages authored${done ? ' — complete' : `, ${pending} pending`}`)}\n\n`,
  );
  io.writeStdout(
    done
      ? `${hintLine('  View it: ')}${pc.cyan('coodra wiki open')}\n\n`
      : `${hintLine('  Ask the agent to continue authoring (it can resume via wiki_status).')}\n\n`,
  );
  return io.exit(EXIT_OK);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface WikiListOptions {
  readonly cwd?: string;
  readonly json?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export async function runWikiListCommand(options: WikiListOptions = {}, io: WikiIO = DEFAULT_WIKI_IO): Promise<never> {
  const { projectSlug } = resolveProject(options.cwd);
  const env = options.env ?? process.env;
  const dataDb = resolveCoodraDataDb(resolveCoodraHome({ env }));
  const { wikis } = await loadWikis(dataDb, projectSlug);

  if (options.json === true) {
    io.writeStdout(`${JSON.stringify({ ok: true, projectSlug, wikis }, null, 2)}\n`);
    return io.exit(EXIT_OK);
  }

  io.writeStdout(`${commandTitle('Deep Wiki', `list — ${projectSlug}`, { width: terminalWidth(), indent: 0 })}\n\n`);
  if (wikis.length === 0) {
    io.writeStdout(`  ${pc.gray('No wikis yet. Run ')}${pc.cyan('coodra wiki generate')}${pc.gray('.')}\n\n`);
    return io.exit(EXIT_OK);
  }
  for (const w of wikis) {
    const pending = w.pageCount - w.authoredCount;
    const glyph = pending === 0 && w.pageCount > 0 ? pc.green('✓') : pc.yellow('◌');
    io.writeStdout(
      `  ${glyph} ${pc.bold(w.slug.padEnd(20))} ${pc.gray(`${w.authoredCount}/${w.pageCount} pages · ${w.mode}`)}\n`,
    );
  }
  io.writeStdout('\n');
  return io.exit(EXIT_OK);
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

export interface WikiOpenOptions {
  readonly cwd?: string;
  readonly webUrl?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly json?: boolean;
}

export async function runWikiOpenCommand(options: WikiOpenOptions = {}, io: WikiIO = DEFAULT_WIKI_IO): Promise<never> {
  const env = options.env ?? process.env;
  const webUrl = (options.webUrl ?? env.COODRA_WEB_URL ?? 'http://localhost:3001').replace(/\/$/, '');
  const url = `${webUrl}/wiki`;
  if (options.json === true) {
    io.writeStdout(`${JSON.stringify({ ok: true, url }, null, 2)}\n`);
    return io.exit(EXIT_OK);
  }
  io.writeStdout(`${commandTitle('Deep Wiki', 'open', { width: terminalWidth(), indent: 0 })}\n\n`);
  const opened = openBrowser(url);
  io.writeStdout(
    opened
      ? `  ${pc.green('✓')} Opening ${pc.cyan(url)}\n\n`
      : `  ${pc.yellow('◌')} Open ${pc.cyan(url)} ${pc.gray('in your browser.')}\n\n`,
  );
  io.writeStdout(`${hintLine('  The web app must be running — start it with ')}${pc.cyan('coodra start')}.\n\n`);
  return io.exit(EXIT_OK);
}

// ---------------------------------------------------------------------------
// clean
// ---------------------------------------------------------------------------

export interface WikiCleanOptions {
  readonly cwd?: string;
  readonly json?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export async function runWikiCleanCommand(
  rawSlug: string,
  options: WikiCleanOptions = {},
  io: WikiIO = DEFAULT_WIKI_IO,
): Promise<never> {
  const { projectSlug } = resolveProject(options.cwd);
  const env = options.env ?? process.env;
  const slug = toWikiSlug(rawSlug);
  const dataDb = resolveCoodraDataDb(resolveCoodraHome({ env }));
  const handle = await openLocalDb(dataDb);
  try {
    const project = await lookupProjectBySlug(handle, projectSlug);
    if (project === null) {
      const msg = `No project "${projectSlug}" in the local store — nothing to clean.`;
      if (options.json === true)
        io.writeStdout(`${JSON.stringify({ ok: false, error: 'project_not_found', message: msg }, null, 2)}\n`);
      else io.writeStderr(`${pc.red('✗')} ${msg}\n`);
      return io.exit(EXIT_USER_RECOVERABLE);
    }
    const matched = await handle.db
      .select({ id: sqliteSchema.wikis.id })
      .from(sqliteSchema.wikis)
      .where(and(eq(sqliteSchema.wikis.projectId, project.id), eq(sqliteSchema.wikis.slug, slug)))
      .limit(1);
    const wikiId = matched[0]?.id ?? null;
    if (wikiId === null) {
      const msg = `No wiki "${slug}" for project "${projectSlug}".`;
      if (options.json === true)
        io.writeStdout(`${JSON.stringify({ ok: false, error: 'wiki_not_found', message: msg }, null, 2)}\n`);
      else io.writeStderr(`${pc.red('✗')} ${msg}\n`);
      return io.exit(EXIT_USER_RECOVERABLE);
    }
    // Delete pages first, then the wiki (explicit — better-sqlite3 FK cascade
    // depends on the PRAGMA; this guarantees both are removed regardless).
    await handle.db.delete(sqliteSchema.wikiPages).where(eq(sqliteSchema.wikiPages.wikiId, wikiId));
    await handle.db.delete(sqliteSchema.wikis).where(eq(sqliteSchema.wikis.id, wikiId));
    if (options.json === true) {
      io.writeStdout(`${JSON.stringify({ ok: true, deleted: { wikiId, slug } }, null, 2)}\n`);
      return io.exit(EXIT_OK);
    }
    io.writeStdout(`${commandTitle('Deep Wiki', 'clean', { width: terminalWidth(), indent: 0 })}\n\n`);
    io.writeStdout(`  ${pc.green('✓')} Deleted wiki ${pc.bold(slug)} ${pc.gray(`(${wikiId})`)}\n\n`);
    return io.exit(EXIT_OK);
  } finally {
    handle.close();
  }
}
