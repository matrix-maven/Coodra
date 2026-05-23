import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { detectIDE, type IDE, IDE_ORDER, resolveIdeSelection } from '../lib/detect.js';
import { GRAPHIFY_SEED_FEATURE_SLUG, seedGraphifySeedPacksFeature } from '../lib/init/graphify-feature.js';
import {
  DEFAULT_GRAPHIFY_GRAPH_PATH,
  DEFAULT_GRAPHIFY_PYTHON,
  graphifyConfigPath,
  readGraphifyPresence,
  unwireGraphify,
  wireGraphify,
} from '../lib/init/graphify-wire.js';
import type { WriteOutcome } from '../lib/init/types.js';
import { pc } from '../ui/compat.js';
import { commandTitle, hintLine, terminalWidth } from '../ui/index.js';

/**
 * `coodra graphify {enable,disable,status}` — wires Graphify's own
 * stdio MCP server into the agent config files.
 *
 * Module 09, Track 9B (ADR-010, Option C). Graphify
 * (`safishamsi/graphify`, PyPI `graphifyy`) ships its own MCP server —
 * `python -m graphify.serve graphify-out/graph.json` — exposing
 * `query_graph` / `get_node` / `get_neighbors` / `shortest_path` and
 * friends. Coodra does NOT wrap it; this command simply adds a
 * `graphify` entry next to the `coodra` entry in each agent's config.
 *
 * The per-IDE wiring is delegated to `lib/init/graphify-wire.ts`, which
 * sits on the 9·Core substrate: `external-mcp-merge.ts` for the JSON
 * agents (Claude Code / Cursor / Windsurf) and `external-codex-merge.ts`
 * for Codex's TOML config. All four agents get a real, idempotent,
 * never-clobber write.
 *
 * `enable` also seeds the bundled `graphify-seed-packs` Feature — the
 * skill that drives the Graphify→Coodra fusion (`--no-feature` skips it).
 */

const IDE_DISPLAY: Record<IDE, string> = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  codex: 'Codex',
};

export interface GraphifyEnableOptions {
  /** `--ide` — claude | cursor | windsurf | codex | all (comma-separated). Autodetect when omitted. */
  readonly ide?: string;
  /** `--python` — interpreter for `-m graphify.serve` (default: python3). */
  readonly python?: string;
  /** `--graph` — path to `graphify-out/graph.json` (default: graphify-out/graph.json). */
  readonly graph?: string;
  /** `--force` — overwrite an existing drifted `graphify` entry. */
  readonly force?: boolean;
  /** `--no-feature` — skip seeding the `graphify-seed-packs` Feature recipe. */
  readonly feature?: boolean;
  /** `--dry-run` — report what would change without touching disk. */
  readonly dryRun?: boolean;
  /** `--json` — emit a structured JSON report. */
  readonly json?: boolean;
  /** Override `process.cwd()` for tests. */
  readonly cwd?: string;
  /** Override `$HOME` for tests. */
  readonly userHome?: string;
}

export interface GraphifyDisableOptions {
  readonly ide?: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly cwd?: string;
  readonly userHome?: string;
}

export interface GraphifyStatusOptions {
  readonly json?: boolean;
  readonly cwd?: string;
  readonly userHome?: string;
}

export interface GraphifyIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_GRAPHIFY_IO: GraphifyIO = {
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

/** Outcome of the `graphify-seed-packs` Feature seed step. */
type FeatureResult =
  | { readonly kind: 'outcome'; readonly outcome: WriteOutcome }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'skipped' };

function serializeActionResult(r: IdeActionResult): Record<string, unknown> {
  if (r.kind === 'outcome') {
    return { ide: r.ide, path: r.outcome.path, action: r.outcome.action, notes: r.outcome.notes ?? null };
  }
  return { ide: r.ide, action: 'error', error: r.message };
}

