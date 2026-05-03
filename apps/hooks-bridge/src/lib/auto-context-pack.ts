import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type DbHandle, sqliteSchema } from '@coodra/contextos-db';
import { createLogger } from '@coodra/contextos-shared';
import { contextPackFilename, defaultContextPacksRoot } from '@coodra/contextos-shared/context-pack-paths';
import { asc, eq } from 'drizzle-orm';

/**
 * `apps/hooks-bridge/src/lib/auto-context-pack.ts` — bridge-side
 * Context Pack auto-save invoked from the SessionEnd handler
 * (decision dec_83ba10c1, 2026-05-02 — Pattern 20). Mirrors the
 * happy-path INSERT from `apps/mcp-server/src/lib/context-pack.ts`
 * minus the embedding column.
 *
 * **Phase 4 Fix H (Slice 3 — 2026-05-03 audit):** the auto-save now
 * ALSO materialises a `~/.contextos/packs/<yyyy-mm-dd>-<runId>.md`
 * file alongside the DB insert. Pre-Fix-H auto-saves landed in DB
 * only — the audit observed 4 packs in DB but only 2 on filesystem
 * (the manually-saved ones). Users opening `~/.contextos/packs/`
 * couldn't see autonomous saves and the closeout grep workflow was
 * broken. Path computation is shared with `lib/context-pack.ts` via
 * `@coodra/contextos-shared/context-pack-paths` so a manual mid-session
 * save and the bridge's autonomous SessionEnd save produce the same
 * filename for the same runId (which the `context_packs.run_id` unique
 * constraint catches as a no-op anyway, but matching filenames keep
 * `ls ~/.contextos/packs/` coherent across both write-paths).
 *
 * The user can still call `contextos__save_context_pack` mid-session
 * to overlay a richer narrative — the existing append-only / idempotent
 * logic surfaces the manual pack back unchanged (ADR-007). Per the
 * audit's §9.1 correction, the auto-pack body already enumerates
 * decisions under a `## Decisions` heading via `buildAutoSummary`;
 * Slice 3 only fixes the FS materialization gap.
 *
 * Idempotency: `context_packs.run_id` is unique. The implementation
 * checks for an existing row before inserting; the unique index is
 * the second-line defence under concurrent retries. Returning the
 * existing row is the documented happy-path no-op.
 *
 * Schedule shape: SessionEnd's response is fire-and-forget allow,
 * so this function is invoked WITHOUT being awaited by the hook
 * response. Errors are logged and swallowed — the hook still
 * returns within p95 < 50ms.
 *
 * v1 scope: SQLite only. Postgres-mode bridges (none ship in v1)
 * would route through the same DB type-discriminator.
 */

const autoContextPackLogger = createLogger('hooks-bridge.auto-context-pack');

const EXCERPT_MAX_CODE_POINTS = 500;

export interface AutoContextPackInput {
  readonly runId: string;
  readonly projectId: string;
  readonly db: DbHandle;
  /**
   * Override the on-disk root for the materialised `.md` file.
   * Defaults to `~/.contextos/packs/` per `defaultContextPacksRoot()`.
   * Tests pass a tmpdir; production uses the default. (Slice 3.)
   */
  readonly contextPacksRoot?: string;
}

interface RunEventRow {
  readonly id: string;
  readonly phase: string;
  readonly toolName: string;
  readonly toolUseId: string;
  readonly toolInput: string;
  readonly outcome: string | null;
  readonly createdAt: Date;
}

interface DecisionRow {
  readonly id: string;
  readonly description: string;
  readonly rationale: string;
  readonly alternatives: string | null;
  readonly createdAt: Date;
}

function computeExcerpt(content: string): string {
  const chars = Array.from(content);
  const sliced = chars.length <= EXCERPT_MAX_CODE_POINTS ? chars : chars.slice(0, EXCERPT_MAX_CODE_POINTS);
  return sliced.join('').replace(/\s+$/u, '');
}

/**
 * Render a structured Markdown summary from the run's events +
 * decisions. v1 ships a deterministic digest — no LLM round-trip.
 * Module 05 (NL Assembly) replaces this with a richer summary
 * generator post-launch.
 */
