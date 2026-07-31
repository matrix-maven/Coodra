import { resolve } from 'node:path';

/**
 * `@coodra/shared/wiki/paths` — on-disk locations for Deep Wiki
 * artifacts.
 *
 * The DB (local SQLite primary, cloud Postgres for team sync) is the
 * source of truth for wiki content — the agent persists via the MCP
 * tools and the web reads from the DB (same model as decisions / runs).
 * These helpers compute the repo-local working files and Markdown mirror
 * under the project root, used by:
 *
 *   - the CLI's grounding bundle + job file (`coodra wiki build`),
 *   - the agent's Markdown mirror after successful MCP saves,
 *   - `coodra wiki export` when materialising portable bundles.
 *
 * Layout, repo-root-relative:
 *
 *   .coodra/wiki/grounding.md              — active grounding bundle
 *   .coodra/wiki/job.json                  — active generation job descriptor
 *   .coodra/wiki/job.md                    — active agent-readable recipe
 *   .coodra/wiki/<wikiSlug>/structure.json — WikiStructure mirror
 *   .coodra/wiki/<wikiSlug>/<pageId>.md    — one Markdown body per page
 *   .coodra/wiki/okf/                      — portable OKF import/export bundles
 */

/** Repo-root-relative root for wiki working artifacts. */
export const WIKI_WORK_DIRNAME = '.coodra/wiki' as const;
/** Repo-root-relative path of the active grounding bundle. */
export const WIKI_GROUNDING_RELPATH = '.coodra/wiki/grounding.md' as const;
/** Repo-root-relative path of the active agent-readable job recipe. */
export const WIKI_JOB_MD_RELPATH = '.coodra/wiki/job.md' as const;
/** Repo-root-relative directory for portable OKF import/export bundles. */
export const WIKI_OKF_DIR_RELPATH = '.coodra/wiki/okf' as const;
/** Repo-root-relative root for the wiki Markdown mirror. */
export const WIKI_DOCS_DIRNAME = WIKI_WORK_DIRNAME;
/** Repo-root-relative path of the active generation job descriptor. */
export const WIKI_JOB_RELPATH = '.coodra/wiki/job.json' as const;
/** Filename of the structure envelope inside a wiki dir. */
export const WIKI_STRUCTURE_FILENAME = 'structure.json' as const;

/** Absolute path to `<projectRoot>/.coodra/wiki`. */
export function wikiDocsRoot(projectRoot: string): string {
  return resolve(projectRoot, WIKI_DOCS_DIRNAME);
}

/** Absolute path to `<projectRoot>/.coodra/wiki/<wikiSlug>`. */
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

/** Absolute path to `<projectRoot>/.coodra/wiki/job.json`. */
export function wikiJobPath(projectRoot: string): string {
  return resolve(projectRoot, WIKI_JOB_RELPATH);
}
