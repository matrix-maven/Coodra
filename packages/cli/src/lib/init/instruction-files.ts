import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WriteOutcome } from './types.js';

/**
 * `packages/cli/src/lib/init/instruction-files.ts`.
 *
 * Generates the Coodra **agent operating contract** into the per-agent
 * project instruction file:
 *   - Claude  → `<repo>/CLAUDE.md`        (Claude Code auto-reads at session start)
 *   - Cursor  → `<repo>/.cursorrules`     (Cursor applies it to every chat)
 *   - Codex   → `<repo>/AGENTS.md`        (Codex reads it on the first turn)
 *   - Windsurf→ `<repo>/.windsurfrules`   (Cascade applies it to everything)
 *
 * Why this matters: the agent has the 26 `coodra__*` MCP tools wired
 * via `.mcp.json` / `.codex/config.toml` / `.cursor/mcp.json` /
 * `~/.codeium/windsurf/mcp_config.json`, but without an instruction
 * file it doesn't know WHEN to call them. The instruction file IS the
 * trigger contract.
 *
 * For Claude Code specifically, the hooks-bridge ALSO injects a
 * runtime `additionalContext` payload at SessionStart — so CLAUDE.md
 * is defense-in-depth: it works even when the bridge isn't running,
 * and gives the user something visible/editable on disk.
 *
 * **Marker-block discipline.** The generated content lives between
 * `<!-- coodra:start -->` / `<!-- coodra:end -->`. `init` only ever
 * touches the region between the markers — any user content outside is
 * preserved byte-for-byte. Re-running `init` refreshes the block;
 * `coodra uninstall` strips just the block (and deletes the file
 * only if init created it and nothing else was added).
 */

export const INSTRUCTION_BLOCK_START = '<!-- coodra:start -->';
export const INSTRUCTION_BLOCK_END = '<!-- coodra:end -->';

export type InstructionFileName = 'AGENTS.md' | '.windsurfrules' | '.cursorrules' | 'CLAUDE.md';

/**
 * Build the marker-wrapped agent operating contract for `projectSlug`.
 * Agent-neutral — the same block works for Codex (`AGENTS.md`) and
 * Windsurf (`.windsurfrules`): both just call the MCP tools.
 */
export function buildInstructionBlock(projectSlug: string): string {
  return `${INSTRUCTION_BLOCK_START}
## Coodra — agent operating contract

This project uses **Coodra**, an MCP server providing Feature Packs
(project blueprints), Features (on-demand skills), Context Packs (records of
past work), and a Policy Engine. The Coodra MCP server is wired into this
agent — you have the \`coodra__*\` tools available. **These tools are how
Coodra works; if you don't call them, Coodra does nothing.**

Project slug: \`${projectSlug}\` — pass this as \`projectSlug\` to every tool that takes it.

### At the start of every session — do this first
1. \`coodra__get_run_id { projectSlug: "${projectSlug}" }\` — obtains the
   \`runId\` that binds this session. Cache it; reuse it in every later call.
2. \`coodra__get_feature_pack { projectSlug: "${projectSlug}" }\` — the
   architectural blueprint + conventions + permitted files for this project.
   Read it before writing code.
3. \`coodra__list_features { projectSlug: "${projectSlug}" }\` — the available
   skills. Read each description; pull one with \`coodra__get_feature\` only
   when a user request matches its trigger.
4. \`coodra__query_run_history { projectSlug: "${projectSlug}", limit: 5 }\` +
   \`coodra__search_packs_nl { projectSlug: "${projectSlug}", query: "<what you're about to build>" }\`
   — so you don't duplicate or contradict past work.

### Before every file write, edit, or shell command
Call \`coodra__check_policy\` with the tool + input. \`permissionDecision:
"deny"\` → STOP, surface the reason, do not work around it. \`"ask"\` → surface
the question to the user and wait. \`"allow"\` → proceed.

### At every design decision — immediately, not at session end
When you pick a library, design an API/schema, choose an approach, or decide
NOT to do something: \`coodra__record_decision { runId, description,
rationale, alternatives }\`. Log each as you make it — unlogged decisions are
lost if the session is interrupted.

### When the user asks about prior work
"What was done?", "why did we choose X?", "has Y been tried?" → answer from
\`coodra__query_decisions\`, \`coodra__search_packs_nl\`,
\`coodra__query_run_history\` — not from memory.

### Before structural refactors
When the **Graphify** integration is active (the \`graphify\` MCP server is wired
via \`coodra graphify enable\`), call its tools — \`query_graph\`, \`get_node\`,
\`get_neighbors\`, \`shortest_path\` — for blast radius and "where is X defined?"
queries before reading files one by one. If Graphify is not wired, fall back to
reading the files directly. (Coodra's old \`coodra__query_codebase_graph\` tool
was retired in Module 09 / G1 — see ADR-010.)

### At the end of the session
\`coodra__save_context_pack { runId, title, content }\` — a markdown summary
of what was built, decisions made, files changed, and what's next. This is how
the next session (yours or a teammate's) resumes without starting from zero.

### Team mode
If this machine is in team mode, the same tools sync to your team's cloud:
decisions, context packs, and features become visible to teammates and the
policy engine enforces your org's rules. No extra steps — the tools handle it.

> Managed by \`coodra init\`. Edit freely OUTSIDE the markers; this block is
> regenerated on \`coodra init\` and removed by \`coodra uninstall\`.
${INSTRUCTION_BLOCK_END}`;
}

