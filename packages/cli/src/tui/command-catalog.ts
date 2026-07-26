/**
 * `src/tui/command-catalog.ts` — the command catalog the TUI's Commands
 * view renders, **derived from the real `buildProgram()` surface** so it
 * can never go stale, miss a command, or describe one that doesn't
 * exist. Every top-level command and subcommand is walked out of the
 * commander tree; descriptions and argument placeholders come straight
 * from commander itself.
 *
 * Only three things are hand-maintained here, and the first is covered
 * by a test that asserts it stays in sync with the program:
 *   - `CATEGORY_OF` — which group each top-level command belongs to
 *     (commander has no category metadata). `tui.test.tsx` asserts its
 *     key set EQUALS the program's top-level command set — a missing
 *     entry here made the Terminal view reject a command the catalog
 *     itself listed (found in the 2026-07-24 QA sweep).
 *   - `CATEGORIES` — group order + titles (`/NN` numbers are derived).
 *   - `INTERACTIVE` — the handful of commands that need their own
 *     terminal (a readline prompt or a browser sign-in). The TUI cannot
 *     run those in-process because Ink owns stdin in raw mode; a prompt
 *     would hang. Every other command runs in-process from the Terminal
 *     view — including mutating ones (you typed the full command).
 */

import { buildProgram } from '../program.js';

export interface CatalogCommand {
  /** Stable id, e.g. `policy-list`. */
  readonly id: string;
  /** Command line without argument placeholders — `coodra policy list`. */
  readonly command: string;
  /** Command line with argument placeholders — `coodra export <runId>` — inserted into the prompt on select. */
  readonly display: string;
  /** argv for the in-process runner — `['policy', 'list']`. */
  readonly argv: readonly string[];
  /** Short description, taken from the command's own commander description. */
  readonly description: string;
  /**
   * True when the command needs its own terminal — an interactive
   * readline prompt or a browser handoff. The TUI surfaces "run it in
   * your own terminal" for these; everything else runs in-process.
   */
  readonly interactive: boolean;
}

export interface CatalogCategory {
  readonly num: string;
  readonly title: string;
  readonly commands: readonly CatalogCommand[];
}

/**
 * Top-level command name → category key. Every top-level command in
 * `buildProgram()` must appear here (asserted by `tui.test.tsx`).
 */
const CATEGORY_OF: Readonly<Record<string, string>> = {
  init: 'lifecycle',
  start: 'lifecycle',
  stop: 'lifecycle',
  upgrade: 'lifecycle',
  uninstall: 'lifecycle',
  ui: 'lifecycle',
  status: 'diagnose',
  doctor: 'diagnose',
  logs: 'diagnose',
  metrics: 'diagnose',
  agents: 'agents',
  agent: 'agents',
  run: 'runs',
  export: 'runs',
  policy: 'policy',
  project: 'projects',
  files: 'projects',
  pack: 'packs',
  skill: 'skills',
  wiki: 'wiki',
  graphify: 'integrations',
  jira: 'integrations',
  template: 'templates',
  pause: 'enforcement',
  resume: 'enforcement',
  db: 'database',
  login: 'team',
  logout: 'team',
  invite: 'team',
  org: 'team',
  team: 'team',
  'cloud-migrate': 'team',
};

/**
 * Category render order + display titles. `/NN` numbers are derived from the
 * position here — never hand-numbered, so inserting a category can't produce
 * a gap or duplicate.
 */
const CATEGORIES: ReadonlyArray<{ readonly title: string; readonly key: string }> = [
  { title: 'lifecycle', key: 'lifecycle' },
  { title: 'diagnose', key: 'diagnose' },
  { title: 'agents', key: 'agents' },
  { title: 'runs & audit', key: 'runs' },
  { title: 'policy', key: 'policy' },
  { title: 'projects', key: 'projects' },
  { title: 'feature packs', key: 'packs' },
  { title: 'skills', key: 'skills' },
  { title: 'deep wiki', key: 'wiki' },
  { title: 'integrations', key: 'integrations' },
  { title: 'templates', key: 'templates' },
  { title: 'enforcement', key: 'enforcement' },
  { title: 'database', key: 'database' },
  { title: 'team & auth', key: 'team' },
];

/**
 * Commands that need their own terminal — keyed by the full
 * `coodra …` string. A readline prompt (`init` on a team machine,
 * `db restore`'s confirmation, the `team` bootstrap/migration flows) or
 * a browser sign-in (`login`, `org switch`, `team login`/`join`) cannot
 * share Ink's raw-mode stdin, so the TUI surfaces "run it in your own
 * terminal" instead of running these in-process.
 */
const INTERACTIVE: ReadonlySet<string> = new Set([
  'coodra init',
  'coodra login',
  'coodra org switch',
  'coodra db restore',
  'coodra team init',
  'coodra team setup',
  'coodra team join',
  'coodra team install',
  'coodra team migrate',
  'coodra team leave',
  'coodra team login',
  // These three gate their prompts on `process.stdin.isTTY` — which is TRUE
  // under Ink's raw-mode stdin, so running them in-process would fight Ink
  // for input and hang. `files clean` prompts per ask-tier file,
  // `graphify enable` prompts for legacy-layout migration + the install
  // offer, `jira enable` prompts when a foreign Atlassian entry exists.
  'coodra files clean',
  'coodra graphify enable',
  'coodra jira enable',
]);

