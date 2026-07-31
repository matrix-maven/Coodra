const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/u;

export interface JiraWorkIntent {
  readonly issueKey: string;
  readonly slug: string;
  readonly withRelated: boolean;
}

function toSlug(issueKey: string): string {
  return issueKey.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function promptText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return '';
  const record = input as Record<string, unknown>;
  for (const key of ['prompt', 'message', 'text', 'value']) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

export function parseJiraWorkIntent(input: unknown): JiraWorkIntent | null {
  const text = promptText(input).trim();
  if (text.length === 0) return null;
  const lower = text.toLowerCase();
  const explicit =
    lower.includes('/coodra-jira-work') ||
    lower.includes('/coodra jira work') ||
    lower.includes('/coodra work') ||
    lower.includes('coodra-jira-work') ||
    lower.includes('coodra jira work');
  const match = JIRA_KEY_RE.exec(text);
  const natural = match !== null && /\b(work|implement|start|import|resume)\b/u.test(lower);
  if (!explicit && !natural) return null;
  if (match?.[1] === undefined) return null;
  const issueKey = match[1].toUpperCase();
  return {
    issueKey,
    slug: toSlug(issueKey),
    withRelated:
      /(?:--with-related|--related|\bwith related\b|\binclude related\b|\bsubtasks?\b|\bsame epic\b|\bblockers?\b)/u.test(
        lower,
      ),
  };
}

export function renderJiraWorkModeContext(intent: JiraWorkIntent): string {
  const relatedLine = intent.withRelated
    ? 'Fetch bounded related Jira work too: parent/epic, subtasks, blockers, blocked-by links, and same-epic tasks that materially affect implementation.'
    : 'Fetch the main Jira issue and direct parent/subtasks when available.';
  return [
    `## Coodra Work Pack mode: ${intent.issueKey}`,
    '',
    `Work Pack slug: \`${intent.slug}\``,
    `Related work requested: \`${intent.withRelated ? 'yes' : 'no'}\``,
    '',
    'Act as a smart developer for this issue-bound session:',
    '',
    '1. Call `coodra__get_run_id` for this project if you do not already have a `runId`.',
    '2. Call `coodra__work_pack_status { runId }` and inspect any existing Work Pack with this slug.',
    `3. Use Atlassian Rovo MCP to read \`${intent.issueKey}\`. ${relatedLine}`,
    '4. Call `coodra__work_pack_upsert` to persist the Jira import/update before editing code.',
    '5. Call `coodra__save_context_pack` with `workPackSlug` set to this slug to create the initial Work Pack-linked Context Pack.',
    '6. Pull relevant local files from `.coodra/work-packs/<slug>/` and continue implementation.',
    '7. Record material decisions with `coodra__record_decision` while working.',
    '8. Finish with a concise user-facing recap; the Coodra SessionEnd hook will update the linked Work Pack with implementation overview and changed files.',
    '',
    'Do not ask the user to run a second import command. You own the import/resume flow from here.',
  ].join('\n');
}