function serializeFeatureResult(r: FeatureResult): Record<string, unknown> | null {
  if (r.kind === 'skipped') return null;
  if (r.kind === 'error') return { slug: GRAPHIFY_SEED_FEATURE_SLUG, action: 'error', error: r.message };
  return {
    slug: GRAPHIFY_SEED_FEATURE_SLUG,
    path: r.outcome.path,
    action: r.outcome.action,
    notes: r.outcome.notes ?? null,
  };
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

function renderFeatureRow(r: FeatureResult): string {
  const name = 'Feature'.padEnd(13);
  if (r.kind === 'skipped') {
    return `  ${pc.gray('·')} ${name} ${pc.gray('graphify-seed-packs skill seed skipped (--no-feature)')}`;
  }
  if (r.kind === 'error') {
    return `  ${pc.red('✗')} ${name} ${pc.red(r.message)}`;
  }
  const glyph = isDrift(r.outcome) ? pc.yellow('◌') : pc.green('✓');
  const note = r.outcome.notes ?? r.outcome.action;
  return `  ${glyph} ${name} ${pc.gray(`${r.outcome.path} — ${note}`)}`;
}

/** The two prerequisites that must hold for the wiring to actually resolve at runtime. */
function renderEnableNotice(python: string, graphPath: string): string {
  const lines: string[] = [];
  lines.push(pc.bold('  For the agent to actually reach Graphify, two things must be true:'));
  lines.push('');
  lines.push(`  ${pc.cyan('1.')} Install Graphify's MCP module so \`${python} -m graphify.serve\` resolves:`);
  lines.push(`       ${pc.gray('pip install "graphifyy[mcp]"')}`);
  lines.push(`     ${pc.gray('Graphify recommends an isolated venv (system Python often lacks the mcp package):')}`);
  lines.push(`       ${pc.gray('python3 -m venv .venv && .venv/bin/pip install "graphifyy[mcp]"')}`);
  lines.push(
    `       ${pc.gray('coodra graphify enable --python .venv/bin/python3   (re-run with the venv interpreter)')}`,
  );
  lines.push('');
  lines.push(`  ${pc.cyan('2.')} Build the graph so \`${graphPath}\` exists:`);
  lines.push(`       ${pc.gray('uv tool install graphifyy   (or: pipx install graphifyy / pip install graphifyy)')}`);
  lines.push(`       ${pc.gray('then run  /graphify .  in your AI assistant — writes graphify-out/graph.json')}`);
  lines.push('');
  lines.push(
    hintLine(
      `  The \`${GRAPHIFY_SEED_FEATURE_SLUG}\` skill was seeded — once the graph exists, ask the agent to ` +
        '"seed feature packs from the graph".',
    ),
  );
  lines.push(hintLine('  Run `coodra graphify status` to check the wiring, `coodra graphify disable` to remove it.'));
  return `${lines.join('\n')}\n`;
}

/** Print an IDE-selection / no-IDE failure and exit user-recoverable. */
function failSelection(io: GraphifyIO, message: string, json: boolean): never {
  if (json) {
    io.writeStdout(`${JSON.stringify({ ok: false, error: 'ide_selection', message }, null, 2)}\n`);
  } else {
    io.writeStderr(`${pc.red('✗')} ${message}\n`);
  }
  return io.exit(EXIT_USER_RECOVERABLE);
}

/** Resolve the project slug from `<cwd>/.coodra.json`, falling back to the dir basename. */
async function resolveProjectSlug(cwd: string): Promise<string> {
  try {
    const raw = await readFile(join(cwd, '.coodra.json'), 'utf8');
    const parsed = JSON.parse(raw) as { projectSlug?: unknown };
    if (typeof parsed.projectSlug === 'string' && parsed.projectSlug.length > 0) {
      return parsed.projectSlug;
    }
  } catch {
    // No .coodra.json (or unreadable) — fall through to the basename.
  }
  const slug = basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'project';
}

/**
 * `coodra graphify enable` — add the `graphify` MCP server entry to each
 * targeted agent config and seed the `graphify-seed-packs` Feature
 * recipe. Idempotent; preserves the `coodra` entry and any user edits
 * (a drifted `graphify` entry / feature.md is left untouched unless
 * `--force`).
 */
export async function runGraphifyEnableCommand(
  options: GraphifyEnableOptions = {},
  io: GraphifyIO = DEFAULT_GRAPHIFY_IO,
): Promise<never> {
  const cwd = options.cwd ?? process.cwd();
  const userHome = options.userHome ?? homedir();
  const python = options.python ?? DEFAULT_GRAPHIFY_PYTHON;
  const graphPath = options.graph ?? DEFAULT_GRAPHIFY_GRAPH_PATH;
  const dryRun = options.dryRun === true;
  const json = options.json === true;
  const seedFeature = options.feature !== false;

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

  const results: IdeActionResult[] = [];
  for (const ide of selection.ides) {
    try {
      const outcome = await wireGraphify({
        ide,
        cwd,
        userHome,
        python,
        graphPath,
        force: options.force === true,
        dryRun,
      });
      results.push({ kind: 'outcome', ide, displayName: IDE_DISPLAY[ide], outcome });
    } catch (err) {
      results.push({ kind: 'error', ide, displayName: IDE_DISPLAY[ide], message: (err as Error).message });
    }
  }

  let feature: FeatureResult = { kind: 'skipped' };
  if (seedFeature) {
    try {
      const outcome = await seedGraphifySeedPacksFeature({
        cwd,
        projectSlug: await resolveProjectSlug(cwd),
        force: options.force === true,
        dryRun,
      });
      feature = { kind: 'outcome', outcome };
    } catch (err) {
      feature = { kind: 'error', message: (err as Error).message };
    }
  }

  const hadError = results.some((r) => r.kind === 'error') || feature.kind === 'error';
  const exitCode = hadError ? EXIT_USER_RECOVERABLE : EXIT_OK;

  if (json) {
    io.writeStdout(
      `${JSON.stringify(
        {
          ok: !hadError,
          command: 'graphify enable',
          dryRun,
          server: 'graphify',
          results: results.map(serializeActionResult),
          feature: serializeFeatureResult(feature),
        },
        null,
        2,
      )}\n`,
    );
    return io.exit(exitCode);
  }

  io.writeStdout(
    `${commandTitle('Graphify', dryRun ? 'enable (dry run)' : 'enable', { width: terminalWidth(), indent: 0 })}\n\n`,
  );
  for (const r of results) {
    io.writeStdout(`${renderActionRow(r)}\n`);
  }
  io.writeStdout(`${renderFeatureRow(feature)}\n`);
  io.writeStdout('\n');
  io.writeStdout(renderEnableNotice(python, graphPath));
  return io.exit(exitCode);
}

/**
 * `coodra graphify disable` — remove the `graphify` MCP server entry
 * from each targeted agent config. Idempotent — a missing file or
 * missing entry is a no-op. Every other server entry (incl. `coodra`)
 * is left untouched. The seeded `graphify-seed-packs` Feature is NOT
 * removed (it may carry user edits) — drop it with
 * `coodra feature remove graphify-seed-packs --force` if you want.
 */
export async function runGraphifyDisableCommand(
  options: GraphifyDisableOptions = {},
  io: GraphifyIO = DEFAULT_GRAPHIFY_IO,
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
      const outcome = await unwireGraphify({ ide, cwd, userHome, dryRun });
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
          command: 'graphify disable',
          dryRun,
          server: 'graphify',
          results: results.map(serializeActionResult),
        },
        null,
        2,
      )}\n`,
    );
    return io.exit(exitCode);
  }

  io.writeStdout(
    `${commandTitle('Graphify', dryRun ? 'disable (dry run)' : 'disable', { width: terminalWidth(), indent: 0 })}\n\n`,
  );
  for (const r of results) {
    io.writeStdout(`${renderActionRow(r)}\n`);
  }
  io.writeStdout('\n');
  io.writeStdout(
    hintLine(
      `  The \`${GRAPHIFY_SEED_FEATURE_SLUG}\` skill (docs/features/) was left in place — ` +
        'remove it with `coodra feature remove graphify-seed-packs --force` if you no longer want it.',
    ),
  );
  io.writeStdout('\n');
  return io.exit(exitCode);
}