/** First sentence of a commander description, capped — commander descriptions run long. */
function shortenDescription(desc: string, max = 64): string {
  const firstSentence = desc.split('. ')[0]?.trim() ?? desc;
  if (firstSentence.length <= max) return firstSentence;
  return `${firstSentence.slice(0, max - 1).trimEnd()}…`;
}

/** ` <required>` / ` [optional]` placeholders for a command's positional arguments. */
function argPlaceholders(cmd: unknown): string {
  const args =
    (cmd as { registeredArguments?: ReadonlyArray<{ name(): string; required: boolean }> }).registeredArguments ?? [];
  return args.map((a) => (a.required ? ` <${a.name()}>` : ` [${a.name()}]`)).join('');
}

function buildCatalog(): { readonly categories: CatalogCategory[]; readonly flat: CatalogCommand[] } {
  const program = buildProgram();
  const byCategory = new Map<string, CatalogCommand[]>();
  const flat: CatalogCommand[] = [];

  const push = (cmd: CatalogCommand, categoryKey: string): void => {
    flat.push(cmd);
    const list = byCategory.get(categoryKey);
    if (list === undefined) byCategory.set(categoryKey, [cmd]);
    else list.push(cmd);
  };

  for (const top of program.commands) {
    const name = top.name();
    if (name === 'help') continue; // commander's implicit help command
    const categoryKey = CATEGORY_OF[name] ?? 'lifecycle';

    if (top.commands.length > 0) {
      for (const sub of top.commands) {
        const command = `coodra ${name} ${sub.name()}`;
        push(
          {
            id: `${name}-${sub.name()}`,
            command,
            display: command + argPlaceholders(sub),
            argv: [name, sub.name()],
            description: shortenDescription(sub.description()),
            interactive: INTERACTIVE.has(command),
          },
          categoryKey,
        );
      }
    } else {
      const command = `coodra ${name}`;
      push(
        {
          id: name,
          command,
          display: command + argPlaceholders(top),
          argv: [name],
          description: shortenDescription(top.description()),
          interactive: INTERACTIVE.has(command),
        },
        categoryKey,
      );
    }
  }

  const categories = CATEGORIES.map((c) => ({
    title: c.title,
    commands: byCategory.get(c.key) ?? [],
  }))
    .filter((c) => c.commands.length > 0)
    .map((c, i) => ({ num: String(i + 1).padStart(2, '0'), title: c.title, commands: c.commands }));

  return { categories, flat };
}

const BUILT = buildCatalog();

/** The catalog, grouped by intent into `/NN` categories. */
export const COMMAND_CATALOG: readonly CatalogCategory[] = BUILT.categories;

/** Flat list of every catalog command, in category order. */
export const ALL_CATALOG_COMMANDS: readonly CatalogCommand[] = BUILT.flat;

/** Total command count. */
export const CATALOG_COMMAND_COUNT = ALL_CATALOG_COMMANDS.length;

/** Parse a typed prompt string into argv — strips the optional `coodra ` prefix, collapses whitespace. */
export function parseCommandInput(input: string): string[] {
  const trimmed = input.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return [];
  const withoutPrefix = trimmed.startsWith('coodra ') ? trimmed.slice('coodra '.length) : trimmed;
  return withoutPrefix.length === 0 ? [] : withoutPrefix.split(' ');
}

/** Resolve typed input to its catalog command (longest argv-prefix match), or `null`. */
export function resolveCatalogCommand(input: string): CatalogCommand | null {
  const argv = parseCommandInput(input);
  if (argv.length === 0) return null;
  let best: CatalogCommand | null = null;
  for (const cmd of ALL_CATALOG_COMMANDS) {
    if (cmd.argv.length <= argv.length && cmd.argv.every((seg, i) => seg === argv[i])) {
      if (best === null || cmd.argv.length > best.argv.length) best = cmd;
    }
  }
  return best;
}

/**
 * Whether `argv` names a command that needs its own terminal. Checks
 * the 2-token form (`team init`) then the 1-token form (`init`).
 */
export function isInteractiveCommand(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  if (argv.length >= 2 && INTERACTIVE.has(`coodra ${argv[0]} ${argv[1]}`)) return true;
  return INTERACTIVE.has(`coodra ${argv[0]}`);
}

/** Whether `argv[0]` is a real top-level `coodra` command. */
export function isKnownCommand(argv: readonly string[]): boolean {
  const first = argv[0];
  return first !== undefined && Object.hasOwn(CATEGORY_OF, first);
}

/**
 * Returns the first argv token that's still a literal placeholder
 * (`<name>` for required or `[name]` for optional positionals), or
 * `null` if every token is a real value. Used by the Terminal view to
 * refuse-to-run when the user pastes or hand-types a `--help`-style
 * example without filling in the placeholder.
 */
export function findPlaceholderToken(argv: readonly string[]): string | null {
  for (const token of argv) {
    if (/^<.+>$/.test(token) || /^\[.+\]$/.test(token)) return token;
  }
  return null;
}