export function buildAutoSummary(args: {
  readonly runId: string;
  readonly events: ReadonlyArray<RunEventRow>;
  readonly decisions: ReadonlyArray<DecisionRow>;
}): { title: string; content: string } {
  const { runId, events, decisions } = args;
  const filesTouched = new Set<string>();
  let writeCount = 0;
  let readCount = 0;
  let bashCount = 0;
  let denyCount = 0;
  let firstAt: Date | null = null;
  let lastAt: Date | null = null;
  for (const e of events) {
    if (firstAt === null || e.createdAt < firstAt) firstAt = e.createdAt;
    if (lastAt === null || e.createdAt > lastAt) lastAt = e.createdAt;
    if (e.outcome === 'denied') denyCount += 1;
    const tool = e.toolName.toLowerCase();
    if (tool.includes('write') || tool.includes('edit')) writeCount += 1;
    if (tool.includes('read') || tool.includes('grep')) readCount += 1;
    if (tool.includes('bash') || tool.includes('shell')) bashCount += 1;
    try {
      const parsed = JSON.parse(e.toolInput) as Record<string, unknown>;
      const fp = parsed.file_path ?? parsed.filePath ?? parsed.path;
      if (typeof fp === 'string' && fp.length > 0) filesTouched.add(fp);
    } catch {
      // tool_input may be a non-JSON blob; ignore.
    }
  }

  const title = `Auto-saved session ${runId.slice(0, 24)}`;

  const lines: string[] = [];
  lines.push(`# Auto-saved Context Pack`);
  lines.push('');
  lines.push(
    '> Generated by the hooks-bridge SessionEnd handler ' +
      '(decision `dec_83ba10c1`, 2026-05-02 — system-architecture §16 ' +
      'Pattern 20). The agent did not call `save_context_pack` for ' +
      'this run; the bridge wrote a structured digest in its place. ' +
      'Call the MCP tool mid-session to overlay a richer narrative ' +
      'before SessionEnd fires.',
  );
  lines.push('');
  lines.push('## Run summary');
  lines.push('');
  lines.push(`- **runId:** \`${runId}\``);
  if (firstAt !== null) lines.push(`- **first event:** ${firstAt.toISOString()}`);
  if (lastAt !== null) lines.push(`- **last event:** ${lastAt.toISOString()}`);
  lines.push(`- **events recorded:** ${events.length}`);
  lines.push(`- **writes / edits:** ${writeCount}`);
  lines.push(`- **reads / greps:** ${readCount}`);
  lines.push(`- **shell commands:** ${bashCount}`);
  lines.push(`- **policy denies:** ${denyCount}`);
  lines.push('');

  if (filesTouched.size > 0) {
    lines.push('## Files touched');
    lines.push('');
    for (const fp of [...filesTouched].sort()) {
      lines.push(`- \`${fp}\``);
    }
    lines.push('');
  }

  if (decisions.length > 0) {
    lines.push('## Decisions');
    lines.push('');
    for (const d of decisions) {
      lines.push(`### ${d.description}`);
      lines.push('');
      lines.push(d.rationale);
      lines.push('');
      if (d.alternatives !== null && d.alternatives.length > 0) {
        try {
          const alts = JSON.parse(d.alternatives) as unknown;
          if (Array.isArray(alts) && alts.length > 0) {
            lines.push('**Alternatives considered:**');
            for (const alt of alts) {
              if (typeof alt === 'string') lines.push(`- ${alt}`);
            }
            lines.push('');
          }
        } catch {
          // alternatives stored as JSON; older rows may be plain text.
          lines.push('**Alternatives considered:**');
          lines.push(d.alternatives);
          lines.push('');
        }
      }
    }
  }

  return { title, content: lines.join('\n') };
}

export interface SaveAutoContextPackResult {
  readonly id: string;
  readonly runId: string;
  readonly created: boolean;
}

/**
 * Insert (or detect-existing) a context_packs row for `runId`.
 * Returns `{ id, runId, created }`. `created: false` means the
 * row already existed and we returned it untouched.
 *
 * SQLite-only for v1. Caller is responsible for guarding with
 * `db.kind === 'sqlite'`.
 */
