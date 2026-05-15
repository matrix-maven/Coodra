import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { asc, eq } from 'drizzle-orm';

import type { ToolContext } from '../../framework/tool-context.js';
import {
  READ_CONTEXT_PACK_DEFAULT_DECISIONS_LIMIT,
  READ_CONTEXT_PACK_MAX_CONTENT_BYTES,
  type ReadContextPackInput,
  type ReadContextPackOutput,
} from './schema.js';

/**
 * Handler factory for `coodra__read_context_pack` (M05 §5.2).
 *
 * Hydrates the full pack body + all decisions for the run (capped by
 * `decisionsLimit`). Returns `pack_too_large` when content exceeds 200KB
 * AND the caller didn't pass `excerptOnly: true` — agents retry with
 * `excerptOnly` for a cheap preview.
 */

const handlerLogger = createLogger('mcp-server.tool.read_context_pack');

export interface ReadContextPackHandlerDeps {
  readonly db: DbHandle;
}

interface PackRow {
  readonly id: string;
  readonly runId: string;
  readonly title: string;
  readonly content: string;
  readonly contentExcerpt: string;
  readonly createdAt: Date;
  readonly source: string;
  readonly meta: string | null;
}

interface DecisionRow {
  readonly id: string;
  readonly description: string;
  readonly rationale: string;
  readonly alternatives: string | null;
  readonly context: string | null;
  readonly impact: string | null;
  readonly confidence: string | null;
  readonly reversible: boolean | null;
  readonly createdAt: Date;
}

async function selectPackByPackId(db: DbHandle, packId: string): Promise<PackRow | null> {
  if (db.kind === 'sqlite') {
    const cp = sqliteSchema.contextPacks;
    const rows = (await db.db
      .select({
        id: cp.id,
        runId: cp.runId,
        title: cp.title,
        content: cp.content,
        contentExcerpt: cp.contentExcerpt,
        createdAt: cp.createdAt,
        source: cp.source,
        meta: cp.meta,
      })
      .from(cp)
      .where(eq(cp.id, packId))
      .limit(1)) as PackRow[];
    return rows[0] ?? null;
  }
  const cp = postgresSchema.contextPacks;
  const rows = (await db.db
    .select({
      id: cp.id,
      runId: cp.runId,
      title: cp.title,
      content: cp.content,
      contentExcerpt: cp.contentExcerpt,
      createdAt: cp.createdAt,
      source: cp.source,
      meta: cp.meta,
    })
    .from(cp)
    .where(eq(cp.id, packId))
    .limit(1)) as PackRow[];
  return rows[0] ?? null;
}

async function selectPackByRunId(db: DbHandle, runId: string): Promise<PackRow | null> {
  if (db.kind === 'sqlite') {
    const cp = sqliteSchema.contextPacks;
    const rows = (await db.db
      .select({
        id: cp.id,
        runId: cp.runId,
        title: cp.title,
        content: cp.content,
        contentExcerpt: cp.contentExcerpt,
        createdAt: cp.createdAt,
        source: cp.source,
        meta: cp.meta,
      })
      .from(cp)
      .where(eq(cp.runId, runId))
      .limit(1)) as PackRow[];
    return rows[0] ?? null;
  }
  const cp = postgresSchema.contextPacks;
  const rows = (await db.db
    .select({
      id: cp.id,
      runId: cp.runId,
      title: cp.title,
      content: cp.content,
      contentExcerpt: cp.contentExcerpt,
      createdAt: cp.createdAt,
      source: cp.source,
      meta: cp.meta,
    })
    .from(cp)
    .where(eq(cp.runId, runId))
    .limit(1)) as PackRow[];
  return rows[0] ?? null;
}

async function selectDecisionsForRun(
  db: DbHandle,
  runId: string,
  limit: number,
): Promise<DecisionRow[]> {
  if (db.kind === 'sqlite') {
    const d = sqliteSchema.decisions;
    return (await db.db
      .select({
        id: d.id,
        description: d.description,
        rationale: d.rationale,
        alternatives: d.alternatives,
        context: d.context,
        impact: d.impact,
        confidence: d.confidence,
        reversible: d.reversible,
        createdAt: d.createdAt,
      })
      .from(d)
      .where(eq(d.runId, runId))
      .orderBy(asc(d.createdAt))
      .limit(limit)) as DecisionRow[];
  }
  const d = postgresSchema.decisions;
  return (await db.db
    .select({
      id: d.id,
      description: d.description,
      rationale: d.rationale,
      alternatives: d.alternatives,
      context: d.context,
      impact: d.impact,
      confidence: d.confidence,
      reversible: d.reversible,
      createdAt: d.createdAt,
    })
    .from(d)
    .where(eq(d.runId, runId))
    .orderBy(asc(d.createdAt))
    .limit(limit)) as DecisionRow[];
}

