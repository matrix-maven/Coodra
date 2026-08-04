import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

import { lookupProjectBySlug, sqliteSchema } from '@coodra/db';
import {
  parseWikiPageFrontmatter,
  scoreWikiCorpus,
  WIKI_GROUNDING_RELPATH,
  WIKI_ID_RE,
  WIKI_JOB_MD_RELPATH,
  WIKI_JOB_RELPATH,
  type WikiMode,
  type WikiScorableEntry,
  wikiDir,
  wikiMdDir,
  wikiModeSchema,
  wikiStructureSchema,
} from '@coodra/shared/wiki';
import { and, desc, eq } from 'drizzle-orm';

import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { openBrowser } from '../lib/browser-handoff.js';
import { resolveCoodraDataDb, resolveCoodraHome } from '../lib/coodra-home.js';
import { openLocalDb } from '../lib/open-local-db.js';
import { classifyGeneratedPath, readProjectConfig, recordManifestEntries } from '../lib/project-store/index.js';
import { assembleGrounding, renderGroundingMarkdown } from '../lib/wiki/grounding.js';
import { assembleKnowledgeGrounding, type KnowledgeGrounding } from '../lib/wiki/knowledge.js';
import { buildWikiJob, renderWikiRecipe } from '../lib/wiki/recipe.js';
import { pc } from '../ui/compat.js';
import { commandTitle, hintLine, terminalWidth } from '../ui/index.js';

/**
 * `coodra wiki {build,generate,status,list,open,clean}` — Module 10 Deep Wiki.
 *
 * Coodra runs no LLM. `generate` writes a grounding snapshot + an
 * authoring recipe that the user's coding agent (Claude Code / Codex)
 * executes against Coodra's wiki_* MCP tools; the result lands in
 * the local SQLite store (and syncs to cloud in team mode) and renders in
 * the web app at `/wiki`. `status` / `list` read that store; `clean`
 * deletes a wiki; `open` opens the web view.
 */

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

