import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildCoodraMcpEntry, type CoodraMcpEntry } from '../init/mcp-merge.js';
import type { WriteOutcome } from '../init/types.js';
import { commandHookRunner } from './command-hook-runner.js';
import { buildManagedGraphifyMcpEntry } from './managed-capabilities.js';
import type { AgentContext, AgentPathContext, AgentRemoveContext } from './types.js';

export const ANTIGRAVITY_PLUGIN_NAME = 'coodra' as const;

/**
 * Antigravity's plugin model is structurally closest to Cursor's — no
 * CLI, no login, no marketplace. A plugin is a directory dropped under a
 * scanned root; Antigravity discovers it on its own. Confirmed against
 * Google's own bundled offline docs, shipped inside the installed app
 * and read directly off this machine at
 * `~/.gemini/antigravity/builtin/skills/agy-customizations/docs/
 * plugins.md` (materially more complete than the public
 * antigravity.google/docs/plugins page): "Manual Installation: Place
 * plugin folders in designated directories that Antigravity
 * automatically scans... Global-level: `~/.gemini/config/plugins/`." So
 * install/remove here are pure filesystem writes/deletes, same as
 * `cursor-plugin.ts` — there is no `AntigravityCliRunner` to inject,
 * unlike `codex-plugin.ts`/`devin-plugin.ts`.
 *
 * Antigravity's own hook vocabulary and payload shape are genuinely new,
 * not a variant of anything else Coodra supports — see the module
 * docblock in `packages/shared/src/hooks/payloads/antigravity.ts` and
 * `adapters/antigravity.ts` for the full design rationale (only 5
 * events, camelCase protojson payloads, no field identifying which
 * event fired, a richer allow/deny/ask/force_ask decision vocabulary,
 * PostToolUse's confirmed missing toolCall, Stop's inverted-wire-shape
 * continue semantics, and the PreInvocation→SessionStart synthesis for
 * the missing SessionStart event).
 */
export interface AntigravityPluginPaths {
  readonly pluginRoot: string;
  readonly manifestPath: string;
  readonly mcpPath: string;
  readonly hooksPath: string;
  readonly hookRunnerPath: string;
  readonly skillsRoot: string;
}

export function antigravityPluginPaths(userHome: string): AntigravityPluginPaths {
  const pluginRoot = join(userHome, '.gemini', 'config', 'plugins', ANTIGRAVITY_PLUGIN_NAME);
  return {
    pluginRoot,
    // NOT nested under a dotfolder, unlike Cursor's `.cursor-plugin/
    // plugin.json` or Devin's `.devin-plugin/plugin.json` — the bundled
    // plugins.md shows `plugin.json` directly at the plugin root.
    manifestPath: join(pluginRoot, 'plugin.json'),
    mcpPath: join(pluginRoot, 'mcp_config.json'),
    hooksPath: join(pluginRoot, 'hooks.json'),
    hookRunnerPath: join(pluginRoot, 'hooks', 'hook-runner.mjs'),
    skillsRoot: join(pluginRoot, 'skills'),
  };
}

export function buildAntigravityPluginMcpEntry(ctx: AgentContext): CoodraMcpEntry {
  return buildCoodraMcpEntry({ ...ctx.mcpEntryOptions, agentType: 'antigravity' });
}

export async function probeAntigravityPlugin(ctx: AgentPathContext): Promise<{
  readonly manifest: boolean;
  readonly mcp: boolean;
  readonly hooks: boolean;
  readonly skills: boolean;
  readonly paths: AntigravityPluginPaths;
}> {
  const paths = antigravityPluginPaths(ctx.userHome);
  const [manifest, mcp, hooks, coodraContextSkill, coodraWikiSkillFile] = await Promise.all([
    fileContains(paths.manifestPath, `"name": "${ANTIGRAVITY_PLUGIN_NAME}"`),
    fileContainsAll(paths.mcpPath, [`"coodra"`, `"graphify"`]),
    fileContains(paths.hooksPath, `"PreToolUse"`),
    fileContains(join(paths.skillsRoot, 'coodra-context', 'SKILL.md'), 'name: coodra-context'),
    fileContains(join(paths.skillsRoot, 'coodra-wiki', 'SKILL.md'), 'name: coodra-wiki'),
  ]);
  const skills = coodraContextSkill && coodraWikiSkillFile;
  return { manifest, mcp, hooks, skills, paths };
}

