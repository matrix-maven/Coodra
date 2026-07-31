import { type DbHandle, listAllDecisions, listContextPacksForProject, lookupProjectBySlug } from '@coodra/db';

/**
 * `lib/wiki/knowledge.ts` — the Deep Wiki's *knowledge* grounding (Phase 4).
 *
 * The code-only grounding (`grounding.ts`) tells the agent what files exist.
 * This tells it what the team already **decided** and what prior sessions
 * already **wrote down**. Without it the wiki re-derives an architecture from
 * source and can contradict a recorded decision — the exact failure Coodra
 * exists to prevent. `decisions` and `context_packs` are Coodra's own durable
 * records (ADR-007, append-only); the wiki is the natural place to surface
 * them as prose.
 *
 * Everything here is bounded and excerpt-only. Full context-pack bodies stay
 * behind `coodra__read_context_pack` / `coodra__search_packs_nl` — inlining
 * dozens of multi-KB recaps would blow the structure pass's budget for the
 * thing it actually needs to read: the code.
 */

/** How many rows of each kind to inline. Enough to orient, not to drown. */
const MAX_DECISIONS = 25;
const MAX_PACKS = 15;
/** Per-field caps — a rambling rationale must not crowd out the next decision. */
const MAX_RATIONALE_CHARS = 400;
const MAX_EXCERPT_CHARS = 300;

export interface KnowledgeDecision {
  readonly description: string;
  readonly rationale: string | null;
  readonly alternatives: ReadonlyArray<string>;
}

export interface KnowledgeContextPack {
  readonly id: string;
  readonly title: string;
  readonly excerpt: string;
}

export interface KnowledgeGrounding {
  readonly projectId: string;
  /** Total decisions for the project (may exceed the inlined sample). */
  readonly decisionCount: number;
  readonly decisions: ReadonlyArray<KnowledgeDecision>;
  /** Total context packs for the project (may exceed the inlined sample). */
  readonly packCount: number;
  readonly contextPacks: ReadonlyArray<KnowledgeContextPack>;
}

function clamp(value: string, max: number): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Parse the `alternatives` column. It is stored as a JSON array of strings but
 * has been written by several generations of callers, so accept a bare string
 * too rather than dropping the field on a shape surprise.
 */
function parseAlternatives(raw: string | null): string[] {
  if (raw === null || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed))
      return parsed.filter((a): a is string => typeof a === 'string').map((a) => clamp(a, 160));
    if (typeof parsed === 'string') return [clamp(parsed, 160)];
    return [];
  } catch {
    return [clamp(raw, 160)];
  }
}

/**
 * Read the project's recorded decisions + context packs for the wiki grounding.
 *
 * Returns null when the project isn't registered in the store — a legitimate
 * state (`coodra wiki build` works before the first `coodra init`), not an
 * error. The caller degrades to a code-only grounding.
 */
export async function assembleKnowledgeGrounding(
  db: DbHandle,
  projectSlug: string,
  opts: { readonly maxDecisions?: number; readonly maxPacks?: number } = {},
): Promise<KnowledgeGrounding | null> {
  const project = await lookupProjectBySlug(db, projectSlug);
  if (project === null) return null;

  const maxDecisions = opts.maxDecisions ?? MAX_DECISIONS;
  const maxPacks = opts.maxPacks ?? MAX_PACKS;

  // Over-fetch by one page so the "N of TOTAL" counts are honest about there
  // being more, without paying for an unbounded count query.
  const decisionRows = await listAllDecisions(db, { projectId: project.id, limit: maxDecisions * 4 });
  const packRows = await listContextPacksForProject(db, { projectId: project.id, limit: maxPacks * 4 });

  const decisions: KnowledgeDecision[] = decisionRows.slice(0, maxDecisions).map((d) => ({
    description: clamp(d.description, 300),
    // `rationale` is NOT NULL in the schema but is empty on some legacy rows.
    rationale: d.rationale.length === 0 ? null : clamp(d.rationale, MAX_RATIONALE_CHARS),
    alternatives: parseAlternatives(d.alternatives),
  }));

  const contextPacks: KnowledgeContextPack[] = packRows.slice(0, maxPacks).map((p) => ({
    id: p.id,
    title: clamp(p.title, 160),
    excerpt: clamp(p.contentExcerpt, MAX_EXCERPT_CHARS),
  }));

  return {
    projectId: project.id,
    decisionCount: decisionRows.length,
    decisions,
    packCount: packRows.length,
    contextPacks,
  };
}
