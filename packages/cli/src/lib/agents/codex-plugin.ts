import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { VERSION } from '../../version.js';
import { buildCoodraMcpEntry, type CoodraMcpEntry } from '../init/mcp-merge.js';
import type { WriteOutcome } from '../init/types.js';
import { buildManagedGraphifyMcpEntry } from './managed-capabilities.js';
import type { AgentContext, AgentPathContext, AgentRemoveContext } from './types.js';

export const CODEX_PLUGIN_NAME = 'coodra' as const;

export interface CodexPluginPaths {
  readonly marketplaceRoot: string;
  readonly marketplacePath: string;
  readonly pluginRoot: string;
  readonly manifestPath: string;
  readonly mcpPath: string;
  readonly hooksPath: string;
  readonly hookRunnerPath: string;
  readonly skillsRoot: string;
}

export function codexPluginPaths(userHome: string): CodexPluginPaths {
  const marketplaceRoot = join(userHome, '.agents', 'plugins');
  const pluginRoot = join(userHome, '.codex', 'plugins', CODEX_PLUGIN_NAME);
  const skillsRoot = join(pluginRoot, 'skills');
  return {
    marketplaceRoot,
    marketplacePath: join(marketplaceRoot, 'marketplace.json'),
    pluginRoot,
    manifestPath: join(pluginRoot, '.codex-plugin', 'plugin.json'),
    mcpPath: join(pluginRoot, '.mcp.json'),
    hooksPath: join(pluginRoot, 'hooks', 'hooks.json'),
    hookRunnerPath: join(pluginRoot, 'hooks', 'hook-runner.mjs'),
    skillsRoot,
  };
}

export function buildCodexPluginMcpEntry(ctx: AgentContext): CoodraMcpEntry {
  return buildCoodraMcpEntry({ ...ctx.mcpEntryOptions, agentType: 'codex' });
}

export async function probeCodexPlugin(ctx: AgentPathContext): Promise<{
  readonly manifest: boolean;
  readonly marketplace: boolean;
  readonly mcp: boolean;
  readonly hooks: boolean;
  readonly skills: boolean;
  readonly paths: CodexPluginPaths;
}> {
  const paths = codexPluginPaths(ctx.userHome);
  const [manifest, marketplace, mcp, hooks, coodraContextSkill, coodraWikiSkillFile] = await Promise.all([
    fileContains(paths.manifestPath, `"name": "${CODEX_PLUGIN_NAME}"`),
    fileContains(paths.marketplacePath, `"name": "${CODEX_PLUGIN_NAME}"`),
    fileContainsAll(paths.mcpPath, [`"coodra"`, `"graphify"`]),
    fileContains(paths.hooksPath, `"SessionStart"`),
    fileContains(join(paths.skillsRoot, 'coodra-context', 'SKILL.md'), 'name: coodra-context'),
    fileContains(join(paths.skillsRoot, 'coodra-wiki', 'SKILL.md'), 'name: coodra-wiki'),
  ]);
  const skills = coodraContextSkill && coodraWikiSkillFile;
  return { manifest, marketplace, mcp, hooks, skills, paths };
}

export async function installCodexPlugin(ctx: AgentContext): Promise<{
  readonly outcomes: WriteOutcome[];
  readonly paths: CodexPluginPaths;
}> {
  const paths = codexPluginPaths(ctx.userHome);
  const mcpEntry = buildCodexPluginMcpEntry(ctx);
  const graphifyEntry = buildManagedGraphifyMcpEntry(ctx.mcpEntryOptions.coodraHome ?? join(ctx.userHome, '.coodra'));
  const files = new Map<string, string>([
    [paths.manifestPath, pluginManifest()],
    [paths.mcpPath, `${JSON.stringify({ mcpServers: { coodra: mcpEntry, graphify: graphifyEntry } }, null, 2)}\n`],
    [paths.hooksPath, `${JSON.stringify(hooksConfig(), null, 2)}\n`],
    [paths.hookRunnerPath, hookRunner()],
    [join(paths.skillsRoot, 'coodra-init', 'SKILL.md'), coodraInitSkill()],
    [join(paths.skillsRoot, 'coodra-context', 'SKILL.md'), coodraContextSkill()],
    [join(paths.skillsRoot, 'coodra-recipe', 'SKILL.md'), coodraSkillSkill()],
    [join(paths.skillsRoot, 'coodra-wiki', 'SKILL.md'), coodraWikiSkill()],
    [join(paths.skillsRoot, 'coodra-graphify', 'SKILL.md'), coodraGraphifySkill()],
    [join(paths.skillsRoot, 'coodra-jira-work', 'SKILL.md'), coodraJiraWorkSkill()],
    [paths.marketplacePath, await marketplaceJson(paths.marketplacePath)],
  ]);

  const outcomes: WriteOutcome[] = [];
  for (const [path, content] of files) {
    outcomes.push(await writeGenerated(path, content, ctx.force, ctx.dryRun));
  }
  return { outcomes, paths };
}

