/**
 * @coodra/shared/wiki — public surface for the Deep Wiki schema
 * (Module 10).
 *
 * Single import site for every consumer (CLI authoring + grounding,
 * mcp-server persistence tools, web `/wiki` render, sync-daemon cloud
 * sync) so the on-disk format, the MCP wire contract, and the parsed
 * shape stay in lock-step. NEVER duplicate any of these schemas/types;
 * import from here.
 */

export {
  WIKI_DOCS_DIRNAME,
  WIKI_JOB_RELPATH,
  WIKI_STRUCTURE_FILENAME,
  wikiDir,
  wikiDocsRoot,
  wikiJobPath,
  wikiPagePath,
  wikiStructurePath,
} from './paths.js';
export {
  WIKI_ID_RE,
  WIKI_LIMITS,
  WIKI_SCHEMA_VERSION,
  type WikiCitation,
  type WikiImportance,
  type WikiMode,
  type WikiPage,
  type WikiPageContent,
  type WikiPageState,
  type WikiSection,
  type WikiStructure,
  wikiCitationSchema,
  wikiImportanceSchema,
  wikiModeSchema,
  wikiPageContentSchema,
  wikiPageSchema,
  wikiPageStateSchema,
  wikiSectionSchema,
  wikiStructureSchema,
} from './schema.js';
