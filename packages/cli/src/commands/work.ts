import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { classifyGeneratedPath, readProjectConfig, recordManifestEntries } from '../lib/project-store/index.js';
import { pc } from '../ui/compat.js';
import { commandTitle, hintLine, terminalWidth } from '../ui/index.js';

/**
 * `coodra work {status,show,import}` — COOD-12 Work Packs.
 *
 * Work Packs are repo-local implementation artifacts under
 * `.coodra/work-packs/<slug>/`. Jira import remains agent-mediated: the
 * active agent reads Atlassian through Rovo MCP, then persists the result via
 * Coodra's work_pack_upsert tool. The CLI creates the local lane and prints
 * the exact handoff recipe; it never stores Atlassian credentials or calls
 * Jira directly.
 */

export interface WorkIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_WORK_IO: WorkIO = {
  writeStdout: (chunk) => {
    process.stdout.write(chunk);
  },
  writeStderr: (chunk) => {
    process.stderr.write(chunk);
  },
  exit: (code) => {
    process.exit(code);
  },
};

export interface WorkBaseOptions {
  readonly cwd?: string;
  readonly json?: boolean;
}

export interface WorkImportOptions extends WorkBaseOptions {
  readonly withRelated?: boolean;
  readonly force?: boolean;
}

interface WorkProject {
  readonly cwd: string;
  readonly projectSlug: string;
}

const WORK_ROOT_REL = '.coodra/work-packs' as const;

function toSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function workRoot(cwd: string): string {
  return join(cwd, WORK_ROOT_REL);
}

function workPackDir(cwd: string, slug: string): string {
  return join(workRoot(cwd), slug);
}

