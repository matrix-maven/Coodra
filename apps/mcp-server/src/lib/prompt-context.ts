import { type DbHandle } from '@coodra/db';
import { createLogger } from '@coodra/shared';

import type { ToolContext } from '../framework/tool-context.js';
import { createQueryDecisionsByFileHandler } from '../tools/query-decisions-by-file/handler.js';
import type { QueryDecisionsByFileOutput } from '../tools/query-decisions-by-file/schema.js';
import { createQueryDecisionsHandler } from '../tools/query-decisions/handler.js';
import type { DecisionEntry } from '../tools/query-decisions/schema.js';
import { createSearchPacksNlHandler } from '../tools/search-packs-nl/handler.js';
import type { PackResult } from '../tools/search-packs-nl/schema.js';

const logger = createLogger('mcp-server.prompt_context');

const MAX_PROMPT_QUERY_CHARS = 500;
const MAX_QUERY_TERMS = 8;
const MAX_DECISIONS = 4;
const MAX_PACKS = 3;
const MAX_FILE_DECISIONS_PER_FILE = 3;
const MAX_FILES = 3;

const ACK_PROMPTS = new Set([
  'ok',
  'okay',
  'yes',
  'yep',
  'yeah',
  'no',
  'nope',
  'thanks',
  'thank you',
  'continue',
  'go on',
  'sounds good',
]);

const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'and',
  'any',
  'are',
  'because',
  'been',
  'before',
  'being',
  'both',
  'but',
  'can',
  'could',
  'did',
  'does',
  'doing',
  'don',
  'each',
  'few',
  'for',
  'from',
  'guide',
  'have',
  'here',
  'how',
  'implement',
  'into',
  'itself',
  'just',
  'latest',
  'lets',
  'like',
  'make',
  'more',
  'most',
  'need',
  'nor',
  'not',
  'now',
  'off',
  'once',
  'only',
  'other',
  'out',
  'over',
  'own',
  'please',
  'same',
  'she',
  'should',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'thing',
  'this',
  'those',
  'too',
  'very',
  'want',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'why',
  'will',
  'with',
  'work',
  'would',
  'your',
]);