/** Resolve the project: `.coodra/config.json::projectSlug` if present, else the directory basename. */
async function resolveProject(cwdOverride: string | undefined): Promise<ResolvedProject> {
  const cwd = cwdOverride ?? process.cwd();
  const projectSlug = (await readProjectConfig(cwd))?.projectSlug;
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

/**
 * Read the project's recorded decisions + context packs for the grounding.
 * Best-effort: any failure (store missing, project unregistered, read error)
 * returns null so `wiki build` still produces a code-only grounding rather
 * than aborting. The knowledge layer is an enrichment, never a gate.
 */
async function readKnowledgeGrounding(projectSlug: string): Promise<KnowledgeGrounding | null> {
  const dataDb = resolveCoodraDataDb(resolveCoodraHome());
  if (!existsSync(dataDb)) return null;
  let handle: Awaited<ReturnType<typeof openLocalDb>> | null = null;
  try {
    handle = await openLocalDb(dataDb);
    return await assembleKnowledgeGrounding(handle, projectSlug);
  } catch {
    return null;
  } finally {
    handle?.close();
  }
}

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

export interface WikiGenerateOptions {
  readonly slug?: string;
  readonly mode?: string;
  readonly cwd?: string;
  readonly json?: boolean;
}

export async function runWikiGenerateCommand(
  options: WikiGenerateOptions = {},
  io: WikiIO = DEFAULT_WIKI_IO,
): Promise<never> {
  const { cwd, projectSlug } = await resolveProject(options.cwd);
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

  // 1. Grounding snapshot. The code-only part is pure filesystem; the
  //    knowledge part (prior decisions + context packs) needs the local store,
  //    so open it here and degrade to null if it isn't reachable — a wiki
  //    generated before the first `coodra init` is legitimate.
  const knowledge = await readKnowledgeGrounding(projectSlug);
  const grounding = await assembleGrounding({ cwd, projectSlug, knowledge });
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
  const mirrorDir = wikiDir(cwd, slug);
  mkdirSync(mirrorDir, { recursive: true });

  await recordManifestEntries({
    root: cwd,
    projectSlug,
    dryRun: false,
    entries: [
      classifyGeneratedPath(groundingPath, cwd, 'coodra wiki build'),
      classifyGeneratedPath(jobJsonPath, cwd, 'coodra wiki build'),
      classifyGeneratedPath(jobMdPath, cwd, 'coodra wiki build'),
      classifyGeneratedPath(mirrorDir, cwd, 'coodra wiki build'),
    ],
  });

  if (json) {
    io.writeStdout(
      `${JSON.stringify(
        {
          ok: true,
          command: 'wiki build',
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
          markdownMirror: relative(cwd, mirrorDir).split(sep).join('/'),
        },
        null,
        2,
      )}\n`,
    );
    return io.exit(EXIT_OK);
  }

  io.writeStdout(`${commandTitle('Deep Wiki', 'build', { width: terminalWidth(), indent: 0 })}\n\n`);
  io.writeStdout(
    `  ${pc.green('✓')} Grounding   ${pc.gray(`${WIKI_GROUNDING_RELPATH} — ${grounding.fileCount} files${grounding.graphify ? ', graphify graph found' : ''}`)}\n`,
  );
  io.writeStdout(
    `  ${pc.green('✓')} Recipe      ${pc.gray(`${WIKI_JOB_MD_RELPATH} (slug "${slug}", mode "${mode}")`)}\n`,
  );
  io.writeStdout('\n');
  io.writeStdout(`  ${pc.bold('Next:')} open your coding agent in this project and invoke the bundled wiki skill:\n`);
  io.writeStdout('\n');
  io.writeStdout(`      ${pc.cyan('Use coodra-wiki. Read .coodra/wiki/job.md and build the deep wiki by')}\n`);
  io.writeStdout(`      ${pc.cyan('calling the coodra__wiki_save_structure and coodra__wiki_save_page MCP tools.')}\n`);
  io.writeStdout(`      ${pc.cyan(`Mirror successful saves under .coodra/wiki/${slug}/md/ after the MCP calls.`)}\n`);
  io.writeStdout('\n');
  io.writeStdout(
    `${hintLine('  (A vague "generate the deep wiki" can make agents free-write root files instead of')}\n`,
  );
  io.writeStdout(
    `${hintLine('  calling the tools — only MCP saves reach ')}${pc.cyan('coodra wiki status')}${pc.gray(' or the web app.)')}\n`,
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
  const { projectSlug } = await resolveProject(options.cwd);
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
      `${hintLine('  Run ')}${pc.cyan('coodra wiki build')}${pc.gray(' then ask your agent to build it.')}\n\n`,
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
  const { projectSlug } = await resolveProject(options.cwd);
  const env = options.env ?? process.env;
  const dataDb = resolveCoodraDataDb(resolveCoodraHome({ env }));
  const { wikis } = await loadWikis(dataDb, projectSlug);

  if (options.json === true) {
    io.writeStdout(`${JSON.stringify({ ok: true, projectSlug, wikis }, null, 2)}\n`);
    return io.exit(EXIT_OK);
  }

  io.writeStdout(`${commandTitle('Deep Wiki', `list — ${projectSlug}`, { width: terminalWidth(), indent: 0 })}\n\n`);
  if (wikis.length === 0) {
    io.writeStdout(`  ${pc.gray('No wikis yet. Run ')}${pc.cyan('coodra wiki build')}${pc.gray('.')}\n\n`);
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
  const { projectSlug } = await resolveProject(options.cwd);
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

// ---------------------------------------------------------------------------
// ask
// ---------------------------------------------------------------------------

export interface WikiAskOptions {
  readonly slug?: string;
  readonly limit?: number;
  /** Skip the local Markdown mirror and rank against the DB directly. */
  readonly refresh?: boolean;
  readonly cwd?: string;
  readonly json?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

interface WikiAskResultRow {
  readonly pageId: string;
  readonly title: string;
  readonly score: number;
  readonly excerpt: string;
  readonly filePath?: string;
}

/** Read every page file under a connected-Markdown mirror dir, `index.md` excluded. */
function loadLocalWikiCorpus(mdDir: string): WikiScorableEntry[] {
  const files = readdirSync(mdDir).filter((f) => f.endsWith('.md') && f !== 'index.md');
  const entries: WikiScorableEntry[] = [];
  for (const file of files) {
    const raw = readFileSync(join(mdDir, file), 'utf8');
    const { frontmatter, body } = parseWikiPageFrontmatter(raw);
    const pageId = typeof frontmatter?.pageId === 'string' ? frontmatter.pageId : basename(file, '.md');
    const title = typeof frontmatter?.title === 'string' ? frontmatter.title : pageId;
    const description = typeof frontmatter?.description === 'string' ? frontmatter.description : '';
    entries.push({ pageId, title, description, body });
  }
  return entries;
}

/**
 * DB-fallback read for `wiki ask`. Per-page `title`/`description` live
 * only inside `wikis.structureJson` (no queryable column — see
 * `packages/db/src/schema/sqlite.ts`), so this parses that JSON blob in
 * application code and joins it in-memory with `wikiPages.contentMarkdown`
 * (filtered to `state: 'authored'` — pending rows are empty noise).
 * Distinct from `loadWikis`, which only selects `state` for progress
 * counts, not content.
 */
async function loadWikiForAsk(
  dataDb: string,
  projectSlug: string,
  slug: string,
): Promise<{ projectFound: boolean; wikiFound: boolean; entries: WikiScorableEntry[] }> {
  const handle = await openLocalDb(dataDb);
  try {
    const project = await lookupProjectBySlug(handle, projectSlug);
    if (project === null) return { projectFound: false, wikiFound: false, entries: [] };

    const matched = await handle.db
      .select({ id: sqliteSchema.wikis.id, structureJson: sqliteSchema.wikis.structureJson })
      .from(sqliteSchema.wikis)
      .where(and(eq(sqliteSchema.wikis.projectId, project.id), eq(sqliteSchema.wikis.slug, slug)))
      .limit(1);
    const wiki = matched[0];
    if (wiki === undefined) return { projectFound: true, wikiFound: false, entries: [] };

    const pageMeta = new Map<string, { readonly title: string; readonly description: string }>();
    try {
      const structureParse = wikiStructureSchema.safeParse(JSON.parse(wiki.structureJson));
      if (structureParse.success) {
        for (const page of structureParse.data.pages) {
          pageMeta.set(page.id, { title: page.title, description: page.description });
        }
      }
    } catch {
      // Malformed/legacy structureJson — degrade to pageId-only metadata
      // below rather than aborting the whole fallback path.
    }

    const pages = await handle.db
      .select({
        pageId: sqliteSchema.wikiPages.pageId,
        contentMarkdown: sqliteSchema.wikiPages.contentMarkdown,
        state: sqliteSchema.wikiPages.state,
      })
      .from(sqliteSchema.wikiPages)
      .where(eq(sqliteSchema.wikiPages.wikiId, wiki.id));

    const entries: WikiScorableEntry[] = [];
    for (const page of pages) {
      if (page.state !== 'authored') continue;
      const meta = pageMeta.get(page.pageId);
      entries.push({
        pageId: page.pageId,
        title: meta?.title ?? page.pageId,
        description: meta?.description ?? '',
        body: page.contentMarkdown,
      });
    }
    return { projectFound: true, wikiFound: true, entries };
  } finally {
    handle.close();
  }
}

/**
 * `coodra wiki ask "<question>"` — pure retrieval, never a synthesized
 * answer (Coodra runs no LLM). Ranks Deep Wiki pages against `question`:
 * local connected-Markdown mirror first (`.coodra/wiki/<slug>/md/`, no
 * DB touched at all — a directly testable invariant), DB fallback when
 * that mirror is missing, empty, or `--refresh` is passed. The same
 * fallback condition transparently covers pre-existing flat-layout
 * mirrors too (their files sit one level up from `md/`, so the local
 * check naturally finds nothing there) — no special-case migration
 * needed. The calling coding agent reads the ranked files/excerpts this
 * prints and composes the actual answer.
 */
export async function runWikiAskCommand(
  question: string,
  options: WikiAskOptions = {},
  io: WikiIO = DEFAULT_WIKI_IO,
): Promise<never> {
  const { cwd, projectSlug } = await resolveProject(options.cwd);
  const slug = toWikiSlug(options.slug ?? projectSlug);
  const scoreOpts = options.limit !== undefined ? { limit: options.limit } : undefined;

  const mdDir = wikiMdDir(cwd, slug);
  let source: 'local' | 'db' = 'local';
  let results: WikiAskResultRow[] = [];
  let resolved = false;

  if (options.refresh !== true && existsSync(mdDir)) {
    const localEntries = loadLocalWikiCorpus(mdDir);
    if (localEntries.length > 0) {
      resolved = true;
      results = scoreWikiCorpus(localEntries, question, scoreOpts).map((r) => ({
        ...r,
        filePath: relative(cwd, join(mdDir, `${r.pageId}.md`))
          .split(sep)
          .join('/'),
      }));
    }
  }

  if (!resolved) {
    source = 'db';
    const env = options.env ?? process.env;
    const dataDb = resolveCoodraDataDb(resolveCoodraHome({ env }));
    const { projectFound, wikiFound, entries } = await loadWikiForAsk(dataDb, projectSlug, slug);
    if (!projectFound || !wikiFound) {
      const msg = `No wiki "${slug}" found locally or in the DB. Run ${pc.cyan('coodra wiki build')} first, then have your agent author it.`;
      if (options.json === true) {
        io.writeStdout(`${JSON.stringify({ ok: false, error: 'no_wiki', message: msg }, null, 2)}\n`);
      } else {
        io.writeStderr(`${pc.red('✗')} ${msg}\n`);
      }
      return io.exit(EXIT_USER_RECOVERABLE);
    }
    results = scoreWikiCorpus(entries, question, scoreOpts);
  }

  if (options.json === true) {
    io.writeStdout(`${JSON.stringify({ ok: true, question, slug, source, results }, null, 2)}\n`);
    return io.exit(EXIT_OK);
  }

  io.writeStdout(`${commandTitle('Deep Wiki', `ask — ${slug}`, { width: terminalWidth(), indent: 0 })}\n\n`);
  if (results.length === 0) {
    io.writeStdout(`  ${pc.yellow('◌')} ${pc.gray('No matching pages.')}\n\n`);
    return io.exit(EXIT_OK);
  }
  io.writeStdout(`  ${pc.gray(`source: ${source}`)}\n\n`);
  results.forEach((r, i) => {
    io.writeStdout(
      `  ${pc.bold(`${i + 1}.`)} ${pc.bold(r.title)} ${pc.gray(`(${r.pageId}, score ${r.score.toFixed(1)})`)}\n`,
    );
    if (r.filePath !== undefined) io.writeStdout(`     ${pc.cyan(r.filePath)}\n`);
    io.writeStdout(`     ${pc.gray(r.excerpt)}\n\n`);
  });
  io.writeStdout(
    `${hintLine('  This is retrieval only — open the listed files and answer from them; Coodra does not generate answers itself.')}\n\n`,
  );
  return io.exit(EXIT_OK);
}