export async function installAntigravityPlugin(ctx: AgentContext): Promise<{
  readonly outcomes: WriteOutcome[];
  readonly paths: AntigravityPluginPaths;
}> {
  const coodraHome = ctx.mcpEntryOptions.coodraHome ?? join(ctx.userHome, '.coodra');
  const paths = antigravityPluginPaths(ctx.userHome);
  const mcpEntry = buildAntigravityPluginMcpEntry(ctx);
  const graphifyEntry = buildManagedGraphifyMcpEntry(coodraHome);
  const sourceFiles = new Map<string, string>([
    [paths.manifestPath, pluginManifest()],
    [paths.mcpPath, `${JSON.stringify({ mcpServers: { coodra: mcpEntry, graphify: graphifyEntry } }, null, 2)}\n`],
    [paths.hooksPath, `${JSON.stringify(hooksConfig(paths.hookRunnerPath), null, 2)}\n`],
    [paths.hookRunnerPath, hookRunner()],
    [join(paths.skillsRoot, 'coodra-init', 'SKILL.md'), coodraInitSkill()],
    [join(paths.skillsRoot, 'coodra-context', 'SKILL.md'), coodraContextSkill()],
    [join(paths.skillsRoot, 'coodra-recipe', 'SKILL.md'), coodraSkillSkill()],
    [join(paths.skillsRoot, 'coodra-wiki', 'SKILL.md'), coodraWikiSkill()],
    [join(paths.skillsRoot, 'coodra-graphify', 'SKILL.md'), coodraGraphifySkill()],
    [join(paths.skillsRoot, 'coodra-work', 'SKILL.md'), coodraWorkSkill()],
  ]);

  const outcomes: WriteOutcome[] = [];
  for (const [path, content] of sourceFiles) {
    outcomes.push(await writeGenerated(path, content, ctx.force, ctx.dryRun));
  }
  return { outcomes, paths };
}

export async function removeAntigravityPlugin(ctx: AgentRemoveContext): Promise<{
  readonly outcomes: WriteOutcome[];
  readonly paths: AntigravityPluginPaths;
}> {
  const paths = antigravityPluginPaths(ctx.userHome);
  // The whole directory is exclusively Coodra's own subdirectory of
  // `~/.gemini/config/plugins/` — no shared registry file to preserve,
  // same as Cursor's own local plugin directory.
  const outcome = await removePath(paths.pluginRoot, ctx.dryRun, 'removed Coodra Antigravity plugin');
  return { outcomes: [outcome], paths };
}

async function removePath(path: string, dryRun: boolean, note: string): Promise<WriteOutcome> {
  try {
    await access(path);
    if (!dryRun) await rm(path, { recursive: true });
    return { path, action: 'merged', notes: note };
  } catch {
    return { path, action: 'unchanged', notes: 'path does not exist; nothing to remove' };
  }
}

async function writeGenerated(path: string, content: string, force: boolean, dryRun: boolean): Promise<WriteOutcome> {
  try {
    const existing = await readFile(path, 'utf8');
    if (existing === content)
      return { path, action: 'unchanged', notes: 'already matches Coodra Antigravity plugin baseline' };
    if (!force) {
      return { path, action: 'unchanged', notes: 'exists with local changes; pass --force to overwrite' };
    }
    if (!dryRun) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    }
    return { path, action: 'forced', notes: 'overwrote with Coodra Antigravity plugin baseline' };
  } catch {
    if (!dryRun) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    }
    return { path, action: 'wrote', notes: 'created Coodra Antigravity plugin file' };
  }
}

/**
 * Deliberately minimal, matching the bundled doc's documented schema
 * exactly (`{"name": "..."}` is the only field shown) rather than the
 * richer manifest (description/version/author/keywords/mcpServers/
 * skills pointers) Claude/Codex/Cursor/Devin get — those extra fields
 * are Coodra's own elaboration that those platforms happen to tolerate;
 * Antigravity's own docs show no such tolerance documented, so this
 * plugin doesn't risk it.
 */
function pluginManifest(): string {
  return `${JSON.stringify({ name: ANTIGRAVITY_PLUGIN_NAME }, null, 2)}\n`;
}

