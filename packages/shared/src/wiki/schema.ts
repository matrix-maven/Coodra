import { z } from 'zod';

/**
 * @coodra/shared/wiki — Deep Wiki schema (Module 10).
 *
 * Coodra's Deep Wiki is a DeepWiki-style, hierarchical, mind-map
 * explanation of a codebase. The signature design from
 * `AsyncFuncAI/deepwiki-open` and Cognition's DeepWiki is a **two-pass,
 * schema-first** pipeline:
 *
 *   PASS 1 (structure)  — given the file tree + README (+ a code graph),
 *     the model emits a `WikiStructure`: a title/description and a list
 *     of `WikiPage`s, each carrying an importance, the source files it
 *     covers, its parent (so the pages form a hierarchy / mind-map), and
 *     a flag for "this page should include a diagram". Optionally the
 *     pages are grouped under `WikiSection`s ("comprehensive" mode) or
 *     left flat ("concise" mode).
 *
 *   PASS 2 (content)    — for each page, the model authors Markdown
 *     (explanations + code citations + Mermaid diagrams) grounded in the
 *     page's `relevantFiles`.
 *
 * The Coodra adaptation: **the coding agent IS the model** (Claude Code /
 * Codex / Cursor). Coodra ships the schema + the MCP persistence tools +
 * the web render; it runs no LLM, embeddings, or vector store of its own
 * (ADR-012/013/015/016 — "wire the agent, ship records and recipes, not
 * services"). This module is the single source of truth for the shape
 * both passes must conform to. The MCP tools
 * (`wiki_save_structure` / `wiki_save_page` / `wiki_status`), the CLI
 * (`coodra wiki …`), and the web `/wiki` render all import from here so
 * the contract cannot drift.
 *
 * Types are inferred from the Zod schemas (project rule 1.3 — never
 * hand-author a TS interface that duplicates a schema).
 */

/** Wiki structure envelope version. Bump on a breaking shape change. */
export const WIKI_SCHEMA_VERSION = 1 as const;

/** kebab-case identifier: lowercase start, then lowercase/digits/hyphens. */
export const WIKI_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// Size caps are defensive — oversize input becomes a Zod validation
// failure (the MCP registry's generic `invalid_input` envelope), not a
// structured soft-failure. Invalid input is a client bug, not a
// user-recoverable state (mirrors save_context_pack's schema rationale).
const MAX_TITLE = 256 as const;
const MAX_PAGE_DESC = 4_000 as const;
const MAX_WIKI_DESC = 8_000 as const;
const MAX_ID = 128 as const;
const MAX_FILE_PATH = 1_024 as const;
const MAX_FILES_PER_PAGE = 200 as const;
const MAX_RELATED_PAGES = 100 as const;
const MAX_PAGES = 500 as const;
const MAX_SECTIONS = 200 as const;
const MAX_SUBSECTIONS = 100 as const;
const MAX_CONTENT = 1_048_576 as const; // 1 MiB JS string length.
const MAX_CITATIONS = 500 as const;

/** Per-page priority the structure pass assigns. Drives render ordering + color. */
export const wikiImportanceSchema = z.enum(['high', 'medium', 'low']);
export type WikiImportance = z.infer<typeof wikiImportanceSchema>;

/**
 * Wiki shape. `comprehensive` groups pages under nested sections (the
 * full hierarchy / mind-map); `concise` is a flat page list. Mirrors
 * deepwiki-open's two render modes.
 */
export const wikiModeSchema = z.enum(['comprehensive', 'concise']);
export type WikiMode = z.infer<typeof wikiModeSchema>;

/** Authoring lifecycle of a single page row. */
export const wikiPageStateSchema = z.enum(['pending', 'authored']);
export type WikiPageState = z.infer<typeof wikiPageStateSchema>;

const idSchema = z.string().min(1).max(MAX_ID).regex(WIKI_ID_RE, 'must be kebab-case (lowercase, digits, hyphens)');
const filePathSchema = z.string().min(1).max(MAX_FILE_PATH);

/**
 * A source-code citation a page body refers to. `file` is a repo-root-
 * relative POSIX path; the optional line span lets the web render deep-
 * link or show the cited range.
 */
export const wikiCitationSchema = z
  .object({
    file: filePathSchema,
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.startLine !== undefined && c.endLine !== undefined && c.endLine < c.startLine) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'endLine must be >= startLine', path: ['endLine'] });
    }
  });
export type WikiCitation = z.infer<typeof wikiCitationSchema>;

/**
 * Structure-pass metadata for one wiki page. This is the node in the
 * mind-map: `parentId` builds the hierarchy, `importance` ranks it,
 * `relevantFiles` grounds the (later) content pass, `relatedPageIds`
 * cross-links siblings, `wantsDiagram` tells pass 2 to emit Mermaid, and
 * `graphCommunityId` ties the page back to its Graphify Leiden community
 * when the structure was graph-grounded.
 */
