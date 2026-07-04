import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { detectIDE, type IDE, IDE_DISPLAY, IDE_ORDER, resolveIdeSelection } from '../lib/detect.js';
import { type InstallCommandRunner, offerGraphifyInstall } from '../lib/init/graphify-install.js';
import {
  type GraphifyPythonResolution,
  type GraphifyPythonResolver,
  resolveGraphifyPython,
  type VerifyResult,
} from '../lib/init/graphify-python.js';
import {
  DEFAULT_GRAPHIFY_GRAPH_PATH,
  graphifyConfigPath,
  readGraphifyPresence,
  unwireGraphify,
  wireGraphify,
} from '../lib/init/graphify-wire.js';
import type { WriteOutcome } from '../lib/init/types.js';
import { terminalReadPrompt } from '../lib/terminal-prompt.js';
import { pc } from '../ui/compat.js';
import { commandTitle, hintLine, terminalWidth } from '../ui/index.js';

/**
 * `coodra graphify {enable,disable,status}` — wires Graphify's own
 * stdio MCP server into the agent config files.
 *
 * Module 09, Track 9B (ADR-010 / ADR-015). Graphify
 * (`safishamsi/graphify`, PyPI `graphifyy`) ships its own MCP server —
 * `python -m graphify.serve graphify-out/graph.json` — exposing
 * `query_graph` / `get_node` / `get_neighbors` / `shortest_path`. Coodra
 * consumes Graphify purely as a **live structural-query tool**: this
 * command adds a `graphify` entry next to the `coodra` entry in each
 * agent's config, and the agent calls Graphify's query tools directly.
 *
 * Coodra mints NO Feature Packs from the graph. The
 * `seed_feature_packs_from_graph` + `build_codebase_graph` tools and the
 * `graphify-seed-packs` recipe were retired 2026-05-23 (ADR-015): a
 * 1-community-1-pack dump produced hundreds of un-injectable shells (73%
 * single-file noise on a real repo) and the resolution layer never
 * surfaced them. Feature Packs stay human/agent-authored at module
 * granularity; Graphify's value is its query layer.
 *
 * The per-IDE wiring is delegated to `lib/init/graphify-wire.ts`, which
 * sits on the 9·Core substrate: `external-mcp-merge.ts` for the JSON
 * agents (Claude Code / Cursor / Windsurf) and `external-codex-merge.ts`
 * for Codex's TOML config. All four agents get a real, idempotent,
 * never-clobber write.
 */