/**
 * Antigravity's MCP tool-name shape in the matcher namespace is
 * genuinely unconfirmed — the bundled hooks doc states native tool
 * names are "the step type lowercased, `CORTEX_STEP_TYPE_` prefix
 * removed" (`run_command`, `view_file`, `browser_*`), but never shows an
 * example of how an MCP-server-sourced tool call is named. Rather than
 * guess a prefix convention that might be wrong, this matcher stays
 * deliberately broad — the real filter is the server-side
 * `isCoodraOwnMcpTool`/bare-name backstop in the mcp-server's
 * `lifecycle_event` handler (extended for `agentType: 'antigravity'`).
 */
const TOOL_MATCHER = '*' as const;

/**
 * Antigravity hooks are pure command hooks (stdin/stdout JSON) — see the
 * bundled `hooks.md`. The file format is `{"<hookName>": {event: [...]}}`
 * — `"coodra"` is our own choice of hook name, mirroring the bundled
 * doc's own `"lint-checker"`/`"safety-gate"` examples. `PreToolUse`/
 * `PostToolUse` need the `matcher`+`hooks` wrapper; `PreInvocation`/
 * `PostInvocation`/`Stop` are FLAT arrays of handler objects directly
 * (matcher is ignored for these per the bundled doc's own event table).
 *
 * Antigravity's payload never states which event just fired (see
 * `payloads/antigravity.ts`'s module docblock) — each event's `command`
 * string carries the event name as an explicit trailing arg
 * (`hooks.md` confirms `command` runs via `sh -c`, so a trailing arg is
 * ordinary, safe shell mechanics), and `hookRunner()` reads it back from
 * `process.argv[2]`.
 */
function hooksConfig(hookRunnerPath: string): unknown {
  const cmd = (event: string) => `node "${hookRunnerPath}" ${event}`;
  return {
    coodra: {
      PreToolUse: [{ matcher: TOOL_MATCHER, hooks: [{ type: 'command', command: cmd('PreToolUse'), timeout: 10 }] }],
      PostToolUse: [{ matcher: TOOL_MATCHER, hooks: [{ type: 'command', command: cmd('PostToolUse'), timeout: 10 }] }],
      PreInvocation: [{ type: 'command', command: cmd('PreInvocation'), timeout: 10 }],
      PostInvocation: [{ type: 'command', command: cmd('PostInvocation'), timeout: 10 }],
      Stop: [{ type: 'command', command: cmd('Stop'), timeout: 10 }],
    },
  };
}

function hookRunner(): string {
  return commandHookRunner({
    agentType: 'antigravity',
    clientName: 'coodra-antigravity-hook-runner',
    mcpConfigFilename: 'mcp_config.json',
    enrichPayload: `
// Antigravity's own stdin payload never states which event just fired.
// hooks.json wires this command with the event name as a trailing arg per
// event key, so argv[2] is the normal source of truth. The payload
// fallback is kept for forward compatibility if Antigravity ever includes
// an embedded event name.
if (!payload || typeof payload !== 'object') {
  payload = {};
}
const eventName = process.argv[2] || payload.hook_event_name;
if (payload && typeof payload === 'object' && typeof eventName === 'string' && eventName.length > 0) {
  payload.hookEventName = eventName;
}
`,
  });
}

function coodraInitSkill(): string {
  return `---
name: coodra-init
description: Initialize or repair Coodra project state for the current repository using the project-local .coodra layout.
---

Use this skill when the user asks to initialize, register, repair, or inspect Coodra setup for a repository.

1. Inspect the repository root and current Coodra state under \`.coodra/\`.
2. Run \`coodra init\` to create or repair project-local Coodra files.
3. Confirm that setup created \`.coodra/config.json\`, \`.coodra/manifest.json\`, \`.coodra/recipes/\`, \`.coodra/graphify/\`, and \`.coodra/wiki/\`.
4. Do not create legacy root-level \`.coodra.json\`, \`.mcp.json\`, project \`.env\`, \`.cursorrules\`, or \`AGENTS.md\` for Coodra setup.
`;
}