export interface MergeInstructionFileOptions {
  readonly cwd: string;
  readonly filename: InstructionFileName;
  readonly projectSlug: string;
  readonly dryRun: boolean;
}

/**
 * Idempotent write of the Coodra block into `<cwd>/<filename>`.
 *
 *   - File absent              → create it containing just the block.
 *   - File has the markers     → replace the block content (it's our
 *                                managed region — always refreshed).
 *   - File exists, no markers  → append the block, preserving every
 *                                line the user already wrote.
 *
 * No `--force` branch: we never overwrite content outside the markers,
 * so there is nothing destructive to gate.
 */
export async function mergeInstructionFile(options: MergeInstructionFileOptions): Promise<WriteOutcome> {
  const path = join(options.cwd, options.filename);
  const block = buildInstructionBlock(options.projectSlug);
  const exists = await pathExists(path);

  if (!exists) {
    if (!options.dryRun) await writeFile(path, `${block}\n`, 'utf8');
    return { path, action: 'wrote', notes: `created ${options.filename} with the Coodra agent contract` };
  }

  const raw = await readFile(path, 'utf8');
  const startIdx = raw.indexOf(INSTRUCTION_BLOCK_START);
  const endIdx = raw.indexOf(INSTRUCTION_BLOCK_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = raw.slice(0, startIdx);
    const after = raw.slice(endIdx + INSTRUCTION_BLOCK_END.length);
    const next = `${before}${block}${after}`;
    if (next === raw) {
      return { path, action: 'unchanged', notes: 'Coodra agent contract already up to date' };
    }
    if (!options.dryRun) await writeFile(path, next, 'utf8');
    return { path, action: 'merged', notes: `refreshed the Coodra block in ${options.filename}` };
  }

  // No markers — append, preserving every existing line.
  const sep = raw.endsWith('\n') ? '\n' : '\n\n';
  if (!options.dryRun) await writeFile(path, `${raw}${sep}${block}\n`, 'utf8');
  return { path, action: 'merged', notes: `appended the Coodra block to existing ${options.filename}` };
}

/**
 * `coodra uninstall` reverse — strips the Coodra marker block from
 * `<cwd>/<filename>`. Content outside the markers is preserved. If the
 * file is left with only whitespace (init created it and the user added
 * nothing else), the file is deleted.
 */
export async function removeInstructionBlock(options: {
  cwd: string;
  filename: InstructionFileName;
  dryRun: boolean;
}): Promise<WriteOutcome> {
  const path = join(options.cwd, options.filename);
  const exists = await pathExists(path);
  if (!exists) {
    return { path, action: 'unchanged', notes: `${options.filename} does not exist; nothing to remove` };
  }

  const raw = await readFile(path, 'utf8');
  const startIdx = raw.indexOf(INSTRUCTION_BLOCK_START);
  const endIdx = raw.indexOf(INSTRUCTION_BLOCK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return { path, action: 'unchanged', notes: `no Coodra block in ${options.filename}` };
  }

  const before = raw.slice(0, startIdx).replace(/\s+$/, '');
  const after = raw.slice(endIdx + INSTRUCTION_BLOCK_END.length).replace(/^\s+/, '');
  const remaining = `${before}${before.length > 0 && after.length > 0 ? '\n\n' : ''}${after}`;

  if (remaining.trim().length === 0) {
    // File held only the Coodra block — remove the file entirely.
    if (!options.dryRun) await unlink(path);
    return { path, action: 'merged', notes: `removed ${options.filename} (held only the Coodra block)` };
  }

  if (!options.dryRun) await writeFile(path, `${remaining}\n`, 'utf8');
  return { path, action: 'merged', notes: `stripped the Coodra block from ${options.filename}` };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
