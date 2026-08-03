import { homedir } from 'node:os';
import { EXIT_OK } from '../exit-codes.js';
import { createClaudeCliRunner, probeClaudePlugin } from '../lib/agents/claude-plugin.js';
import { createCodexCliRunner, probeCodexPlugin } from '../lib/agents/codex-plugin.js';
import { probeCursorPlugin } from '../lib/agents/cursor-plugin.js';
import { resolveGraphifyPaths, scanGraphifyArtifacts } from '../lib/graphify/artifacts.js';
import { defaultClaudeSettingsPath } from '../lib/init/claude-settings-merge.js';
import { pc } from '../ui/compat.js';
import { commandTitle, hintLine, terminalWidth } from '../ui/index.js';
import { renderScan } from './graphify-artifacts.js';

/**
 * `coodra graphify status` — read-only probe of whether Graphify's
 * stdio MCP server is available to Claude Code / Codex, plus the
 * graph artifact state (`coodra graphify build/open/clean` in
 * `graphify-artifacts.ts` own the artifact half).
 *
 * Module 09, Track 9B (ADR-010 / ADR-015). Graphify (`safishamsi/graphify`,
 * PyPI `graphifyy`) ships its own MCP server exposing `query_graph` /
 * `get_node` / `get_neighbors` / `shortest_path`. Coodra consumes it
 * purely as a **live structural-query tool**; it mints no Work Packs
 * or Recipes from the graph.
 *
 * Graphify wiring is Coodra-owned end to end: `coodra install` sets up
 * one shared machine runtime (`~/.coodra/graphify-mcp/.venv`), and both
 * native Claude Code and Codex plugins bundle a managed `graphify` MCP
 * entry pointed at `.coodra/graphify/out/graph.json` alongside `coodra`.
 * There is no per-IDE `enable`/`disable` config-writing path anymore —
 * `coodra agent add <agent>` / `coodra agent repair <agent>` is the only
 * way Graphify gets wired, matching how the `coodra` entry itself is
 * wired. This command is read-only diagnostics only.
 */

export interface GraphifyStatusOptions {
  readonly json?: boolean;
  readonly cwd?: string;
  readonly userHome?: string;
  readonly env?: NodeJS.ProcessEnv;
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

interface GraphifyAgentStatus {
  readonly id: 'claude' | 'codex' | 'cursor';
  readonly displayName: string;
  readonly wired: boolean;
}

function renderStatusRow(s: GraphifyAgentStatus): string {
  const name = s.displayName.padEnd(13);
  const glyph = s.wired ? pc.green('✓') : pc.gray('✗');
  const note = s.wired ? 'managed by native Coodra plugin' : 'not installed — run `coodra agent add <agent>`';
  return `  ${glyph} ${name} ${pc.gray(note)}`;
}

export async function runGraphifyStatusCommand(
  options: GraphifyStatusOptions = {},
  io: GraphifyIO = DEFAULT_GRAPHIFY_IO,
): Promise<never> {
  const cwd = options.cwd ?? process.cwd();
  const userHome = options.userHome ?? homedir();
  const env = options.env ?? process.env;

  const statuses: GraphifyAgentStatus[] = await probeNativeManagedGraphify({ cwd, userHome, env });

  // The artifact half — where the graph lives and what's in it.
  const artifactPaths = await resolveGraphifyPaths(cwd);
  const scan = await scanGraphifyArtifacts(cwd, artifactPaths);

  if (options.json === true) {
    io.writeStdout(`${JSON.stringify({ server: 'graphify', agents: statuses, artifacts: scan }, null, 2)}\n`);
    return io.exit(EXIT_OK);
  }

  io.writeStdout(`${commandTitle('Graphify', 'status', { width: terminalWidth(), indent: 0 })}\n\n`);
  for (const s of statuses) {
    io.writeStdout(`${renderStatusRow(s)}\n`);
  }
  io.writeStdout('\n');
  io.writeStdout(
    `  ${pc.bold('Graph artifacts')} ${pc.gray(`— ${artifactPaths.outputDir}${artifactPaths.managedByCoodra ? ' (Coodra-managed)' : ' (Graphify default)'}`)}\n`,
  );
  renderScan(io, scan);
  io.writeStdout('\n');
  const anyMissing = statuses.some((s) => !s.wired);
  io.writeStdout(
    hintLine(
      anyMissing
        ? '  Run `coodra agent add <agent>` to install the native plugin (bundles Graphify automatically).'
        : '  Graphify is wired. Build the graph with `coodra graphify build`.',
    ),
  );
  io.writeStdout('\n');
  return io.exit(EXIT_OK);
}

async function probeNativeManagedGraphify(args: {
  readonly cwd: string;
  readonly userHome: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<GraphifyAgentStatus[]> {
  let codexWired = false;
  try {
    const codex = await probeCodexPlugin({ cwd: args.cwd, userHome: args.userHome }, createCodexCliRunner(1200));
    codexWired = codex.mcp;
  } catch {
    // status remains best-effort
  }
  let claudeWired = false;
  try {
    const claude = await probeClaudePlugin(
      { cwd: args.cwd, userHome: args.userHome, settingsPath: defaultClaudeSettingsPath(undefined, args.env) },
      createClaudeCliRunner(1200),
    );
    claudeWired = claude.mcp;
  } catch {
    // status remains best-effort
  }
  let cursorWired = false;
  try {
    const cursor = await probeCursorPlugin({ cwd: args.cwd, userHome: args.userHome });
    cursorWired = cursor.mcp;
  } catch {
    // status remains best-effort
  }
  return [
    { id: 'claude', displayName: 'Claude Code', wired: claudeWired },
    { id: 'codex', displayName: 'Codex', wired: codexWired },
    { id: 'cursor', displayName: 'Cursor', wired: cursorWired },
  ];
}
