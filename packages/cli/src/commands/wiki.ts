import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

import { lookupProjectBySlug, sqliteSchema } from '@coodra/db';
import { generateFeaturesIndex, renderFeatureMd, skillsRoot } from '@coodra/shared/features';
import {
  WIKI_GROUNDING_RELPATH,
  WIKI_ID_RE,
  WIKI_JOB_MD_RELPATH,
  WIKI_JOB_RELPATH,
  WIKI_OKF_DIR_RELPATH,
  type WikiMode,
  wikiDir,
  wikiModeSchema,
} from '@coodra/shared/wiki';
import { and, desc, eq } from 'drizzle-orm';

import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { openBrowser } from '../lib/browser-handoff.js';
import { resolveCoodraDataDb, resolveCoodraHome } from '../lib/coodra-home.js';
import { openLocalDb } from '../lib/open-local-db.js';
import { classifyGeneratedPath, readProjectConfig, recordManifestEntries } from '../lib/project-store/index.js';
import { assembleGrounding, renderGroundingMarkdown } from '../lib/wiki/grounding.js';
import { assembleKnowledgeGrounding, type KnowledgeGrounding } from '../lib/wiki/knowledge.js';
import {
  buildWikiJob,
  deepWikiFeatureFrontmatter,
  renderDeepWikiFeatureBody,
  renderWikiRecipe,
} from '../lib/wiki/recipe.js';
import { pc } from '../ui/compat.js';
import { commandTitle, hintLine, terminalWidth } from '../ui/index.js';

/**
 * `coodra wiki {build,generate,status,list,open,clean}` — Module 10 Deep Wiki.
 *
 * Coodra runs no LLM. `generate` writes a grounding snapshot + an
 * authoring recipe that the user's coding agent (Claude Code / Codex /
 * Cursor) executes against Coodra's wiki_* MCP tools; the result lands in
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
  /** Overwrite the `deep-wiki-author` Feature recipe if it already exists. */
  readonly force?: boolean;
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
  mkdirSync(join(cwd, WIKI_OKF_DIR_RELPATH), { recursive: true });

  // 3. Scaffold the `deep-wiki-author` skill (pulled on trigger). Idempotent
  //    unless --force: a feature.md the user has edited is preserved. MUST use
  //    the resolved skills dir (docs/skills/, or legacy docs/features/) so the
  //    scaffold and the index that `generateFeaturesIndex` writes land in the
  //    SAME directory — a hardcoded docs/features/ here would split them on a
  //    greenfield project that resolves to docs/skills/.
  const featureDir = join(skillsRoot(cwd), 'deep-wiki-author');
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
      // Non-fatal: the recipe still works via .coodra/wiki/job.md.
    }
  }

  await recordManifestEntries({
    root: cwd,
    projectSlug,
    dryRun: false,
    entries: [
      classifyGeneratedPath(groundingPath, cwd, 'coodra wiki build'),
      classifyGeneratedPath(jobJsonPath, cwd, 'coodra wiki build'),
      classifyGeneratedPath(jobMdPath, cwd, 'coodra wiki build'),
      classifyGeneratedPath(mirrorDir, cwd, 'coodra wiki build'),
      classifyGeneratedPath(join(cwd, WIKI_OKF_DIR_RELPATH), cwd, 'coodra wiki build'),
      ...(featureWritten ? [classifyGeneratedPath(featurePath, cwd, 'coodra wiki build')] : []),
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
          featureScaffolded: featureWritten,
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
  const featureRel = relative(cwd, featurePath).split(sep).join('/');
  io.writeStdout(
    featureWritten
      ? `  ${pc.green('✓')} Skill       ${pc.gray(`${featureRel} — pulled when you ask the agent to build the wiki`)}\n`
      : `  ${pc.yellow('◌')} Skill       ${pc.gray(`${featureRel} already exists (use --force to refresh)`)}\n`,
  );
  io.writeStdout('\n');
  io.writeStdout(`  ${pc.bold('Next:')} open your coding agent in this project and invoke the bundled wiki skill:\n`);
  io.writeStdout('\n');
  io.writeStdout(`      ${pc.cyan('Use deep-wiki-author. Read .coodra/wiki/job.md and build the deep wiki by')}\n`);
  io.writeStdout(`      ${pc.cyan('calling the coodra__wiki_save_structure and coodra__wiki_save_page MCP tools.')}\n`);
  io.writeStdout(`      ${pc.cyan(`Mirror successful saves under .coodra/wiki/${slug}/ after the MCP calls.`)}\n`);
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