export async function removeCodexPlugin(ctx: AgentRemoveContext): Promise<{
  readonly outcomes: WriteOutcome[];
  readonly paths: CodexPluginPaths;
}> {
  const paths = codexPluginPaths(ctx.userHome);
  const outcomes: WriteOutcome[] = [];
  outcomes.push(await removeMarketplaceEntry(paths.marketplacePath, ctx.dryRun));
  outcomes.push(await removePath(paths.pluginRoot, ctx.dryRun, 'removed Coodra Codex plugin bundle'));
  return { outcomes, paths };
}

async function marketplaceJson(path: string): Promise<string> {
  const entry = {
    name: CODEX_PLUGIN_NAME,
    source: { source: 'local', path: './.codex/plugins/coodra' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Developer Tools',
  };
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as {
      name?: string;
      interface?: { displayName?: string };
      plugins?: unknown[];
      [key: string]: unknown;
    };
    const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : [];
    const filtered = plugins.filter((plugin) => {
      return !(
        typeof plugin === 'object' &&
        plugin !== null &&
        (plugin as { name?: unknown }).name === CODEX_PLUGIN_NAME
      );
    });
    return `${JSON.stringify(
      {
        name: typeof parsed.name === 'string' ? parsed.name : 'personal',
        interface:
          typeof parsed.interface === 'object' && parsed.interface !== null
            ? parsed.interface
            : { displayName: 'Personal' },
        ...parsed,
        plugins: [...filtered, entry],
      },
      null,
      2,
    )}\n`;
  } catch {
    return `${JSON.stringify({ name: 'personal', interface: { displayName: 'Personal' }, plugins: [entry] }, null, 2)}\n`;
  }
}

async function removeMarketplaceEntry(path: string, dryRun: boolean): Promise<WriteOutcome> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return { path, action: 'unchanged', notes: 'Codex personal marketplace does not exist; nothing to remove' };
  }

  const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : [];
  const filtered = plugins.filter((plugin) => {
    return !(
      typeof plugin === 'object' &&
      plugin !== null &&
      (plugin as { name?: unknown }).name === CODEX_PLUGIN_NAME
    );
  });
  if (filtered.length === plugins.length) {
    return { path, action: 'unchanged', notes: 'Coodra is not present in the Codex personal marketplace' };
  }

  if (!dryRun) await writeFile(path, `${JSON.stringify({ ...parsed, plugins: filtered }, null, 2)}\n`, 'utf8');
  return { path, action: 'merged', notes: 'removed Coodra from the Codex personal marketplace' };
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
      return { path, action: 'unchanged', notes: 'already matches Coodra Codex plugin baseline' };
    if (!force) {
      return { path, action: 'unchanged', notes: 'exists with local changes; pass --force to overwrite' };
    }
    if (!dryRun) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    }
    return { path, action: 'forced', notes: 'overwrote with Coodra Codex plugin baseline' };
  } catch {
    if (!dryRun) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    }
    return { path, action: 'wrote', notes: 'created Coodra Codex plugin file' };
  }
}

