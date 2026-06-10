import { resolve } from 'node:path';

/**
 * `@coodra/shared/wiki/paths` — on-disk locations for Deep Wiki
 * artifacts.
 *
 * The DB (local SQLite primary, cloud Postgres for team sync) is the
 * source of truth for wiki content — the agent persists via the MCP
 * tools and the web reads from the DB (same model as decisions / runs).
 * These helpers compute an OPTIONAL git-diffable disk mirror under the
 * project root, used by:
 *
 *   - the CLI's grounding bundle + job file (`coodra wiki generate`),
 *   - a future `coodra wiki export` that materialises pages to Markdown.
 *
 * Layout, repo-root-relative:
 *
 *   docs/wiki/<wikiSlug>/structure.json   — the WikiStructure envelope
 *   docs/wiki/<wikiSlug>/<pageId>.md       — one Markdown body per page
 *   .coodra/wiki-job.json                  — the active generation job
 */

/** Repo-root-relative root for the wiki disk mirror. */
export const WIKI_DOCS_DIRNAME = 'docs/wiki' as const;
/** Repo-root-relative path of the active generation job descriptor. */
export const WIKI_JOB_RELPATH = '.coodra/wiki-job.json' as const;
/** Filename of the structure envelope inside a wiki dir. */
export const WIKI_STRUCTURE_FILENAME = 'structure.json' as const;

/** Absolute path to `<projectRoot>/docs/wiki`. */
export function wikiDocsRoot(projectRoot: string): string {
  return resolve(projectRoot, WIKI_DOCS_DIRNAME);
}

/** Absolute path to `<projectRoot>/docs/wiki/<wikiSlug>`. */
export function wikiDir(projectRoot: string, wikiSlug: string): string {
  return resolve(wikiDocsRoot(projectRoot), wikiSlug);
}

/** Absolute path to a wiki's `structure.json`. */
export function wikiStructurePath(projectRoot: string, wikiSlug: string): string {
  return resolve(wikiDir(projectRoot, wikiSlug), WIKI_STRUCTURE_FILENAME);
}

/**
 * Absolute path to a page's Markdown file. `pageId` is already validated
 * kebab-case (see `WIKI_ID_RE`), so it is filesystem-safe with no
 * traversal risk.
 */
export function wikiPagePath(projectRoot: string, wikiSlug: string, pageId: string): string {
  return resolve(wikiDir(projectRoot, wikiSlug), `${pageId}.md`);
}

/** Absolute path to `<projectRoot>/.coodra/wiki-job.json`. */
export function wikiJobPath(projectRoot: string): string {
  return resolve(projectRoot, WIKI_JOB_RELPATH);
}