interface GraphifyIdeStatus {
  readonly ide: IDE;
  readonly displayName: string;
  readonly configPath: string;
  readonly exists: boolean;
  readonly wired: boolean;
  readonly unreadable: boolean;
}

function renderStatusRow(s: GraphifyIdeStatus): string {
  const name = s.displayName.padEnd(13);
  let glyph: string;
  let note: string;
  if (s.unreadable) {
    glyph = pc.red('✗');
    note = `${s.configPath} — unreadable config`;
  } else if (s.wired) {
    glyph = pc.green('✓');
    note = `${s.configPath} — graphify MCP entry present`;
  } else if (s.exists) {
    glyph = pc.yellow('◌');
    note = `${s.configPath} — no graphify entry`;
  } else {
    glyph = pc.gray('✗');
    note = `${s.configPath} — config file missing`;
  }
  return `  ${glyph} ${name} ${pc.gray(note)}`;
}

/**
 * `coodra graphify status` — read-only probe of whether the `graphify`
 * MCP entry is present in each agent config (Claude Code / Cursor /
 * Windsurf / Codex). Touches no disk state.
 */
export async function runGraphifyStatusCommand(
  options: GraphifyStatusOptions = {},
  io: GraphifyIO = DEFAULT_GRAPHIFY_IO,
): Promise<never> {
  const cwd = options.cwd ?? process.cwd();
  const userHome = options.userHome ?? homedir();

  const statuses: GraphifyIdeStatus[] = [];
  for (const ide of IDE_ORDER) {
    const presence = await readGraphifyPresence({ ide, cwd, userHome });
    statuses.push({
      ide,
      displayName: IDE_DISPLAY[ide],
      configPath: graphifyConfigPath(ide, cwd, userHome),
      ...presence,
    });
  }

  if (options.json === true) {
    io.writeStdout(`${JSON.stringify({ server: 'graphify', ides: statuses }, null, 2)}\n`);
    return io.exit(EXIT_OK);
  }

  io.writeStdout(`${commandTitle('Graphify', 'status', { width: terminalWidth(), indent: 0 })}\n\n`);
  for (const s of statuses) {
    io.writeStdout(`${renderStatusRow(s)}\n`);
  }
  io.writeStdout('\n');
  const anyWired = statuses.some((s) => s.wired);
  io.writeStdout(
    hintLine(
      anyWired
        ? '  Run `coodra graphify disable` to remove the wiring.'
        : '  Run `coodra graphify enable` to wire Graphify into your agent config.',
    ),
  );
  io.writeStdout('\n');
  return io.exit(EXIT_OK);
}
