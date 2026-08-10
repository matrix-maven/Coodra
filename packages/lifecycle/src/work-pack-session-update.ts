import { type DbHandle, sqliteSchema } from '@coodra/db';
import { createLogger, parseRunDiffFilesChanged } from '@coodra/shared';
import { eq } from 'drizzle-orm';

const logger = createLogger('lifecycle.work-pack-session-update');

const SECTION_START = '<!-- coodra:work-pack-session-overview:start -->';
const SECTION_END = '<!-- coodra:work-pack-session-overview:end -->';

function replaceGeneratedSection(existing: string, generated: string): string {
  const block = `${SECTION_START}\n${generated.trim()}\n${SECTION_END}`;
  const start = existing.indexOf(SECTION_START);
  const end = existing.indexOf(SECTION_END);
  if (start >= 0 && end > start) {
    return `${existing.slice(0, start).trimEnd()}\n\n${block}\n${existing.slice(end + SECTION_END.length).trimStart()}`;
  }
  return existing.trim().length > 0 ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`;
}

function renderOverview(args: {
  readonly runId: string;
  readonly contextPackTitle: string | null;
  readonly contextPackExcerpt: string | null;
  readonly filesChangedJson: string | null;
  readonly diffError: string | null;
  readonly generatedAt: Date;
}): string {
  const files = parseRunDiffFilesChanged(args.filesChangedJson ?? '[]');
  const lines: string[] = [];
  lines.push('## Latest implementation overview');
  lines.push('');
  lines.push(`- **runId:** \`${args.runId}\``);
  lines.push(`- **updated:** ${args.generatedAt.toISOString()}`);
  if (args.contextPackTitle !== null && args.contextPackTitle.length > 0) {
    lines.push(`- **context pack:** ${args.contextPackTitle}`);
  }
  if (args.diffError !== null && args.diffError.length > 0) {
    lines.push(`- **diff status:** ${args.diffError}`);
  }
  lines.push('');
  if (args.contextPackExcerpt !== null && args.contextPackExcerpt.length > 0) {
    lines.push('### Session recap');
    lines.push('');
    lines.push(args.contextPackExcerpt);
    lines.push('');
  }
  if (files.length > 0) {
    lines.push('### Files changed');
    lines.push('');
    for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      lines.push(`- \`${file.path}\` - ${file.status} +${file.additions} -${file.deletions}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export async function updateLinkedWorkPackFromRun(args: {
  readonly db: DbHandle;
  readonly runId: string;
  readonly now?: Date;
}): Promise<void> {
  if (args.db.kind !== 'sqlite') return;
  const runRows = await args.db.db
    .select({ workPackId: sqliteSchema.runs.workPackId })
    .from(sqliteSchema.runs)
    .where(eq(sqliteSchema.runs.id, args.runId))
    .limit(1);
  const workPackId = runRows[0]?.workPackId ?? null;
  if (workPackId === null || workPackId.length === 0) return;

  const [packRows, contextRows, diffRows] = await Promise.all([
    args.db.db
      .select({ syncMarkdown: sqliteSchema.workPacks.syncMarkdown })
      .from(sqliteSchema.workPacks)
      .where(eq(sqliteSchema.workPacks.id, workPackId))
      .limit(1),
    args.db.db
      .select({ title: sqliteSchema.contextPacks.title, contentExcerpt: sqliteSchema.contextPacks.contentExcerpt })
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.runId, args.runId))
      .limit(1),
    args.db.db
      .select({ filesChanged: sqliteSchema.runDiffs.filesChanged, error: sqliteSchema.runDiffs.error })
      .from(sqliteSchema.runDiffs)
      .where(eq(sqliteSchema.runDiffs.runId, args.runId))
      .limit(1),
  ]);
  const existingSync = packRows[0]?.syncMarkdown;
  if (existingSync === undefined) return;
  const overview = renderOverview({
    runId: args.runId,
    contextPackTitle: contextRows[0]?.title ?? null,
    contextPackExcerpt: contextRows[0]?.contentExcerpt ?? null,
    filesChangedJson: diffRows[0]?.filesChanged ?? null,
    diffError: diffRows[0]?.error ?? null,
    generatedAt: args.now ?? new Date(),
  });
  await args.db.db
    .update(sqliteSchema.workPacks)
    .set({ syncMarkdown: replaceGeneratedSection(existingSync, overview), updatedAt: args.now ?? new Date() })
    .where(eq(sqliteSchema.workPacks.id, workPackId));
  logger.info(
    { event: 'work_pack_session_overview_updated', runId: args.runId, workPackId },
    'updated linked Work Pack with SessionEnd implementation overview',
  );
}