export interface GraphifyEnableOptions {
  /** `--ide` — claude | cursor | windsurf | codex | all (comma-separated). Autodetect when omitted. */
  readonly ide?: string;
  /** `--python` — interpreter for `-m graphify.serve`. Omit to auto-detect a verified `graphifyy[mcp]` interpreter. */
  readonly python?: string;
  /** `--graph` — path to `graphify-out/graph.json` (default: graphify-out/graph.json). */
  readonly graph?: string;
  /** `--force` — overwrite an existing drifted `graphify` entry. */
  readonly force?: boolean;
  /** `--dry-run` — report what would change without touching disk. */
  readonly dryRun?: boolean;
  /** `--json` — emit a structured JSON report. */
  readonly json?: boolean;
  /** Override `process.cwd()` for tests. */
  readonly cwd?: string;
  /** Override `$HOME` for tests. */
  readonly userHome?: string;
  /** Override `process.env` for tests (used by interpreter auto-detection). */
  readonly env?: NodeJS.ProcessEnv;
  /** Injectable interpreter resolver (tests). Defaults to the real probe-and-verify path. */
  readonly resolvePython?: GraphifyPythonResolver;
  /**
   * `--install` / `--no-install` — when no verified interpreter is found,
   * `true` installs `graphifyy[mcp]` into `<cwd>/.venv` without asking,
   * `false` suppresses the offer, `undefined` (default) prompts on a TTY.
   */
  readonly install?: boolean;
  /** Injectable prompt reader (tests). Defaults to readline on a TTY. */
  readonly readPrompt?: (question: string) => Promise<string>;
  /** Injectable install subprocess runner (tests). */
  readonly installRunner?: InstallCommandRunner;
  /** Injectable uv-availability probe (tests). */
  readonly probeUv?: () => Promise<boolean>;
  /** Injectable post-install verifier (tests). */
  readonly verifyInstall?: (pythonPath: string) => Promise<VerifyResult>;
  /** Override `process.platform` (tests — venv layout differs on win32). */
  readonly platform?: NodeJS.Platform;
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

/** Provenance → human phrase, for the "auto-detected" success line. */
const PYTHON_SOURCE_LABEL: Record<GraphifyPythonResolution['source'], string> = {
  flag: 'from --python',
  virtualenv: 'active virtualenv',
  venv: 'project .venv',
  'graphify-shebang': 'the `graphify` install on PATH',
  'uv-tool': 'the uv-tool install',
  python3: 'python3 on PATH',
  python: 'python on PATH',
  fallback: 'fallback',
};

/**
 * Verified-interpreter notice. The interpreter imports `graphify.serve`
 * + `mcp`, so the only remaining prerequisite is a built graph. Concise
 * — we don't bury a working setup under install instructions.
 */
function renderVerifiedNotice(resolution: GraphifyPythonResolution, graphPath: string, graphExists: boolean): string {
  const lines: string[] = [];
  lines.push(
    `  ${pc.green('✓')} Interpreter ${pc.cyan(resolution.python)} verified ` +
      pc.gray(`— \`import graphify.serve, mcp\` succeeds (${PYTHON_SOURCE_LABEL[resolution.source]}).`),
  );
  if (graphExists) {
    lines.push(`  ${pc.green('✓')} Graph found at ${pc.cyan(graphPath)} — reconnect the agent and Graphify is live.`);
  } else {
    lines.push(
      `  ${pc.yellow('◌')} No graph yet at \`${graphPath}\`. Build it — ${pc.gray('`/graphify .` in the assistant, or `graphify update .`')} — then reconnect the agent.`,
    );
  }
  lines.push('');
  lines.push(
    hintLine(
      '  Ask the agent structural questions — "what depends on X?", "where is Y ' +
        'defined?", "shortest path from A to B" — via Graphify\'s query_graph / get_node / get_neighbors.',
    ),
  );
  lines.push(hintLine('  Run `coodra graphify status` to check the wiring, `coodra graphify disable` to remove it.'));
  return `${lines.join('\n')}\n`;
}

/**
 * Unverified-interpreter notice. `<python> -c "import graphify.serve,
 * mcp"` did NOT succeed (or we're in a dry run with nothing installed),
 * so the agent's MCP server would fail to spawn. Spell out the two
 * prerequisites: (1) install the package, (2) build the graph.
 */
function renderUnverifiedNotice(resolution: GraphifyPythonResolution, graphPath: string): string {
  const python = resolution.python;
  const lines: string[] = [];
  lines.push(pc.bold('  Graphify is wired, but no working interpreter was found yet. Two things must be true'));
  lines.push(pc.bold('  before the agent can reach it:'));
  if (resolution.detail !== undefined) {
    lines.push(pc.gray(`  (probe: ${resolution.detail})`));
  }
  lines.push('');
  lines.push(`  ${pc.cyan('1.')} Install Graphify so \`${python} -m graphify.serve\` resolves. The easy path:`);
  lines.push(
    `       ${pc.gray('coodra graphify enable --install')}   ${pc.gray('(creates ./.venv and installs graphifyy[mcp])')}`,
  );
  lines.push(`     or do it by hand in an isolated venv:`);
  lines.push(`       ${pc.gray('uv venv .venv')}`);
  lines.push(`       ${pc.gray('uv pip install --python .venv/bin/python "graphifyy[mcp]"')}`);
  lines.push(`     then re-run — auto-detection will pick it up, or pin it explicitly:`);
  lines.push(`       ${pc.gray('coodra graphify enable --python .venv/bin/python --force')}`);
  lines.push('');
  lines.push(`  ${pc.cyan('2.')} Build the graph so \`${graphPath}\` exists. The simplest path is the`);
  lines.push(`     \`/graphify .\` slash command inside your AI assistant (no API key — it uses the`);
  lines.push(`     IDE's LLM session). Or run the no-LLM CLI: \`.venv/bin/graphify update .\`.`);
  lines.push('');
  lines.push(`  ${pc.bold('Sanity-check the install:')}`);
  lines.push(`       ${pc.gray(`${python} -c "import graphify.serve, mcp; print('ok')"`)}`);
  lines.push('');
  lines.push(
    hintLine(
      '  Once connected, ask the agent structural questions — "what depends on X?", "where is Y ' +
        'defined?", "shortest path from A to B" — via Graphify\'s query_graph / get_node / get_neighbors.',
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

/**
 * `coodra graphify enable` — add the `graphify` MCP server entry to each
 * targeted agent config so the agent can call Graphify's structural-query
 * tools. Idempotent; preserves the `coodra` entry and any user edits (a
 * drifted `graphify` entry is left untouched unless `--force`).
 */
export async function runGraphifyEnableCommand(
  options: GraphifyEnableOptions = {},
  io: GraphifyIO = DEFAULT_GRAPHIFY_IO,
): Promise<never> {
  const cwd = options.cwd ?? process.cwd();
  const userHome = options.userHome ?? homedir();
  const env = options.env ?? process.env;
  const graphPath = options.graph ?? DEFAULT_GRAPHIFY_GRAPH_PATH;
  const dryRun = options.dryRun === true;
  const json = options.json === true;

  // Resolve the interpreter BEFORE wiring. When `--python` is omitted we
  // probe + verify candidate interpreters so the written entry points at
  // a Python that can actually `import graphify.serve, mcp` — instead of
  // blindly defaulting to bare `python3`, which on most machines fails to
  // spawn and shows up as a "failed" MCP server in the agent.
  const resolver = options.resolvePython ?? resolveGraphifyPython;
  let resolution = await resolver({
    ...(options.python !== undefined ? { explicit: options.python } : {}),
    cwd,
    env,
  });

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

  // Install-first (2026-07-02): when nothing verified and the user didn't
  // pin --python, offer to install graphifyy[mcp] into <cwd>/.venv NOW —
  // wiring a dead entry and printing manual steps left users with a
  // "failed" MCP server and a /graphify command that didn't work. An
  // existing .venv is the user's — the prompt asks before touching it.
  // Skipped on --dry-run; in --json mode only an explicit --install runs
  // it (no prompts in machine mode), with progress on stderr.
  if (!resolution.verified && options.python === undefined && !dryRun && !(json && options.install !== true)) {
    const interactive = options.readPrompt !== undefined || process.stdin.isTTY === true;
    resolution = await offerGraphifyInstall({
      resolution,
      cwd,
      interactive,
      ...(options.install !== undefined ? { installFlag: options.install } : {}),
      ...(options.readPrompt !== undefined
        ? { readPrompt: options.readPrompt }
        : interactive
          ? { readPrompt: terminalReadPrompt }
          : {}),
      writeStdout: json ? io.writeStderr : io.writeStdout,
      ...(options.installRunner !== undefined ? { runner: options.installRunner } : {}),
      ...(options.verifyInstall !== undefined ? { verify: options.verifyInstall } : {}),
      ...(options.probeUv !== undefined ? { probeUv: options.probeUv } : {}),
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
    });
  }
  const python = resolution.python;

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

  const hadError = results.some((r) => r.kind === 'error');
  const exitCode = hadError ? EXIT_USER_RECOVERABLE : EXIT_OK;

  // Does the resolved graph artifact already exist? (Relative paths
  // resolve against the repo root the agent spawns the server from.)
  const graphExists = existsSync(isAbsolute(graphPath) ? graphPath : join(cwd, graphPath));

  if (json) {
    io.writeStdout(
      `${JSON.stringify(
        {
          ok: !hadError,
          command: 'graphify enable',
          dryRun,
          server: 'graphify',
          python,
          pythonVerified: resolution.verified,
          pythonSource: resolution.source,
          graphExists,
          results: results.map(serializeActionResult),
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
  io.writeStdout('\n');
  io.writeStdout(
    resolution.verified
      ? renderVerifiedNotice(resolution, graphPath, graphExists)
      : renderUnverifiedNotice(resolution, graphPath),
  );
  return io.exit(exitCode);
}

/**
 * `coodra graphify disable` — remove the `graphify` MCP server entry
 * from each targeted agent config. Idempotent — a missing file or
 * missing entry is a no-op. Every other server entry (incl. `coodra`)
 * is left untouched.
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
  io.writeStdout(hintLine('  Removed the `graphify` MCP entry. Run `coodra graphify enable` to wire it back.'));
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