function coodraContextSkill(): string {
  return `---
name: coodra-context
description: Retrieve and use Coodra project context, decisions, run history, and context packs before making code changes.
---

Use this skill before implementation when the task may depend on repository architecture, previous decisions, Work Pack state, or policy history.

1. Prefer Coodra MCP tools for live project context when available.
2. Read \`.coodra/config.json\` and \`.coodra/manifest.json\` to identify the project.
3. Review relevant context packs and recent decisions before editing.
4. Keep generated Coodra state under \`.coodra/\`.
`;
}

function coodraSkillSkill(): string {
  return `---
name: coodra-recipe
description: Find and apply project Coodra Agent Recipes such as API development, security audit, plugin-building, or language best-practice workflows.
---

Use this skill when the user asks for a reusable project Agent Recipe, or when a task clearly matches one.

1. Look for project Agent Recipes under \`.coodra/recipes/\`.
2. Use \`coodra__list_recipes\` to inspect available recipes.
3. Load a matching recipe with \`coodra__get_recipe\`; do not load every recipe blindly.
4. Treat Agent Recipes as reusable task guidance, not issue-bound Work Packs.
5. Apply the chosen recipe's instructions before implementing.
`;
}

function coodraWikiSkill(): string {
  return `---
name: coodra-wiki
description: Use this when the user asks to generate, update, refresh, inspect, or use the Coodra project wiki / Deep Wiki / codebase wiki / architecture docs for this project (e.g. "generate the deep wiki", "build the wiki", "document the architecture"), or wants wiki-grounded implementation context. Drives the two-pass Coodra Wiki flow end to end — this is the only wiki skill; there is no separate "deep wiki author" skill.
---

Use this skill when the user asks for wiki generation, architecture documentation, codebase explanations, or wiki-grounded implementation context.

1. If \`.coodra/wiki/job.md\` or \`.coodra/wiki/grounding.md\` is missing, run \`coodra wiki build\` first. That command creates the bounded grounding bundle and includes Graphify communities, god nodes, and \`GRAPH_REPORT.md\` when \`.coodra/graphify/out/graph.json\` exists.
2. Read \`.coodra/wiki/job.md\` and \`.coodra/wiki/grounding.md\` before planning — \`job.md\` contains the full two-pass authoring recipe (plan the structure, then author each page). Treat the Graphify section as the first structural map; do not start by recursively scanning the whole repo unless the grounding explicitly says the file list is truncated or a page needs verification.
3. When the managed Graphify MCP server is available, query it without \`project_path\` for neighbours/dependency paths that the grounding summary does not already include.
4. Save wiki structure/pages through Coodra's \`wiki_save_structure\`, \`wiki_save_page\`, and \`wiki_status\` MCP tools before writing mirror files.
5. Mirror successful saves under \`.coodra/wiki/<slug>/structure.json\` and \`.coodra/wiki/<slug>/md/<pageId>.md\` (the latter is a connected-Markdown mirror — real frontmatter plus rendered cross-links — that \`coodra wiki ask\` reads directly).
6. Derive the wiki shape from this repo's real graph, domains, and workflows rather than a fixed template.
7. Use existing wiki records as grounding, but verify claims against targeted source files before editing.
8. When the user asks a how-does-X-work question about this repo and \`.coodra/wiki/<slug>/md/\` already has pages (or \`coodra wiki status\` shows authored pages), run \`coodra wiki ask "<question>"\` first instead of re-scanning the whole repo. Read the ranked files/excerpts it returns and answer from them, citing the wiki page(s) you used.
`;
}

function coodraGraphifySkill(): string {
  return `---
name: coodra-graphify
description: Build, inspect, or use Graphify codebase graph artifacts managed by Coodra under .coodra/graphify.
---

Use this skill when the user asks to graphify a repository, use the code graph, inspect graph artifacts, or make the assistant always consult the graph.

1. Prefer Coodra-managed Graphify output under \`.coodra/graphify/out/\`.
2. Build with \`coodra graphify build\`; it sets \`GRAPHIFY_OUT=.coodra/graphify/out\` and records generated artifacts.
3. Do not inspect or print environment variables to discover LLM keys unless the user explicitly asks. If a semantic build fails because Graphify lacks a backend, explain that the external Graphify process cannot automatically borrow this session, then fall back to \`coodra graphify build --no-llm\` for a structural graph.
4. When querying the managed Graphify MCP server installed by the Coodra plugin, omit \`project_path\` unless the user has explicitly wired a custom Graphify server. The managed plugin entry already points at \`.coodra/graphify/out/graph.json\`; passing \`project_path\` can make Graphify append its stock \`graphify-out/\` path and miss the Coodra-managed graph.
5. Treat \`coodra graphify status\` legacy config rows as explicit/custom wiring only. Native Coodra plugin wiring is managed by \`coodra agent add <agent>\` / \`coodra agent repair <agent>\`.
6. Use Graphify artifacts as context before broad architecture, dependency, wiki, or refactor work.
7. Do not leave new Graphify output in root-level \`graphify-out/\` unless the user explicitly asks.
`;
}