function safeJsonParseArray(raw: string | null): string[] {
  if (raw === null || raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

function safeJsonParseMeta(raw: string | null) {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const m = parsed as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    if (Array.isArray(m.decisionIds)) {
      result.decisionIds = m.decisionIds.filter((v): v is string => typeof v === 'string');
    }
    if (Array.isArray(m.affectedFiles)) {
      result.affectedFiles = m.affectedFiles.filter((v): v is string => typeof v === 'string');
    }
    if (typeof m.testStatus === 'string' && ['pass', 'fail', 'skip', 'unknown'].includes(m.testStatus)) {
      result.testStatus = m.testStatus;
    }
    if (Array.isArray(m.openTodos)) {
      result.openTodos = m.openTodos.filter((v): v is string => typeof v === 'string');
    }
    return result;
  } catch {
    return null;
  }
}

function normalizeConfidence(raw: string | null): 'high' | 'medium' | 'low' | null {
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  return null;
}

function normalizeSource(raw: string): 'agent' | 'bridge_auto' {
  return raw === 'bridge_auto' ? 'bridge_auto' : 'agent';
}

export function createReadContextPackHandler(deps: ReadContextPackHandlerDeps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createReadContextPackHandler requires a deps object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createReadContextPackHandler: deps.db must be a DbHandle');
  }

  return async function readContextPackHandler(
    input: ReadContextPackInput,
    ctx: ToolContext,
  ): Promise<ReadContextPackOutput> {
    // Zod refine guarantees exactly one is set, but we double-check for
    // type narrowing.
    const lookupKey = input.packId !== undefined ? { kind: 'pack' as const, value: input.packId } : input.runId !== undefined ? { kind: 'run' as const, value: input.runId } : null;
    if (lookupKey === null) {
      return {
        ok: false,
        error: 'validation_failed',
        howToFix: 'Provide exactly one of packId or runId.',
      };
    }

    const pack = lookupKey.kind === 'pack'
      ? await selectPackByPackId(deps.db, lookupKey.value)
      : await selectPackByRunId(deps.db, lookupKey.value);

    if (pack === null) {
      handlerLogger.info(
        {
          event: 'read_context_pack_not_found',
          [lookupKey.kind === 'pack' ? 'packId' : 'runId']: lookupKey.value,
          sessionId: ctx.sessionId,
        },
        'read_context_pack: no row matched the supplied id — returning found:false',
      );
      return { ok: true, found: false };
    }

    const excerptOnly = input.excerptOnly === true;
    const contentBytes = Buffer.byteLength(pack.content, 'utf8');
    if (!excerptOnly && contentBytes > READ_CONTEXT_PACK_MAX_CONTENT_BYTES) {
      return {
        ok: false,
        error: 'pack_too_large',
        contentBytes,
        howToFix: `Content is ${contentBytes} bytes (cap ${READ_CONTEXT_PACK_MAX_CONTENT_BYTES}). Retry with excerptOnly: true to get the 500-char preview.`,
      };
    }

    const decisionsLimit = input.decisionsLimit ?? READ_CONTEXT_PACK_DEFAULT_DECISIONS_LIMIT;
    const decisionRows = await selectDecisionsForRun(deps.db, pack.runId, decisionsLimit);

    return {
      ok: true,
      found: true,
      id: pack.id,
      runId: pack.runId,
      title: pack.title,
      content: excerptOnly ? pack.contentExcerpt : pack.content,
      excerptOnly,
      savedAt: pack.createdAt.toISOString(),
      source: normalizeSource(pack.source),
      meta: safeJsonParseMeta(pack.meta),
      decisions: decisionRows.map((r) => ({
        id: r.id,
        description: r.description,
        rationale: r.rationale,
        alternatives: safeJsonParseArray(r.alternatives),
        context: r.context,
        impact: safeJsonParseArray(r.impact),
        confidence: normalizeConfidence(r.confidence),
        reversible: r.reversible,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  };
}