async function resolveProject(options: WorkBaseOptions): Promise<WorkProject> {
  const cwd = options.cwd ?? process.cwd();
  const cfg = await readProjectConfig(cwd);
  return { cwd, projectSlug: cfg?.projectSlug ?? basename(cwd) };
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function listLocalWorkPacks(cwd: string): Array<{ slug: string; files: string[] }> {
  const root = workRoot(cwd);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(root, entry.name);
      return {
        slug: entry.name,
        files: readdirSync(dir, { withFileTypes: true })
          .filter((f) => f.isFile())
          .map((f) => f.name)
          .sort(),
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

function renderImportRecipe(args: {
  readonly issueKey: string;
  readonly slug: string;
  readonly projectSlug: string;
  readonly withRelated: boolean;
}): string {
  const relationLine = args.withRelated
    ? '- Also fetch bounded related work: parent/epic, subtasks, blocking/blocked links, and same-epic tasks that materially affect implementation.'
    : '- Fetch the main issue and its direct parent/subtasks when available.';
  return `# Work Pack import: ${args.issueKey}

Use the active agent's Atlassian MCP tools. Do not ask Coodra for Jira credentials.

1. Call Atlassian Rovo to read ${args.issueKey}.
2. ${relationLine}
3. Summarize requirements, acceptance criteria, risks, implementation notes, and related-work map.
4. Call Coodra MCP:

\`\`\`json
{
  "tool": "work_pack_upsert",
  "arguments": {
    "slug": "${args.slug}",
    "title": "<Jira summary>",
    "packType": "<epic|story|task|bug|subtask|feature|unknown>",
    "status": "<Jira status>",
    "source": {
      "provider": "atlassian",
      "externalKey": "${args.issueKey}",
      "issueType": "<Jira issue type>",
      "status": "<Jira status>",
      "url": "<Jira issue URL>"
    },
    "specMarkdown": "<requirements and acceptance criteria>",
    "implementationMarkdown": "<implementation plan>",
    "syncMarkdown": "<what was imported, related work, and write-back notes>",
    "relationships": [
      {
        "targetExternalKey": "<related Jira key>",
        "relationshipType": "<parent|subtask|blocks|blocked_by|relates_to|same_epic>",
        "syncLevel": "<summary|full>"
      }
    ]
  }
}
\`\`\`

5. Before Jira write-back, ask the user to confirm the exact comment and status transition.`;
}

export async function runWorkStatusCommand(
  options: WorkBaseOptions = {},
  io: WorkIO = DEFAULT_WORK_IO,
): Promise<never> {
  const { cwd, projectSlug } = await resolveProject(options);
  const packs = listLocalWorkPacks(cwd);
  if (options.json === true) {
    io.writeStdout(`${JSON.stringify({ ok: true, projectSlug, root: workRoot(cwd), packs }, null, 2)}\n`);
    return io.exit(EXIT_OK);
  }

  io.writeStdout(`${commandTitle('Work Packs', projectSlug, { width: terminalWidth() })}\n`);
  io.writeStdout(`  ${pc.gray('root')} ${workRoot(cwd)}\n`);
  io.writeStdout(`  ${pc.gray('Jira')} agent-mediated via Atlassian Rovo MCP; Coodra stores no credentials.\n\n`);
  if (packs.length === 0) {
    io.writeStdout(`${pc.dim('—')} no Work Packs yet. Start with ${pc.cyan('coodra work import COOD-12')}.\n`);
  } else {
    for (const pack of packs) {
      io.writeStdout(`  ${pc.green('✓')} ${pack.slug} ${pc.gray(pack.files.join(', ') || 'empty')}\n`);
    }
  }
  return io.exit(EXIT_OK);
}

export async function runWorkShowCommand(
  slugArg: string,
  options: WorkBaseOptions = {},
  io: WorkIO = DEFAULT_WORK_IO,
): Promise<never> {
  const { cwd } = await resolveProject(options);
  const slug = toSlug(slugArg);
  const dir = workPackDir(cwd, slug);
  if (!slug || !existsSync(dir)) {
    const msg = `No Work Pack at ${dir}`;
    if (options.json === true) io.writeStdout(`${JSON.stringify({ ok: false, error: 'not_found', message: msg })}\n`);
    else io.writeStderr(`${pc.red('✗')} ${msg}\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }
  const out = {
    ok: true,
    slug,
    dir,
    meta: readText(join(dir, 'meta.json')),
    spec: readText(join(dir, 'spec.md')),
    implementation: readText(join(dir, 'implementation.md')),
    sync: readText(join(dir, 'sync.md')),
    relationships: readText(join(dir, 'relationships.json')),
  };
  if (options.json === true) {
    io.writeStdout(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    io.writeStdout(`${commandTitle(`Work Pack ${slug}`, dir, { width: terminalWidth() })}\n`);
    io.writeStdout(out.spec ?? pc.dim('No spec.md yet.'));
    io.writeStdout('\n');
  }
  return io.exit(EXIT_OK);
}

export async function runWorkImportCommand(
  issueKey: string,
  options: WorkImportOptions = {},
  io: WorkIO = DEFAULT_WORK_IO,
): Promise<never> {
  const { cwd, projectSlug } = await resolveProject(options);
  const externalKey = issueKey.trim().toUpperCase();
  const slug = toSlug(externalKey);
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(externalKey) || slug.length === 0) {
    const msg = 'work import requires a Jira-style issue key, for example COOD-12.';
    if (options.json === true) io.writeStdout(`${JSON.stringify({ ok: false, error: 'bad_issue_key', message: msg })}\n`);
    else io.writeStderr(`${pc.red('✗')} ${msg}\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  const dir = workPackDir(cwd, slug);
  if (existsSync(dir) && options.force !== true) {
    const msg = `Work Pack ${slug} already exists at ${dir}. Pass --force to refresh the import recipe.`;
    if (options.json === true) io.writeStdout(`${JSON.stringify({ ok: false, error: 'exists', message: msg })}\n`);
    else io.writeStderr(`${pc.yellow('!')} ${msg}\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  mkdirSync(dir, { recursive: true });
  const metaPath = join(dir, 'meta.json');
  const jobPath = join(dir, 'import.md');
  const meta = {
    slug,
    packType: 'unknown',
    source: { provider: 'atlassian', externalKey },
    projectSlug,
    status: 'import-requested',
    createdBy: 'coodra work import',
  };
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  writeFileSync(
    jobPath,
    renderImportRecipe({ issueKey: externalKey, slug, projectSlug, withRelated: options.withRelated === true }),
    'utf8',
  );

  await recordManifestEntries({
    root: cwd,
    projectSlug,
    dryRun: false,
    entries: [
      classifyGeneratedPath(workRoot(cwd), cwd, 'coodra work import'),
      classifyGeneratedPath(dir, cwd, 'coodra work import'),
      classifyGeneratedPath(metaPath, cwd, 'coodra work import'),
      classifyGeneratedPath(jobPath, cwd, 'coodra work import'),
    ],
  });

  if (options.json === true) {
    io.writeStdout(`${JSON.stringify({ ok: true, slug, externalKey, dir, importRecipe: jobPath }, null, 2)}\n`);
  } else {
    io.writeStdout(`${pc.green('✓')} Prepared Work Pack import for ${externalKey} at ${dir}\n`);
    io.writeStdout(hintLine(`  Ask your agent: "Import ${externalKey} into Coodra Work Pack ${slug}"`));
    io.writeStdout('\n');
  }
  return io.exit(EXIT_OK);
}