function pluginManifest(): string {
  return `${JSON.stringify(
    {
      name: CODEX_PLUGIN_NAME,
      version: VERSION,
      description: 'Coodra project memory, context packs, wiki, Graphify, policy, and Jira sync workflows for Codex.',
      author: { name: 'Coodra' },
      homepage: 'https://github.com/matrix-maven/Coodra',
      repository: 'https://github.com/matrix-maven/Coodra',
      license: 'MIT',
      keywords: ['coodra', 'codex', 'mcp', 'context', 'wiki', 'graphify', 'jira'],
      skills: './skills/',
      mcpServers: './.mcp.json',
      interface: {
        displayName: 'Coodra',
        shortDescription: 'Project memory and context for Codex',
        longDescription:
          'Use Coodra to initialize project state, retrieve context and Agent Recipes, consult the project wiki, use Graphify output, and sync implementation progress.',
        developerName: 'Coodra',
        category: 'Developer Tools',
        capabilities: ['Read', 'Write'],
        websiteURL: 'https://github.com/matrix-maven/Coodra',
        defaultPrompt: [
          'Initialize Coodra for this repository.',
          'Use Coodra context before implementing this change.',
          'Use the project wiki and Graphify graph before editing code.',
        ],
        brandColor: '#10A37F',
      },
    },
    null,
    2,
  )}\n`;
}

