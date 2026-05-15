/**
 * `src/tui/command-catalog.ts` — the command catalog the TUI's Commands
 * view renders, **derived from the real `buildProgram()` surface** so it
 * can never go stale, miss a command, or describe one that doesn't
 * exist. Every top-level command and subcommand is walked out of the
 * commander tree; descriptions and argument placeholders come straight
 * from commander itself.
 *
 * Only two things are hand-maintained here, and both are covered by a
 * test that asserts they stay in sync with the program:
 *   - `CATEGORY_OF` — which `/NN` group each top-level command belongs
 *     to (commander has no category metadata).
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
  run: 'runs',
  export: 'runs',
  policy: 'policy',
  project: 'projects',
  pack: 'packs',
  feature: 'features',
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

/** Category render order + display titles. */
const CATEGORIES: ReadonlyArray<{ readonly num: string; readonly title: string; readonly key: string }> = [
  { num: '01', title: 'lifecycle', key: 'lifecycle' },
  { num: '02', title: 'diagnose', key: 'diagnose' },
  { num: '03', title: 'runs & audit', key: 'runs' },
  { num: '04', title: 'policy', key: 'policy' },
  { num: '05', title: 'projects', key: 'projects' },
  { num: '06', title: 'feature packs', key: 'packs' },
  { num: '07', title: 'features', key: 'features' },
  { num: '08', title: 'templates', key: 'templates' },
  { num: '09', title: 'enforcement', key: 'enforcement' },
  { num: '10', title: 'database', key: 'database' },
  { num: '11', title: 'team & auth', key: 'team' },
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
    num: c.num,
    title: c.title,
    commands: byCategory.get(c.key) ?? [],
  })).filter((c) => c.commands.length > 0);

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
