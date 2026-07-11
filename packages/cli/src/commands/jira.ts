import { homedir } from 'node:os';
import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { detectIDE, type IDE, IDE_DISPLAY, IDE_ORDER, resolveIdeSelection } from '../lib/detect.js';
import {
  type ForeignAtlassianServer,
  findForeignAtlassianServer,
  jiraConfigPath,
  ROVO_MCP_URL,
  readJiraPresence,
  unwireJira,
  wireJira,
} from '../lib/init/jira-wire.js';
import type { WriteOutcome } from '../lib/init/types.js';
import { terminalReadPrompt } from '../lib/terminal-prompt.js';
import { pc } from '../ui/compat.js';
import { commandTitle, hintLine, terminalWidth } from '../ui/index.js';

/**
 * `coodra jira {enable,disable,status}` — wires Atlassian's own remote
 * MCP server ("Rovo") into the agent config files.
 *
 * Module 09, Track 9A (Jira = Direct, ADR-016). Atlassian ships its own
 * Remote MCP server at `https://mcp.atlassian.com/v1/mcp/authv2`
 * (Streamable HTTP, per-user OAuth 2.1) exposing first-class Jira tools —
 * `getJiraIssue`, `searchJiraIssuesUsingJql`, `addCommentToJiraIssue`,
 * `transitionJiraIssue`, … Coodra consumes Jira purely by configuration:
 * this command adds an `atlassian` entry next to the `coodra` entry in
 * each agent's config, and the agent calls Atlassian's tools directly.
 *
 * Coodra builds NO Jira REST client, OAuth flow, ADF converter, webhooks,
 * or `jira_*` tools — all of that is Rovo's. Coodra's leverage is the
 * Run↔issue link (`runs.issueRef`) and on-request write-back, layered on
 * top in later slices (J2 / J3).
 *
 * Per the 2026-05-31 decision, Coodra writes each client's **native**
 * remote entry only — no `npx mcp-remote` shim. The per-IDE wiring is
 * delegated to `lib/init/jira-wire.ts`, which sits on the 9·Core
 * substrate (`external-mcp-merge.ts` for JSON agents,
 * `external-codex-merge.ts` for Codex's TOML).
 */

export interface JiraEnableOptions {
  /** `--ide` — claude | cursor | windsurf | codex | all (comma-separated). Autodetect when omitted. */
  readonly ide?: string;
  /** `--force` — overwrite an existing drifted `atlassian` entry. */
  readonly force?: boolean;
  /** `--dry-run` — report what would change without touching disk. */
  readonly dryRun?: boolean;
  /** `--json` — emit a structured JSON report. */
  readonly json?: boolean;
  /** Override `process.cwd()` for tests. */
  readonly cwd?: string;
  /** Override `$HOME` for tests. */
  readonly userHome?: string;
  /**
   * Override the interactive prompt reader (tests). When provided, the
   * pre-existing-Atlassian confirmation prompt is considered interactive
   * regardless of TTY state.
   */
  readonly readPrompt?: (question: string) => Promise<string>;
}

export interface JiraDisableOptions {
  readonly ide?: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly cwd?: string;
  readonly userHome?: string;
}

export interface JiraStatusOptions {
  readonly json?: boolean;
  readonly cwd?: string;
  readonly userHome?: string;
}