export const wikiPageSchema = z
  .object({
    id: idSchema,
    title: z.string().min(1).max(MAX_TITLE),
    description: z.string().min(1).max(MAX_PAGE_DESC),
    importance: wikiImportanceSchema,
    /** Parent page id (hierarchy) or null for a top-level page. */
    parentId: idSchema.nullable(),
    /** Repo-root-relative source files this page explains. */
    relevantFiles: z.array(filePathSchema).max(MAX_FILES_PER_PAGE).default([]),
    /** Other page ids this page links to (cross-references). */
    relatedPageIds: z.array(idSchema).max(MAX_RELATED_PAGES).default([]),
    /** Pass-1 hint: pass-2 should include a Mermaid diagram on this page. */
    wantsDiagram: z.boolean().default(false),
    /** Optional Graphify Leiden community id this page maps to. */
    graphCommunityId: z.number().int().nonnegative().optional(),
  })
  .strict();
export type WikiPage = z.infer<typeof wikiPageSchema>;

/**
 * A grouping of pages (and nested sections) for `comprehensive` mode.
 * Sections carry no content of their own — they are the branches of the
 * mind-map; pages are the leaves.
 */
export const wikiSectionSchema = z
  .object({
    id: idSchema,
    title: z.string().min(1).max(MAX_TITLE),
    pageIds: z.array(idSchema).max(MAX_PAGES).default([]),
    subsectionIds: z.array(idSchema).max(MAX_SUBSECTIONS).default([]),
  })
  .strict();
export type WikiSection = z.infer<typeof wikiSectionSchema>;

/**
 * The full table-of-contents envelope produced by the structure pass and
 * persisted as `wikis.structure_json`. Referential integrity is enforced
 * here in one place so a malformed plan is rejected at the MCP boundary
 * (not discovered later when the web tries to render a dangling parentId).
 */
export const wikiStructureSchema = z
  .object({
    schemaVersion: z.literal(WIKI_SCHEMA_VERSION),
    title: z.string().min(1).max(MAX_TITLE),
    description: z.string().min(1).max(MAX_WIKI_DESC),
    mode: wikiModeSchema,
    sections: z.array(wikiSectionSchema).max(MAX_SECTIONS).default([]),
    pages: z.array(wikiPageSchema).min(1).max(MAX_PAGES),
  })
  .strict()
  .superRefine((structure, ctx) => {
    const pageIds = new Set<string>();
    for (const [i, page] of structure.pages.entries()) {
      if (pageIds.has(page.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate page id "${page.id}"`,
          path: ['pages', i, 'id'],
        });
      }
      pageIds.add(page.id);
    }

    const sectionIds = new Set<string>();
    for (const [i, section] of structure.sections.entries()) {
      if (sectionIds.has(section.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate section id "${section.id}"`,
          path: ['sections', i, 'id'],
        });
      }
      sectionIds.add(section.id);
    }

    // Page-level referential integrity.
    for (const [i, page] of structure.pages.entries()) {
      if (page.parentId !== null && !pageIds.has(page.parentId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `parentId "${page.parentId}" does not match any page id`,
          path: ['pages', i, 'parentId'],
        });
      }
      if (page.parentId === page.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `page "${page.id}" cannot be its own parent`,
          path: ['pages', i, 'parentId'],
        });
      }
      for (const [j, related] of page.relatedPageIds.entries()) {
        if (!pageIds.has(related)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `relatedPageIds["${related}"] does not match any page id`,
            path: ['pages', i, 'relatedPageIds', j],
          });
        }
      }
    }

    // Section-level referential integrity.
    for (const [i, section] of structure.sections.entries()) {
      for (const [j, pageId] of section.pageIds.entries()) {
        if (!pageIds.has(pageId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `section pageIds["${pageId}"] does not match any page id`,
            path: ['sections', i, 'pageIds', j],
          });
        }
      }
      for (const [j, subId] of section.subsectionIds.entries()) {
        if (!sectionIds.has(subId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `section subsectionIds["${subId}"] does not match any section id`,
            path: ['sections', i, 'subsectionIds', j],
          });
        }
        if (subId === section.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `section "${section.id}" cannot be its own subsection`,
            path: ['sections', i, 'subsectionIds', j],
          });
        }
      }
    }
  });
export type WikiStructure = z.infer<typeof wikiStructureSchema>;

/**
 * Content-pass payload for one page: the Markdown body (which may embed
 * ```mermaid fenced blocks) plus optional structured citations the web
 * render can surface as "sources".
 */
export const wikiPageContentSchema = z
  .object({
    contentMarkdown: z.string().min(1).max(MAX_CONTENT),
    citations: z.array(wikiCitationSchema).max(MAX_CITATIONS).default([]),
  })
  .strict();
export type WikiPageContent = z.infer<typeof wikiPageContentSchema>;

/**
 * Caps re-exported so the MCP tool schemas and the CLI can reference the
 * exact same bounds without re-deriving them.
 */
export const WIKI_LIMITS = {
  MAX_TITLE,
  MAX_PAGE_DESC,
  MAX_WIKI_DESC,
  MAX_ID,
  MAX_FILE_PATH,
  MAX_FILES_PER_PAGE,
  MAX_RELATED_PAGES,
  MAX_PAGES,
  MAX_SECTIONS,
  MAX_SUBSECTIONS,
  MAX_CONTENT,
  MAX_CITATIONS,
} as const;