function coodraWorkSkill(): string {
  return `---
name: coodra-work
description: Start or resume a Coodra Work Pack — from a Jira issue, a GitHub/GitLab PR, or a manually-created pack.
---

Use this skill when the user asks to work on, import, resume, or implement something through Coodra: a tracker issue (Jira, Linear, ...), a GitHub/GitLab PR, or a manually-scoped piece of work with no external reference at all.

## Model

A Work Pack has a canonical \`packType\` (epic, feature, story, task, bug, subtask, pr, or unknown) — Coodra's own normalized classification, independent of the provider. Keep the provider's own raw type label in \`source.issueType\` (e.g. Jira "Story", GitHub "pull_request") so nothing is lost. \`source.provider\` records where it came from: \`atlassian\`, \`github\`, \`gitlab\`, or \`manual\`. The same split applies to status: normalize into \`status\` (draft, in_progress, in_review, blocked, or done); keep the provider's own raw status label in \`source.status\`.

There is no persistent Coodra config for which project or key to use — the external reference is whatever the user typed this time, or whatever the current run is already bound to (step 2 below may already surface one to resume). If the reference is wrong or doesn't exist, the provider's own MCP will report that; Coodra does not pre-validate its shape.

## Resolve and implement

1. Call \`coodra__get_run_id\` if you do not already have the current \`runId\`.
2. Call \`coodra__work_pack_status { runId }\` and inspect any existing local Work Pack — SessionStart context may already have surfaced one to resume.
3. If the user gave an external reference, fetch it via whichever MCP the agent already has for that provider — Atlassian Rovo for a Jira key, GitHub's MCP for a PR, GitLab's for an MR. Do not ask Coodra for provider credentials, and do not call Coodra as a provider client. If the user gave no reference, this is a manually-created pack: set \`source.provider\` to \`manual\` and synthesize a reasonable \`source.externalKey\` (e.g. the pack slug).
4. Call \`coodra__work_pack_upsert\` (packType + source per the model above) before editing code. If related work matters — parent/epic, subtasks, blockers, same-epic tasks, or a linked PR — fetch it bounded and record it in \`relationships\`.
5. Call \`coodra__save_context_pack\` with \`workPackSlug\` set to the slug to create the initial linked Context Pack.
6. Implement the change using \`.coodra/work-packs/<slug>/\` as the local work record. Call \`coodra__record_decision\` for material choices as you go — the sync-back step below reads these back. If a decision also matters to a related pack (not just this one), pass \`workPackSlugs\` on that call to tag it there too.
7. Finish with a concise user-facing recap, and call \`coodra__save_context_pack\` yourself with \`workPackSlug\` set and a recap of what changed — SessionEnd does not auto-save this for you.

## Sync-back (only when the user asks, or the pack is ready to close)

Do not use \`prepare_jira_comment\` — it is superseded. Instead call \`coodra__query_decisions { projectSlug, workPackId }\` (spans every run tied to this pack, not just the current session; add \`includeRelated: true\` to also pull decisions from related packs) to gather everything recorded, compose your own natural-language summary directly from the returned decisions — no Coodra template — and post it using whichever comment tool the agent's own provider MCP exposes (Rovo's \`addCommentToJiraIssue\`, GitHub's PR-comment tool, GitLab's MR-comment tool). Always confirm the exact text and target with the user before posting.
`;
}

async function fileContains(path: string, needle: string): Promise<boolean> {
  try {
    return (await readFile(path, 'utf8')).includes(needle);
  } catch {
    return false;
  }
}

async function fileContainsAll(path: string, needles: readonly string[]): Promise<boolean> {
  try {
    const content = await readFile(path, 'utf8');
    return needles.every((needle) => content.includes(needle));
  } catch {
    return false;
  }
}