export interface JiraIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_JIRA_IO: JiraIO = {
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

/** Per-IDE outcome of an `enable` / `disable` pass. */
type IdeActionResult =
  | { readonly kind: 'outcome'; readonly ide: IDE; readonly displayName: string; readonly outcome: WriteOutcome }
  | { readonly kind: 'error'; readonly ide: IDE; readonly displayName: string; readonly message: string };

function serializeActionResult(r: IdeActionResult): Record<string, unknown> {
  if (r.kind === 'outcome') {
    return { ide: r.ide, path: r.outcome.path, action: r.outcome.action, notes: r.outcome.notes ?? null };
  }
  return { ide: r.ide, action: 'error', error: r.message };
}

/** A drifted entry that `--force` would overwrite — never-clobber held. */
function isDrift(outcome: WriteOutcome): boolean {
  return outcome.action === 'unchanged' && (outcome.notes ?? '').includes('--force');
}

function renderActionRow(r: IdeActionResult): string {
  const name = r.displayName.padEnd(13);
  if (r.kind === 'error') {
    return `  ${pc.red('✗')} ${name} ${pc.red(r.message)}`;
  }
  const glyph = isDrift(r.outcome) ? pc.yellow('◌') : pc.green('✓');
  const note = r.outcome.notes ?? r.outcome.action;
  return `  ${glyph} ${name} ${pc.gray(`${r.outcome.path} — ${note}`)}`;
}

/**
 * The one prerequisite that must hold for Rovo to answer queries: the
 * per-user OAuth sign-in must be completed inside the assistant. Wiring
 * the entry alone doesn't authorize the connection.
 */
function renderEnableNotice(): string {
  const lines: string[] = [];
  lines.push(pc.bold('  Jira is now wired as a remote MCP server (Atlassian Rovo). One step remains'));
  lines.push(pc.bold('  before the agent can reach it:'));
  lines.push('');
  lines.push(
    `  ${pc.cyan('1.')} Complete the OAuth sign-in. In your assistant, run \`${pc.gray('/mcp')}\` and authorize`,
  );
  lines.push('     the `atlassian` server in the browser — per-user OAuth 2.1, no Coodra app, no API key.');
  lines.push('');
  lines.push(`     ${pc.gray('Endpoint:')} ${pc.gray(ROVO_MCP_URL)} ${pc.gray('(Streamable HTTP)')}`);
  lines.push(`     ${pc.gray('Sign-in is interactive (browser); it does not run headless in CI/cron.')}`);
  lines.push('');
  lines.push(
    hintLine(
      '  Once authorized, ask the agent about tickets — "open PROJ-123", "my open tickets", ' +
        '"post the summary to the ticket" — via Atlassian\'s getJiraIssue / searchJiraIssuesUsingJql / ' +
        "addCommentToJiraIssue. These are Atlassian's tools, not Coodra's.",
    ),
  );
  lines.push(hintLine('  Run `coodra jira status` to check the wiring, `coodra jira disable` to remove it.'));
  return `${lines.join('\n')}\n`;
}

/** Print an IDE-selection / no-IDE failure and exit user-recoverable. */
function failSelection(io: JiraIO, message: string, json: boolean): never {
  if (json) {
    io.writeStdout(`${JSON.stringify({ ok: false, error: 'ide_selection', message }, null, 2)}\n`);
  } else {
    io.writeStderr(`${pc.red('✗')} ${message}\n`);
  }
  return io.exit(EXIT_USER_RECOVERABLE);
}

/**
 * `coodra jira enable` — add the `atlassian` (Rovo) remote MCP entry to
 * each targeted agent config so the agent can call Atlassian's Jira tools.
 * Idempotent; preserves the `coodra` entry and any user edits (a drifted
 * `atlassian` entry is left untouched unless `--force`).
 */
export async function runJiraEnableCommand(
  options: JiraEnableOptions = {},
  io: JiraIO = DEFAULT_JIRA_IO,
): Promise<never> {
  const cwd = options.cwd ?? process.cwd();
  const userHome = options.userHome ?? homedir();
  const dryRun = options.dryRun === true;
  const json = options.json === true;

  const selection = resolveIdeSelection({ flag: options.ide, detected: await detectIDE({ homeDir: userHome }) });
  if (!selection.ok) {
    return failSelection(io, selection.error, json);
  }
  if (selection.ides.length === 0) {
    return failSelection(
      io,
      'No supported IDE detected. Pass --ide claude|cursor|windsurf|codex|all to wire one explicitly.',
      json,
    );
  }

  // Field fix 2026-07-12: detect a PRE-EXISTING Atlassian MCP server wired
  // under any OTHER key (e.g. the user's own `atlassian-mcp-server`, even
  // `disabled: true`) before adding Coodra's `atlassian` entry — blindly
  // adding used to leave two Atlassian servers side by side. Interactive
  // runs ask once; non-interactive runs skip with a notice; `--force`
  // proceeds without asking.
  const skipIdes = new Map<IDE, ForeignAtlassianServer>();
  if (options.force !== true) {
    const foreign: ForeignAtlassianServer[] = [];
    for (const ide of selection.ides) {
      const found = await findForeignAtlassianServer({ ide, cwd, userHome });
      if (found !== null) foreign.push(found);
    }
    if (foreign.length > 0) {
      const interactive = !json && !dryRun && (options.readPrompt !== undefined || process.stdin.isTTY === true);
      let addAnyway = false;
      if (interactive) {
        io.writeStdout(`${pc.yellow('!')} An Atlassian MCP server is already wired:\n`);
        for (const f of foreign) {
          io.writeStdout(`    • ${IDE_DISPLAY[f.ide]}: key '${f.key}' in ${pc.gray(f.configPath)}\n`);
        }
        const readPrompt = options.readPrompt ?? terminalReadPrompt;
        const answer = (await readPrompt(`  Add Coodra's 'atlassian' entry anyway? [y/${pc.cyan('N')}]: `))
          .trim()
          .toLowerCase();
        addAnyway = answer === 'y' || answer === 'yes';
        io.writeStdout('\n');
      }
      if (!addAnyway) {
        for (const f of foreign) skipIdes.set(f.ide, f);
      }
    }
  }

  const results: IdeActionResult[] = [];
  for (const ide of selection.ides) {
    const skipped = skipIdes.get(ide);
    if (skipped !== undefined) {
      results.push({
        kind: 'outcome',
        ide,
        displayName: IDE_DISPLAY[ide],
        outcome: {
          path: skipped.configPath,
          action: 'unchanged',
          notes: `existing Atlassian MCP server (key '${skipped.key}') — skipped; re-run with --force to add Coodra's 'atlassian' entry anyway`,
        },
      });
      continue;
    }
    try {
      const outcome = await wireJira({ ide, cwd, userHome, force: options.force === true, dryRun });
      results.push({ kind: 'outcome', ide, displayName: IDE_DISPLAY[ide], outcome });
    } catch (err) {
      results.push({ kind: 'error', ide, displayName: IDE_DISPLAY[ide], message: (err as Error).message });
    }
  }

  const hadError = results.some((r) => r.kind === 'error');
  const exitCode = hadError ? EXIT_USER_RECOVERABLE : EXIT_OK;

  if (json) {
    io.writeStdout(
      `${JSON.stringify(
        {
          ok: !hadError,
          command: 'jira enable',
          dryRun,
          server: 'atlassian',
          url: ROVO_MCP_URL,
          results: results.map(serializeActionResult),
        },
        null,
        2,
      )}\n`,
    );
    return io.exit(exitCode);
  }

  io.writeStdout(
    `${commandTitle('Jira', dryRun ? 'enable (dry run)' : 'enable', { width: terminalWidth(), indent: 0 })}\n\n`,
  );
  for (const r of results) {
    io.writeStdout(`${renderActionRow(r)}\n`);
  }
  io.writeStdout('\n');
  io.writeStdout(renderEnableNotice());
  return io.exit(exitCode);
}

/**
 * `coodra jira disable` — remove the `atlassian` MCP server entry from
 * each targeted agent config. Idempotent — a missing file or missing
 * entry is a no-op. Every other server entry (incl. `coodra`) is left
 * untouched. The Codex `experimental_use_rmcp_client` flag is left in
 * place (it is global).
 */
export async function runJiraDisableCommand(
  options: JiraDisableOptions = {},
  io: JiraIO = DEFAULT_JIRA_IO,
): Promise<never> {
  const cwd = options.cwd ?? process.cwd();
  const userHome = options.userHome ?? homedir();
  const dryRun = options.dryRun === true;
  const json = options.json === true;

  const selection = resolveIdeSelection({ flag: options.ide, detected: await detectIDE({ homeDir: userHome }) });
  if (!selection.ok) {
    return failSelection(io, selection.error, json);
  }
  if (selection.ides.length === 0) {
    return failSelection(
      io,
      'No supported IDE detected. Pass --ide claude|cursor|windsurf|codex|all to target one explicitly.',
      json,
    );
  }

  const results: IdeActionResult[] = [];
  for (const ide of selection.ides) {
    try {
      const outcome = await unwireJira({ ide, cwd, userHome, dryRun });
      results.push({ kind: 'outcome', ide, displayName: IDE_DISPLAY[ide], outcome });
    } catch (err) {
      results.push({ kind: 'error', ide, displayName: IDE_DISPLAY[ide], message: (err as Error).message });
    }
  }

  const hadError = results.some((r) => r.kind === 'error');
  const exitCode = hadError ? EXIT_USER_RECOVERABLE : EXIT_OK;

  if (json) {
    io.writeStdout(
      `${JSON.stringify(
        {
          ok: !hadError,
          command: 'jira disable',
          dryRun,
          server: 'atlassian',
          results: results.map(serializeActionResult),
        },
        null,
        2,
      )}\n`,
    );
    return io.exit(exitCode);
  }

  io.writeStdout(
    `${commandTitle('Jira', dryRun ? 'disable (dry run)' : 'disable', { width: terminalWidth(), indent: 0 })}\n\n`,
  );
  for (const r of results) {
    io.writeStdout(`${renderActionRow(r)}\n`);
  }
  io.writeStdout('\n');
  io.writeStdout(hintLine('  Removed the `atlassian` MCP entry. Run `coodra jira enable` to wire it back.'));
  io.writeStdout('\n');
  return io.exit(exitCode);
}

interface JiraIdeStatus {
  readonly ide: IDE;
  readonly displayName: string;
  readonly configPath: string;
  readonly exists: boolean;
  readonly wired: boolean;
  readonly unreadable: boolean;
  /** Pre-existing Atlassian server under a non-Coodra key, or null. */
  readonly foreignKey: string | null;
}

function renderStatusRow(s: JiraIdeStatus): string {
  const name = s.displayName.padEnd(13);
  let glyph: string;
  let note: string;
  if (s.unreadable) {
    glyph = pc.red('✗');
    note = `${s.configPath} — unreadable config`;
  } else if (s.wired) {
    glyph = pc.green('✓');
    note = `${s.configPath} — atlassian MCP entry present`;
  } else if (s.foreignKey !== null) {
    // An Atlassian server IS reachable — just not under Coodra's key.
    // Reporting "no atlassian entry" here would mislead the user into
    // enabling a duplicate (field bug 2026-07-12).
    glyph = pc.green('✓');
    note = `${s.configPath} — Atlassian wired under key '${s.foreignKey}' (not Coodra-managed)`;
  } else if (s.exists) {
    glyph = pc.yellow('◌');
    note = `${s.configPath} — no atlassian entry`;
  } else {
    glyph = pc.gray('✗');
    note = `${s.configPath} — config file missing`;
  }
  return `  ${glyph} ${name} ${pc.gray(note)}`;
}

/**
 * `coodra jira status` — read-only probe of whether the `atlassian` MCP
 * entry is present in each agent config (Claude Code / Cursor / Windsurf /
 * Codex). Touches no disk state.
 */
export async function runJiraStatusCommand(
  options: JiraStatusOptions = {},
  io: JiraIO = DEFAULT_JIRA_IO,
): Promise<never> {
  const cwd = options.cwd ?? process.cwd();
  const userHome = options.userHome ?? homedir();

  const statuses: JiraIdeStatus[] = [];
  for (const ide of IDE_ORDER) {
    const presence = await readJiraPresence({ ide, cwd, userHome });
    statuses.push({
      ide,
      displayName: IDE_DISPLAY[ide],
      configPath: jiraConfigPath(ide, cwd, userHome),
      ...presence,
    });
  }

  if (options.json === true) {
    io.writeStdout(`${JSON.stringify({ server: 'atlassian', url: ROVO_MCP_URL, ides: statuses }, null, 2)}\n`);
    return io.exit(EXIT_OK);
  }

  io.writeStdout(`${commandTitle('Jira', 'status', { width: terminalWidth(), indent: 0 })}\n\n`);
  for (const s of statuses) {
    io.writeStdout(`${renderStatusRow(s)}\n`);
  }
  io.writeStdout('\n');
  const anyWired = statuses.some((s) => s.wired);
  const anyForeign = statuses.some((s) => !s.wired && s.foreignKey !== null);
  io.writeStdout(
    hintLine(
      anyWired
        ? '  Run `coodra jira disable` to remove the wiring.'
        : anyForeign
          ? '  An Atlassian MCP server is already wired outside Coodra — the agent can reach Jira as-is. `coodra jira enable` would ask before adding a second entry.'
          : '  Run `coodra jira enable` to wire Atlassian Jira (Rovo) into your agent config.',
    ),
  );
  io.writeStdout('\n');
  return io.exit(EXIT_OK);
}