function hooksConfig(): unknown {
  const command = 'node "$PLUGIN_ROOT/hooks/hook-runner.mjs"';
  return {
    description: 'Coodra Codex plugin lifecycle hooks.',
    hooks: {
      SessionStart: [
        {
          matcher: 'startup|resume|clear|compact',
          hooks: [
            {
              type: 'command',
              command,
              statusMessage: 'Loading Coodra project context',
              additionalContextLimit: 3000,
              timeout: 10,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command,
              statusMessage: 'Checking Coodra context',
              additionalContextLimit: 3000,
              timeout: 10,
            },
          ],
        },
      ],
      ConfigChange: [
        {
          hooks: [
            {
              type: 'command',
              command,
              statusMessage: 'Checking Coodra policy projection',
              additionalContextLimit: 1000,
              timeout: 3,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: 'Bash|apply_patch|Edit|Write|mcp__.*',
          hooks: [
            {
              type: 'command',
              command,
              statusMessage: 'Checking Coodra policy',
              additionalContextLimit: 3000,
              timeout: 10,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Bash|apply_patch|Edit|Write|mcp__.*',
          hooks: [
            {
              type: 'command',
              command,
              statusMessage: 'Recording Coodra activity',
              additionalContextLimit: 3000,
              timeout: 10,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command,
              timeout: 10,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command,
              timeout: 3,
            },
          ],
        },
      ],
    },
  };
}

function hookRunner(): string {
  return `import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = process.env.PLUGIN_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
const MCP_REQUEST_TIMEOUT_MS = 8000;

function readStdin() {
  return new Promise((resolve) => {
    let body = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      body += chunk;
    });
    process.stdin.on('end', () => resolve(body));
  });
}

function failOpen(reason, hookEventName) {
  return {
    hookSpecificOutput: {
      ...(hookEventName ? { hookEventName } : {}),
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
    },
  };
}

function loadCoodraMcpEntry() {
  const mcpPath = join(PLUGIN_ROOT, '.mcp.json');
  const parsed = JSON.parse(readFileSync(mcpPath, 'utf8'));
  const servers = parsed.mcpServers || parsed.mcp_servers || parsed;
  const entry = servers && servers.coodra;
  if (!entry || typeof entry !== 'object' || typeof entry.command !== 'string') {
    throw new Error('coodra_mcp_entry_missing');
  }
  return {
    command: entry.command,
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
    env: entry.env && typeof entry.env === 'object' ? entry.env : {},
  };
}

function parseMcpResult(response) {
  const result = response && response.result;
  const structured = result && result.structuredContent;
  if (structured && typeof structured === 'object' && structured.hookOutput) {
    return structured.hookOutput;
  }
  const firstText = result && Array.isArray(result.content) ? result.content.find((c) => c.type === 'text') : null;
  if (firstText && typeof firstText.text === 'string') {
    const parsed = JSON.parse(firstText.text);
    if (parsed && typeof parsed === 'object' && parsed.hookOutput) return parsed.hookOutput;
  }
  throw new Error('coodra_lifecycle_output_missing');
}

function callLifecycleTool(rawPayload) {
  return new Promise((resolve, reject) => {
    const entry = loadCoodraMcpEntry();
    const child = spawn(entry.command, entry.args, {
      env: { ...process.env, ...entry.env, COODRA_LOG_DESTINATION: 'stderr' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('coodra_mcp_lifecycle_timeout'));
    }, MCP_REQUEST_TIMEOUT_MS);

    function send(message) {
      child.stdin.write(JSON.stringify(message) + '\\n');
    }

    function settleWith(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(value);
    }

    function settleError(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      reject(err);
    }

    child.on('error', settleError);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const idx = buffer.indexOf('\\n');
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
          send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'lifecycle_event', arguments: { agentType: 'codex', rawPayload } },
          });
        } else if (msg.id === 2) {
          if (msg.error) settleError(new Error(String(msg.error.message || 'coodra_lifecycle_tool_failed')));
          else settleWith(parseMcpResult(msg));
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'coodra-codex-hook-runner', version: '1.0.0' },
      },
    });
  });
}

const raw = await readStdin();
let payload;
try {
  payload = JSON.parse(raw || '{}');
} catch {
  process.stdout.write(JSON.stringify(failOpen('invalid_hook_payload')));
  process.exit(0);
}

try {
  const hookOutput = await callLifecycleTool(payload);
  process.stdout.write(JSON.stringify(hookOutput || {}));
} catch {
  process.stdout.write(JSON.stringify(failOpen('coodra_lifecycle_mcp_unavailable', payload.hook_event_name)));
}
`;
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
4. Do not create legacy root-level \`.coodra.json\`, \`.mcp.json\`, project \`.env\`, \`.codex/config.toml\`, or \`AGENTS.md\` for Coodra setup.
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
5. Mirror successful saves under \`.coodra/wiki/<slug>/structure.json\` and \`.coodra/wiki/<slug>/<pageId>.md\`.
6. Derive the wiki shape from this repo's real graph, domains, and workflows rather than a fixed template.
7. Use existing wiki records as grounding, but verify claims against targeted source files before editing.
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
3. Do not inspect or print environment variables to discover LLM keys unless the user explicitly asks. If a semantic build fails because Graphify lacks a backend, explain that the external Graphify process cannot automatically borrow this Codex chat session, then fall back to \`coodra graphify build --no-llm\` for a structural graph.
4. When querying the managed Graphify MCP server installed by the Coodra plugin, omit \`project_path\` unless the user has explicitly wired a custom Graphify server. The managed plugin entry already points at \`.coodra/graphify/out/graph.json\`; passing \`project_path\` can make Graphify append its stock \`graphify-out/\` path and miss the Coodra-managed graph.
5. Treat \`coodra graphify status\` legacy config rows as explicit/custom wiring only. Native Coodra plugin wiring is managed by \`coodra agent add <agent>\` / \`coodra agent repair <agent>\`.
6. Use Graphify artifacts as context before broad architecture, dependency, wiki, or refactor work.
7. Do not leave new Graphify output in root-level \`graphify-out/\` unless the user explicitly asks.
`;
}

function coodraJiraWorkSkill(): string {
  return `---
name: coodra-jira-work
description: Start or resume a Jira-linked Coodra Work Pack implementation session from a Jira key such as COOD-10.
---

Use this skill when the user asks to work on, import, resume, or implement a Jira issue through Coodra.

1. Parse the Jira key from the user request and derive the Work Pack slug by lowercasing it, for example \`COOD-10\` -> \`cood-10\`.
2. Call \`coodra__get_run_id\` if you do not already have the current \`runId\`.
3. Call \`coodra__work_pack_status { runId }\` and inspect any existing local Work Pack for that slug.
4. Use Atlassian Rovo MCP to fetch the Jira issue. If the user asked for related work, also fetch bounded parent/epic, subtasks, blockers, blocked-by links, and same-epic tasks relevant to implementation.
5. Call \`coodra__work_pack_upsert\` before editing code.
6. Call \`coodra__save_context_pack\` with \`workPackSlug\` set to the slug to create the initial linked Context Pack.
7. Implement the change using \`.coodra/work-packs/<slug>/\` as the local work record, call \`record_decision\` for material choices, and finish with a concise user-facing recap. The Coodra SessionEnd hook updates the linked Work Pack with the implementation overview and changed files.
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