const FILE_PATH_RE =
  /(?:^|\s|["'`(])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.@-]+\.[A-Za-z0-9]+)(?=$|\s|["'`),:;])/g;
const ISSUE_REF_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const WORK_PACK_RE = /\b(?:work[_ -]?pack|pack)\s+([a-z0-9][a-z0-9._-]{1,80})\b/gi;

export interface PromptContextResult {
  readonly additionalContext: string | null;
}

export interface PromptContextDeps {
  readonly db: DbHandle;
}

interface PromptSignals {
  readonly query: string | null;
  readonly filePaths: readonly string[];
  readonly issueRefs: readonly string[];
  readonly workPackSlugs: readonly string[];
}

function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ');
}

function shouldSkipPrompt(prompt: string): boolean {
  const normalized = normalizePrompt(prompt).toLowerCase();
  if (normalized.length < 12) return true;
  return ACK_PROMPTS.has(normalized);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function extractFilePaths(prompt: string): string[] {
  const paths: string[] = [];
  for (const match of prompt.matchAll(FILE_PATH_RE)) {
    const path = match[1];
    if (path !== undefined) paths.push(path);
  }
  return unique(paths).slice(0, MAX_FILES);
}

function extractWorkPackSlugs(prompt: string): string[] {
  const slugs: string[] = [];
  for (const match of prompt.matchAll(WORK_PACK_RE)) {
    const slug = match[1];
    if (slug !== undefined) slugs.push(slug.toLowerCase());
  }
  return unique(slugs);
}

function buildLexicalQuery(
  prompt: string,
  issueRefs: readonly string[],
  workPackSlugs: readonly string[],
): string | null {
  const normalized = normalizePrompt(prompt).slice(0, MAX_PROMPT_QUERY_CHARS);
  const tokens = normalized
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{2,}/g)
    ?.filter((token) => !STOP_WORDS.has(token) && !/^\d+$/.test(token));
  const prioritized = unique([...issueRefs, ...workPackSlugs, ...(tokens ?? [])]).slice(0, MAX_QUERY_TERMS);
  return prioritized.length > 0 ? prioritized.join(' ') : null;
}

function extractPromptSignals(prompt: string): PromptSignals | null {
  if (shouldSkipPrompt(prompt)) return null;
  const issueRefs = unique(prompt.match(ISSUE_REF_RE) ?? []);
  const workPackSlugs = extractWorkPackSlugs(prompt);
  return {
    query: buildLexicalQuery(prompt, issueRefs, workPackSlugs),
    filePaths: extractFilePaths(prompt),
    issueRefs,
    workPackSlugs,
  };
}

function shortText(value: string, max: number): string {
  const normalized = normalizePrompt(value);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}...`;
}

function renderDecision(decision: Pick<DecisionEntry, 'id' | 'description' | 'rationale'>): string {
  return `- Decision ${decision.id}: ${shortText(decision.description, 120)} — ${shortText(decision.rationale, 160)}`;
}

function renderPack(pack: Pick<PackResult, 'id' | 'title' | 'excerpt'>): string {
  const excerpt = shortText(pack.excerpt, 180);
  return `- Context Pack ${pack.id}: ${shortText(pack.title, 100)}${excerpt.length > 0 ? ` — ${excerpt}` : ''}`;
}

function renderFileDecision(filePath: string, result: QueryDecisionsByFileOutput): string[] {
  if (!result.ok || result.decisions.length === 0) return [];
  const lines = [`File impact for ${filePath}:`];
  if (result.blastRadius.graphAvailable && result.blastRadius.fileTargets.length > 1) {
    lines.push(`- Graphify blast radius: ${result.blastRadius.fileTargets.slice(0, 5).join(', ')}`);
  }
  for (const decision of result.decisions.slice(0, MAX_FILE_DECISIONS_PER_FILE)) {
    lines.push(renderDecision(decision));
  }
  return lines;
}

function renderPromptContext(args: {
  readonly decisions: readonly DecisionEntry[];
  readonly packs: readonly PackResult[];
  readonly fileBlocks: readonly string[][];
}): string | null {
  const lines = ['## Prompt-relevant Coodra context'];
  const seenDecisionIds = new Set<string>();
  let hasContent = false;

  for (const block of args.fileBlocks) {
    if (block.length === 0) continue;
    lines.push('', ...block);
    for (const line of block) {
      const match = line.match(/Decision ([^:]+):/);
      if (match?.[1] !== undefined) seenDecisionIds.add(match[1]);
    }
    hasContent = true;
  }

  const newDecisions = args.decisions.filter((decision) => !seenDecisionIds.has(decision.id));
  if (newDecisions.length > 0) {
    lines.push('', 'Relevant active decisions:');
    for (const decision of newDecisions.slice(0, MAX_DECISIONS)) lines.push(renderDecision(decision));
    hasContent = true;
  }

  if (args.packs.length > 0) {
    lines.push('', 'Relevant Context Packs:');
    for (const pack of args.packs.slice(0, MAX_PACKS)) lines.push(renderPack(pack));
    hasContent = true;
  }

  if (!hasContent) return null;
  return lines.join('\n');
}

export async function selectPromptRelevantContext(
  deps: PromptContextDeps,
  args: {
    readonly projectSlug: string;
    readonly prompt: string;
    readonly runId: string | null;
    readonly ctx: ToolContext;
  },
): Promise<PromptContextResult> {
  const signals = extractPromptSignals(args.prompt);
  if (signals === null) return { additionalContext: null };
  if (signals.query === null && signals.filePaths.length === 0) return { additionalContext: null };

  const queryDecisions = createQueryDecisionsHandler({ db: deps.db });
  const searchPacks = createSearchPacksNlHandler({ db: deps.db });
  const queryDecisionsByFile = createQueryDecisionsByFileHandler({ db: deps.db });

  try {
    const [decisionsResult, packsResult, fileResults] = await Promise.all([
      signals.query !== null
        ? queryDecisions(
            {
              projectSlug: args.projectSlug,
              query: signals.query,
              activeOnly: true,
              includeRelated: false,
              limit: MAX_DECISIONS,
            },
            args.ctx,
          )
        : Promise.resolve({ ok: true as const, decisions: [] }),
      signals.query !== null
        ? searchPacks(
            {
              projectSlug: args.projectSlug,
              query: signals.query,
              limit: MAX_PACKS,
              ...(args.runId !== null ? { runId: args.runId } : {}),
            },
            args.ctx,
          )
        : Promise.resolve({ ok: true as const, packs: [] }),
      Promise.all(
        signals.filePaths.map((filePath) =>
          queryDecisionsByFile(
            {
              projectSlug: args.projectSlug,
              filePath,
              activeOnly: true,
              limit: MAX_FILE_DECISIONS_PER_FILE,
            },
            args.ctx,
          ),
        ),
      ),
    ]);

    const fileBlocks = fileResults.map((result, idx) => renderFileDecision(signals.filePaths[idx] ?? '', result));
    return {
      additionalContext: renderPromptContext({
        decisions: decisionsResult.ok ? decisionsResult.decisions : [],
        packs: packsResult.ok ? packsResult.packs : [],
        fileBlocks,
      }),
    };
  } catch (err) {
    logger.warn(
      {
        event: 'prompt_relevant_context_lookup_failed',
        projectSlug: args.projectSlug,
        runId: args.runId,
        err: err instanceof Error ? err.message : String(err),
      },
      'prompt-relevant context lookup failed; UserPromptSubmit proceeding without it',
    );
    return { additionalContext: null };
  }
}
