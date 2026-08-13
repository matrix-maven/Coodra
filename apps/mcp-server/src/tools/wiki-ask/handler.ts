import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { scoreWikiCorpus, type WikiScorableEntry, wikiStructureSchema } from '@coodra/shared/wiki';
import { eq } from 'drizzle-orm';

import type { ToolContext } from '../../framework/tool-context.js';
import { selectWikiById, selectWikiIdByProjectSlug, selectWikiPageContents } from '../../lib/wiki-store.js';
import type { WikiAskInput, WikiAskOutput, WikiAskResultRow } from './schema.js';

/**
 * Handler factory for `coodra__wiki_ask` (COOD-30).
 *
 * Mirrors `packages/cli/src/commands/wiki.ts`'s `loadWikiForAsk` DB-
 * fallback path exactly (per-page title/description parsed out of
 * `wikis.structureJson`, joined in-memory with authored
 * `wikiPages.contentMarkdown`, ranked via the same `scoreWikiCorpus`),
 * but against whichever `DbHandle` this server is connected to — local
 * SQLite in solo mode, shared Postgres in team mode — rather than
 * always the calling machine's own local store. That backend-awareness
 * is the entire point of shipping this as an MCP tool instead of
 * extending the CLI command: see the COOD-30 decision record.
 */

const handlerLogger = createLogger('mcp-server.tool.wiki_ask');

const DEFAULT_LIMIT = 5 as const;

const PROJECT_NOT_FOUND_HOWTO =
  'Register this project via the Web App or run `coodra init` in the project root before retrying.' as const;

export interface WikiAskHandlerDeps {
  readonly db: DbHandle;
}

/** Sanitise an arbitrary string into a wiki slug — mirrors the CLI's `toWikiSlug` (kebab-case, WIKI_ID_RE-compatible). */
function toWikiSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

async function resolveProjectId(db: DbHandle, projectSlug: string): Promise<string | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ id: sqliteSchema.projects.id })
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, projectSlug))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  const rows = await db.db
    .select({ id: postgresSchema.projects.id })
    .from(postgresSchema.projects)
    .where(eq(postgresSchema.projects.slug, projectSlug))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Parse `wikis.structureJson` into a `pageId -> {title, description}`
 * lookup. Malformed/legacy JSON degrades to an empty map (entries then
 * fall back to `pageId` as their title, same as the CLI) rather than
 * failing the whole request — read-time best-effort, matching
 * `loadWikiForAsk`'s handling.
 */
function parsePageMeta(structureJson: string): Map<string, { readonly title: string; readonly description: string }> {
  const pageMeta = new Map<string, { readonly title: string; readonly description: string }>();
  try {
    const structureParse = wikiStructureSchema.safeParse(JSON.parse(structureJson));
    if (structureParse.success) {
      for (const page of structureParse.data.pages) {
        pageMeta.set(page.id, { title: page.title, description: page.description });
      }
    }
  } catch {
    // Malformed/legacy structureJson — degrade to pageId-only metadata below.
  }
  return pageMeta;
}

export function createWikiAskHandler(deps: WikiAskHandlerDeps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createWikiAskHandler requires a deps object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createWikiAskHandler: deps.db must be a DbHandle');
  }

  return async function wikiAskHandler(input: WikiAskInput, ctx: ToolContext): Promise<WikiAskOutput> {
    const projectId = await resolveProjectId(deps.db, input.projectSlug);
    if (projectId === null) {
      handlerLogger.info(
        { event: 'wiki_ask_project_not_found', projectSlug: input.projectSlug, sessionId: ctx.sessionId },
        'wiki_ask: projectSlug does not match a projects row — returning soft-failure',
      );
      return { ok: false, error: 'project_not_found', howToFix: PROJECT_NOT_FOUND_HOWTO };
    }

    const slug = toWikiSlug(input.slug ?? input.projectSlug);
    const wikiId = await selectWikiIdByProjectSlug(deps.db, projectId, slug);
    if (wikiId === null) {
      handlerLogger.info(
        { event: 'wiki_ask_wiki_not_found', projectSlug: input.projectSlug, slug, sessionId: ctx.sessionId },
        'wiki_ask: no wiki for (projectId, slug) — returning soft-failure',
      );
      return {
        ok: false,
        error: 'wiki_not_found',
        howToFix: `No wiki "${slug}" found for this project. Run \`coodra wiki build\` and have the agent author it first.`,
      };
    }

    const wiki = await selectWikiById(deps.db, wikiId);
    const pageMeta = wiki !== null ? parsePageMeta(wiki.structureJson) : new Map();
    const pages = await selectWikiPageContents(deps.db, wikiId);

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

    const limit = input.limit ?? DEFAULT_LIMIT;
    const bodyByPageId = new Map(entries.map((e) => [e.pageId, e.body]));
    const ranked = scoreWikiCorpus(entries, input.question, { limit });
    const results: WikiAskResultRow[] = ranked.map((r) => ({
      pageId: r.pageId,
      title: r.title,
      score: r.score,
      excerpt: r.excerpt,
      contentMarkdown: bodyByPageId.get(r.pageId) ?? '',
    }));

    return { ok: true, wikiId, slug, results };
  };
}
