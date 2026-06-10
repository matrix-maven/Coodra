import 'server-only';

import { getWikiDetail, listWikisDetailed, type WikiListItem } from '@coodra/db';
import { type WikiStructure, wikiStructureSchema } from '@coodra/shared/wiki';

import { createWebDb } from '@/lib/db';

/**
 * `apps/web-v2/lib/queries/wiki.ts` — Module 10 Deep Wiki read surface.
 * Server-only. Wraps the `@coodra/db` read helpers and parses the stored
 * `structureJson` envelope through the canonical
 * `@coodra/shared/wiki` schema so a malformed row degrades gracefully
 * instead of throwing in render.
 */

export type { WikiListItem };

export interface WikiPageView {
  readonly pageId: string;
  readonly state: 'pending' | 'authored';
  readonly contentMarkdown: string;
  readonly citations: ReadonlyArray<{ file: string; startLine?: number; endLine?: number }>;
}

export interface WikiView {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly mode: string;
  readonly projectSlug: string;
  readonly updatedAt: string;
  readonly structure: WikiStructure | null;
  /** pageId → page content/state. */
  readonly pages: Record<string, WikiPageView>;
}

/** List all wikis across the workspace, newest first. */
export async function listWikis(): Promise<WikiListItem[]> {
  return listWikisDetailed(createWebDb());
}

/** Group the wiki list by project for the index page. */
export interface WikiProjectGroup {
  readonly projectSlug: string;
  readonly projectName: string;
  readonly wikis: ReadonlyArray<WikiListItem>;
}

export async function listWikisByProject(): Promise<WikiProjectGroup[]> {
  const all = await listWikis();
  const byProject = new Map<string, WikiListItem[]>();
  for (const w of all) {
    const bucket = byProject.get(w.projectSlug);
    if (bucket) bucket.push(w);
    else byProject.set(w.projectSlug, [w]);
  }
  return [...byProject.entries()].map(([projectSlug, wikis]) => ({
    projectSlug,
    projectName: wikis[0]?.projectName ?? projectSlug,
    wikis,
  }));
}

function parseCitations(raw: string): WikiPageView['citations'] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is { file: string; startLine?: number; endLine?: number } =>
        c && typeof c === 'object' && typeof (c as { file?: unknown }).file === 'string',
    );
  } catch {
    return [];
  }
}

/** Fetch one wiki with its structure + page bodies. null when absent. */
export async function getWiki(wikiId: string): Promise<WikiView | null> {
  const detail = await getWikiDetail(createWebDb(), wikiId);
  if (detail === null) return null;

  const structureParse = wikiStructureSchema.safeParse(JSON.parse(safeJson(detail.structureJson)));
  const structure = structureParse.success ? structureParse.data : null;

  const pages: Record<string, WikiPageView> = {};
  for (const p of detail.pages) {
    pages[p.pageId] = {
      pageId: p.pageId,
      state: p.state === 'authored' ? 'authored' : 'pending',
      contentMarkdown: p.contentMarkdown,
      citations: parseCitations(p.citations),
    };
  }

  return {
    id: detail.id,
    slug: detail.slug,
    title: detail.title,
    description: detail.description,
    mode: detail.mode,
    projectSlug: detail.projectSlug,
    updatedAt: detail.updatedAt.toISOString(),
    structure,
    pages,
  };
}

function safeJson(raw: string): string {
  return raw && raw.trim().length > 0 ? raw : '{}';
}
