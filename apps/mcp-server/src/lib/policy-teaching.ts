import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/db';
import { and, desc, eq, inArray } from 'drizzle-orm';

/**
 * `apps/mcp-server/src/lib/policy-teaching` — COOD-88.
 *
 * A third context-delivery model, alongside push-at-SessionStart and
 * pull-on-demand: **just-in-time teaching through the feedback loop**.
 *
 * OpenAI's harness team writes their custom lint messages specifically
 * "to inject remediation instructions into agent context". Guidance
 * arrives at the exact moment of the violation, scoped to it — so it is
 * never stale, never wasted, and costs nothing at session start.
 *
 * Coodra already owns this channel and has been using it for almost
 * nothing: `permissionDecisionReason` carries opaque labels like
 * `rule_matched`. This attaches the decision that motivated the rule,
 * so a denial teaches instead of merely refusing.
 *
 * ## Deliberately supplementary
 *
 * This is NOT a replacement for push or pull, and the ticket is
 * explicit about why: permission events fire only on policy-gated
 * actions. A great many reads and retrievals never reach a permission
 * check at all, so this channel covers a narrow slice and cannot carry
 * general project grounding. It complements the manifest; it does not
 * substitute for it.
 *
 * ## Where the "motivating decision" comes from
 *
 * There is no rule → decision foreign key, and inventing one would mean
 * a schema change plus a new authoring burden on whoever writes rules.
 * Instead this reuses COOD-58's `decision_edges`: when a gated tool call
 * touches a path, the active decisions that already declare they affect
 * that path ARE the motivating context. No new contract, and it
 * degrades to silence when nothing matches.
 *
 * Only `activeOnly` decisions are surfaced — a superseded decision
 * teaching a denial would be actively misleading, which is worse than
 * the opaque label it replaced.
 */

/** Hook reason strings are bounded; agents pay for every byte of this. */
const MAX_REASON_BYTES = 600;
const MAX_DECISIONS = 2;

export interface TeachingDecision {
  readonly id: string;
  readonly description: string;
  readonly rationale: string;
}

/**
 * Trim to a sentence boundary rather than mid-word.
 *
 * A reason cut at "secrets must go through the local key" reads like a
 * bug and invites the agent to guess the rest. Better to end early and
 * cleanly, then point at the id for the full text.
 */
function summarise(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  if (lastStop > max * 0.5) return cut.slice(0, lastStop + 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : max)}…`;
}

/** Best-effort file path from a tool input, matching the policy engine's own view. */
export function pathFromToolInput(toolInput: unknown): string | null {
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) return null;
  const record = toolInput as Record<string, unknown>;
  for (const key of ['file_path', 'filePath', 'path', 'notebook_path']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * Active decisions declaring they affect this path.
 *
 * Returns [] on any failure — a teaching lookup must never turn a
 * working denial into an error. The denial is the load-bearing part;
 * the lesson is a bonus.
 */
export async function findMotivatingDecisions(
  db: DbHandle,
  projectId: string,
  filePath: string,
): Promise<ReadonlyArray<TeachingDecision>> {
  try {
    // Match on the path as recorded, plus its basename-suffix form, so
    // an absolute tool path still meets a repo-relative decision edge.
    const normalized = filePath.replaceAll('\\', '/');
    const candidates = [normalized, normalized.replace(/^.*?\/(?=(?:apps|packages|src|docs)\/)/, '')];

    if (db.kind === 'sqlite') {
      const edges = sqliteSchema.decisionEdges;
      const edgeRows = await db.db
        .select({ decisionId: edges.fromDecisionId })
        .from(edges)
        .where(and(eq(edges.targetType, 'file'), inArray(edges.targetId, candidates)))
        .limit(MAX_DECISIONS * 3);
      const ids = [...new Set(edgeRows.map((r) => r.decisionId))];
      if (ids.length === 0) return [];
      const d = sqliteSchema.decisions;
      const rows = await db.db
        .select({ id: d.id, description: d.description, rationale: d.rationale })
        .from(d)
        .where(and(inArray(d.id, ids), eq(d.projectId, projectId)))
        .orderBy(desc(d.createdAt))
        .limit(MAX_DECISIONS);
      return rows;
    }

    const edges = postgresSchema.decisionEdges;
    const edgeRows = await db.db
      .select({ decisionId: edges.fromDecisionId })
      .from(edges)
      .where(and(eq(edges.targetType, 'file'), inArray(edges.targetId, candidates)))
      .limit(MAX_DECISIONS * 3);
    const ids = [...new Set(edgeRows.map((r) => r.decisionId))];
    if (ids.length === 0) return [];
    const d = postgresSchema.decisions;
    const rows = await db.db
      .select({ id: d.id, description: d.description, rationale: d.rationale })
      .from(d)
      .where(and(inArray(d.id, ids), eq(d.projectId, projectId)))
      .orderBy(desc(d.createdAt))
      .limit(MAX_DECISIONS);
    return rows;
  } catch {
    return [];
  }
}

/**
 * Compose the taught reason.
 *
 * Returns the original untouched when there is nothing to teach — a
 * denial with no motivating decision keeps exactly the behaviour it had
 * before this feature, rather than gaining empty scaffolding like
 * "(no related decisions found)" that costs bytes and says nothing.
 */
export function composeTeachingReason(
  baseReason: string,
  decisions: ReadonlyArray<TeachingDecision>,
): { readonly reason: string; readonly taughtDecisionIds: ReadonlyArray<string> } {
  if (decisions.length === 0) return { reason: baseReason, taughtDecisionIds: [] };

  // Budget must account for the scaffolding, not just the prose: the
  // header, the ` | ` separators, and each `<id>: ` prefix. An earlier
  // version budgeted only the text and overran by 22 bytes.
  const header = ' · prior decision — ';
  const separator = ' | ';
  const scaffolding =
    header.length + separator.length * (decisions.length - 1) + decisions.reduce((sum, d) => sum + d.id.length + 2, 0);
  const budget = MAX_REASON_BYTES - baseReason.length - scaffolding;
  if (budget <= 40) return { reason: baseReason, taughtDecisionIds: [] };

  const perDecision = Math.floor(budget / decisions.length);
  const parts: string[] = [];
  const taught: string[] = [];
  for (const decision of decisions) {
    const text = summarise(`${decision.description} — ${decision.rationale}`, perDecision);
    parts.push(`${decision.id}: ${text}`);
    taught.push(decision.id);
  }
  const reason = `${baseReason}${header}${parts.join(separator)}`;
  // Defensive: `summarise` may keep a sentence slightly under its own
  // cap, but never over — so this should not fire. If a future edit
  // makes it possible, drop the teaching rather than overrun the budget
  // and risk the host truncating mid-string.
  if (reason.length > MAX_REASON_BYTES) return { reason: baseReason, taughtDecisionIds: [] };
  return { reason, taughtDecisionIds: taught };
}
