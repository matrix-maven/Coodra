import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EXIT_OK } from '../exit-codes.js';
import { claudePluginPaths } from '../lib/agents/claude-plugin.js';
import { codexPluginPaths } from '../lib/agents/codex-plugin.js';
import { cursorPluginPaths } from '../lib/agents/cursor-plugin.js';
import { devinPluginPaths } from '../lib/agents/devin-plugin.js';
import { pc } from '../ui/compat.js';
import { commandTitle, hintLine, type KvRow, kvBlock, sectionHead, terminalWidth } from '../ui/index.js';

/**
 * `coodra agents` — read-only status surface for the multi-agent wiring.
 *
 * Lists each supported agent (Claude Code, Codex, Cursor, Devin) with a per-file status:
 *   ✓ wired   — file exists AND contains a managed coodra entry/block
 *   ◌ partial — file exists but no coodra entry/block (or vice versa)
 *   ✗ missing — file does not exist
 *
 * Companion to `coodra agent add` (which writes the files) and
 * `coodra uninstall` (which removes them). The TUI's /02 catalog picks
 * up this command automatically.
 */

export interface AgentsOptions {
  readonly json?: boolean;
  readonly cwd?: string;
  readonly userHome?: string;
}

export interface AgentsIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_AGENTS_IO: AgentsIO = {
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

type AgentName = 'claude' | 'codex' | 'cursor' | 'devin';

export interface AgentFileState {
  /** Display name of the file (`.mcp.json`, `~/.claude/settings.json`, etc.). */
  readonly label: string;
  /** Absolute path on disk. */
  readonly path: string;
  /** Whether the file exists. */
  readonly exists: boolean;
  /** Whether the file carries the managed coodra entry/block. */
  readonly wired: boolean;
  /** Short note explaining the status. */
  readonly notes: string;
}

export interface AgentReport {
  readonly name: AgentName;
  readonly displayName: string;
  readonly detected: boolean;
  /** Path to the IDE config dir we use for detection. */
  readonly detectionPath: string;
  readonly files: readonly AgentFileState[];
  /** Short note rendered after the files block. */
  readonly howToEnable: string | null;
}

export async function runAgentsCommand(options: AgentsOptions = {}, io: AgentsIO = DEFAULT_AGENTS_IO): Promise<never> {
  const cwd = options.cwd ?? process.cwd();
  const userHome = options.userHome ?? homedir();
  const reports = await buildAgentReports({ cwd, userHome });

  if (options.json === true) {
    io.writeStdout(`${JSON.stringify(reports, null, 2)}\n`);
    return io.exit(EXIT_OK);
  }

  io.writeStdout(`${commandTitle('Agents', 'Coodra wiring', { width: terminalWidth(), indent: 0 })}\n`);
  io.writeStdout('\n');
  reports.forEach((report, idx) => {
    renderAgent(report, idx + 1, io);
    io.writeStdout('\n');
  });
  io.writeStdout(
    hintLine('Run `coodra agent add <agent>` to wire a detected agent, `coodra uninstall` to strip Coodra files.'),
  );
  io.writeStdout('\n');
  return io.exit(EXIT_OK);
}

function renderAgent(report: AgentReport, slot: number, io: AgentsIO): void {
  const slotNum = String(slot).padStart(2, '0');
  const detectionTone = report.detected ? pc.green('✓') : pc.gray('✗');
  io.writeStdout(`${sectionHead(slotNum, report.displayName)}\n`);
  io.writeStdout(
    `  ${detectionTone} ${report.detectionPath}  ${pc.gray(report.detected ? '(detected)' : '(not installed)')}\n`,
  );
  const rows: KvRow[] = report.files.map((file) => ({
    key: `${fileGlyph(file)} ${file.label}`,
    value: file.notes,
    valueTone: file.wired ? 'phosphor' : file.exists ? 'amber' : 'inkFar',
  }));
  if (rows.length > 0) {
    io.writeStdout(`${kvBlock(rows, { keyWidth: 42, indent: 2 })}\n`);
  }
  if (report.howToEnable !== null) {
    io.writeStdout(`  ${pc.gray(`→ ${report.howToEnable}`)}\n`);
  }
}

function fileGlyph(file: AgentFileState): string {
  if (file.wired) return pc.green('✓');
  if (file.exists) return pc.yellow('◌');
  return pc.gray('✗');
}

export interface BuildReportsInput {
  readonly cwd: string;
  readonly userHome: string;
}

export async function buildAgentReports(input: BuildReportsInput): Promise<readonly AgentReport[]> {
  return [await claudeReport(input), await codexReport(input), await cursorReport(input), await devinReport(input)];
}

async function claudeReport(input: BuildReportsInput): Promise<AgentReport> {
  const claudeDir = join(input.userHome, '.claude');
  const detected = await pathExists(claudeDir);
  const plugin = claudePluginPaths(input.userHome);
  return {
    name: 'claude',
    displayName: 'Claude Code',
    detected,
    detectionPath: `${claudeDir}/`,
    files: [
      await fileContainsState({
        path: plugin.settingsPath,
        label: 'Claude user plugin enablement',
        needle: '"coodra@coodra": true',
        wiredNote: 'coodra@coodra enabled in user settings',
        missingNote: 'missing',
        partialNote: 'coodra@coodra is not enabled',
      }),
      await fileContainsState({
        path: plugin.marketplacePath,
        label: 'Claude local marketplace',
        needle: '"name": "coodra"',
        wiredNote: 'coodra local marketplace present',
        missingNote: 'missing',
        partialNote: 'marketplace manifest does not match coodra',
      }),
      await fileContainsState({
        path: plugin.cacheManifestPath,
        label: 'Claude plugin manifest',
        needle: '"name": "coodra"',
        wiredNote: 'coodra plugin manifest present',
        missingNote: 'missing',
        partialNote: 'plugin manifest does not match coodra',
      }),
      await mcpJsonState({ path: plugin.cacheMcpPath, label: 'Claude plugin MCP' }),
      await fileContainsState({
        path: plugin.cacheHooksPath,
        label: 'Claude plugin hooks',
        needle: '"SessionStart"',
        wiredNote: 'coodra lifecycle hooks present',
        missingNote: 'missing',
        partialNote: 'no coodra lifecycle hooks',
      }),
      await fileContainsState({
        path: join(plugin.cacheSkillsRoot, 'coodra-context', 'SKILL.md'),
        label: 'Claude plugin skills',
        needle: 'name: coodra-context',
        wiredNote: 'coodra skills present',
        missingNote: 'missing',
        partialNote: 'coodra context skill missing',
      }),
    ],
    howToEnable: detected ? null : 'Install Claude Code (claude.ai/code), then run `coodra agent add claude`.',
  };
}

async function codexReport(input: BuildReportsInput): Promise<AgentReport> {
  const codexDir = join(input.userHome, '.codex');
  const detected = await pathExists(codexDir);
  const plugin = codexPluginPaths(input.userHome);
  return {
    name: 'codex',
    displayName: 'Codex',
    detected,
    detectionPath: `${codexDir}/`,
    files: [
      await fileContainsState({
        path: plugin.marketplacePath,
        label: 'Coodra Codex marketplace',
        needle: '"name": "coodra"',
        wiredNote: 'coodra marketplace registered',
        missingNote: 'missing',
        partialNote: 'no coodra marketplace entry',
      }),
      await fileContainsState({
        path: plugin.manifestPath,
        label: 'Codex plugin manifest',
        needle: '"name": "coodra"',
        wiredNote: 'coodra plugin manifest present',
        missingNote: 'missing',
        partialNote: 'plugin manifest does not match coodra',
      }),
      await mcpJsonState({ path: plugin.mcpPath, label: 'Codex plugin MCP' }),
      await fileContainsState({
        path: plugin.hooksPath,
        label: 'Codex plugin hooks',
        needle: '"SessionStart"',
        wiredNote: 'coodra lifecycle hooks present',
        missingNote: 'missing',
        partialNote: 'no coodra lifecycle hooks',
      }),
      await fileContainsState({
        path: join(plugin.skillsRoot, 'coodra-context', 'SKILL.md'),
        label: 'Codex plugin skills',
        needle: 'name: coodra-context',
        wiredNote: 'coodra skills present',
        missingNote: 'missing',
        partialNote: 'coodra context skill missing',
      }),
    ],
    howToEnable: detected ? null : 'Install Codex CLI (github.com/openai/codex), then run `coodra agent add codex`.',
  };
}

async function cursorReport(input: BuildReportsInput): Promise<AgentReport> {
  const cursorDir = join(input.userHome, '.cursor');
  const detected = await pathExists(cursorDir);
  const plugin = cursorPluginPaths(input.userHome);
  return {
    name: 'cursor',
    displayName: 'Cursor',
    detected,
    detectionPath: `${cursorDir}/`,
    files: [
      await fileContainsState({
        path: plugin.manifestPath,
        label: 'Cursor plugin manifest',
        needle: '"name": "coodra"',
        wiredNote: 'coodra plugin manifest present',
        missingNote: 'missing',
        partialNote: 'plugin manifest does not match coodra',
      }),
      await mcpJsonState({ path: plugin.mcpPath, label: 'Cursor plugin MCP' }),
      await fileContainsState({
        path: plugin.hooksPath,
        label: 'Cursor plugin hooks',
        needle: '"sessionStart"',
        wiredNote: 'coodra lifecycle hooks present',
        missingNote: 'missing',
        partialNote: 'no coodra lifecycle hooks',
      }),
      await fileContainsState({
        path: join(plugin.skillsRoot, 'coodra-context', 'SKILL.md'),
        label: 'Cursor plugin skills',
        needle: 'name: coodra-context',
        wiredNote: 'coodra skills present',
        missingNote: 'missing',
        partialNote: 'coodra context skill missing',
      }),
    ],
    howToEnable: detected ? null : 'Install Cursor (cursor.com), then run `coodra agent add cursor`.',
  };
}

async function devinReport(input: BuildReportsInput): Promise<AgentReport> {
  const devinDir = join(input.userHome, '.devin');
  const detected = await pathExists(devinDir);
  const plugin = devinPluginPaths(input.userHome);
  return {
    name: 'devin',
    displayName: 'Devin',
    detected,
    detectionPath: `${devinDir}/`,
    files: [
      await fileContainsState({
        path: plugin.manifestPath,
        label: 'Devin plugin manifest',
        needle: '"name": "coodra"',
        wiredNote: 'coodra plugin manifest present',
        missingNote: 'missing',
        partialNote: 'plugin manifest does not match coodra',
      }),
      await mcpJsonState({ path: plugin.mcpPath, label: 'Devin plugin MCP' }),
      await fileContainsState({
        path: plugin.hooksPath,
        label: 'Devin plugin hooks',
        needle: '"SessionStart"',
        wiredNote: 'coodra lifecycle hooks present',
        missingNote: 'missing',
        partialNote: 'no coodra lifecycle hooks',
      }),
      await fileContainsState({
        path: join(plugin.skillsRoot, 'coodra-context', 'SKILL.md'),
        label: 'Devin plugin skills',
        needle: 'name: coodra-context',
        wiredNote: 'coodra skills present',
        missingNote: 'missing',
        partialNote: 'coodra context skill missing',
      }),
    ],
    howToEnable: detected
      ? null
      : 'Install Devin CLI (devin.ai — plugins are in closed beta, contact support@cognition.ai for access), then run `coodra agent add devin`.',
  };
}

interface FileLabelInput {
  readonly path: string;
  readonly label: string;
}

async function mcpJsonState(input: FileLabelInput): Promise<AgentFileState> {
  const exists = await pathExists(input.path);
  if (!exists) {
    return {
      label: input.label,
      path: input.path,
      exists: false,
      wired: false,
      notes: 'missing',
    };
  }
  try {
    const raw = await readFile(input.path, 'utf8');
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    const wired = parsed.mcpServers !== undefined && Object.hasOwn(parsed.mcpServers, 'coodra');
    return {
      label: input.label,
      path: input.path,
      exists: true,
      wired,
      notes: wired ? 'coodra MCP entry present' : 'no coodra entry — run `coodra agent add`',
    };
  } catch {
    return { label: input.label, path: input.path, exists: true, wired: false, notes: 'unreadable JSON' };
  }
}

interface FileContainsInput extends FileLabelInput {
  readonly needle: string;
  readonly wiredNote: string;
  readonly missingNote: string;
  readonly partialNote: string;
}

async function fileContainsState(input: FileContainsInput): Promise<AgentFileState> {
  const exists = await pathExists(input.path);
  if (!exists) {
    return { label: input.label, path: input.path, exists: false, wired: false, notes: input.missingNote };
  }
  try {
    const raw = await readFile(input.path, 'utf8');
    const wired = raw.includes(input.needle);
    return {
      label: input.label,
      path: input.path,
      exists: true,
      wired,
      notes: wired ? input.wiredNote : input.partialNote,
    };
  } catch {
    return { label: input.label, path: input.path, exists: true, wired: false, notes: 'unreadable file' };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