export async function saveAutoContextPack(input: AutoContextPackInput): Promise<SaveAutoContextPackResult | null> {
  if (input.db.kind !== 'sqlite') {
    autoContextPackLogger.warn(
      { event: 'auto_context_pack_unsupported_db_kind', kind: input.db.kind },
      'auto-context-pack save skipped: only sqlite is supported in v1',
    );
    return null;
  }

  // Idempotency check (matches mcp-server lib/context-pack.ts:write).
  const existingRows = (await input.db.db
    .select({ id: sqliteSchema.contextPacks.id })
    .from(sqliteSchema.contextPacks)
    .where(eq(sqliteSchema.contextPacks.runId, input.runId))
    .limit(1)) as Array<{ id: string }>;
  if (existingRows[0] !== undefined) {
    return { id: existingRows[0].id, runId: input.runId, created: false };
  }

  // Pull events + decisions for the digest.
  const events = (await input.db.db
    .select({
      id: sqliteSchema.runEvents.id,
      phase: sqliteSchema.runEvents.phase,
      toolName: sqliteSchema.runEvents.toolName,
      toolUseId: sqliteSchema.runEvents.toolUseId,
      toolInput: sqliteSchema.runEvents.toolInput,
      outcome: sqliteSchema.runEvents.outcome,
      createdAt: sqliteSchema.runEvents.createdAt,
    })
    .from(sqliteSchema.runEvents)
    .where(eq(sqliteSchema.runEvents.runId, input.runId))
    .orderBy(asc(sqliteSchema.runEvents.createdAt))) as Array<RunEventRow>;

  const decisions = (await input.db.db
    .select({
      id: sqliteSchema.decisions.id,
      description: sqliteSchema.decisions.description,
      rationale: sqliteSchema.decisions.rationale,
      alternatives: sqliteSchema.decisions.alternatives,
      createdAt: sqliteSchema.decisions.createdAt,
    })
    .from(sqliteSchema.decisions)
    .where(eq(sqliteSchema.decisions.runId, input.runId))
    .orderBy(asc(sqliteSchema.decisions.createdAt))) as Array<DecisionRow>;

  const summary = buildAutoSummary({ runId: input.runId, events, decisions });
  const id = `cp_${randomUUID()}`;
  const contentExcerpt = computeExcerpt(summary.content);

  await input.db.db.insert(sqliteSchema.contextPacks).values({
    id,
    runId: input.runId,
    projectId: input.projectId,
    title: summary.title,
    content: summary.content,
    contentExcerpt,
  });

  // Phase 4 Fix H (Slice 3 — 2026-05-03 audit): materialise to FS so
  // users can see autonomous saves alongside manual ones in
  // `~/.contextos/packs/`. Failure here is non-fatal — DB row already
  // landed, FS is reconcilable. Same posture as the MCP `save_context_pack`
  // tool's store (apps/mcp-server/src/lib/context-pack.ts:303-321).
  // The createdAt used for the filename is `new Date()` rather than the
  // DB-returned `created_at` column because this code path doesn't
  // round-trip the row read; close-enough since the date stamp is
  // YYYY-MM-DD granularity and the filename is informational.
  const contextPacksRoot = input.contextPacksRoot ?? defaultContextPacksRoot();
  let filePath: string | null = null;
  try {
    await mkdir(contextPacksRoot, { recursive: true });
    const filename = contextPackFilename(input.runId, new Date());
    const fullPath = resolve(contextPacksRoot, filename);
    await writeFile(fullPath, summary.content, 'utf8');
    filePath = fullPath;
  } catch (err) {
    autoContextPackLogger.warn(
      {
        event: 'auto_context_pack_fs_write_failed',
        runId: input.runId,
        contextPacksRoot,
        err: err instanceof Error ? err.message : String(err),
      },
      'auto-context-pack: DB insert succeeded but FS materialise failed; row is durable, FS is reconcilable',
    );
  }

  autoContextPackLogger.info(
    {
      event: 'auto_context_pack_saved',
      runId: input.runId,
      contextPackId: id,
      filePath,
      eventCount: events.length,
      decisionCount: decisions.length,
      contentBytes: summary.content.length,
    },
    'SessionEnd auto-saved structured Context Pack',
  );

  return { id, runId: input.runId, created: true };
}
