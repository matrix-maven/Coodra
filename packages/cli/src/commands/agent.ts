import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildPolicyProjection, GLOBAL_PROJECT_ID, listProjects, lookupProjectBySlug } from '@coodra/db';
import { type PolicyProjectionAgent, writePolicyProjectionFiles } from '@coodra/shared';
import { EXIT_ENVIRONMENT_PROBLEM, EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { claudePluginPaths } from '../lib/agents/claude-plugin.js';
import { codexPluginPaths } from '../lib/agents/codex-plugin.js';
import {
  ACCEPTED_AGENT_TOKENS,
  type AgentAdapter,
  type AgentStatus,
  listAdapters,
  resolveAgentInput,
  resolveAgentWiringContext,
} from '../lib/agents/index.js';
import { resolveCoodraDataDb } from '../lib/coodra-home.js';
import { detectProjectRoot } from '../lib/detect.js';
import type { WriteOutcome } from '../lib/init/types.js';
import { classifyMachineRuntimePath, recordMachineManifest } from '../lib/machine-store/manifest.js';
import { openLocalDb } from '../lib/open-local-db.js';
import { classifyGeneratedPath, recordManifestEntries } from '../lib/project-store/index.js';
import { commandTitle, hintLine, type KvRow, kvBlock, pc, sectionHead, terminalWidth } from '../ui/index.js';

/**
 * `coodra agent add|status|remove|repair` — the per-agent wiring surface,
 * driven by the AgentAdapter registry (lib/agents). Where `coodra init` wires
 * every detected agent in one onboarding pass, this command targets a single
 * agent (or `all` / `detected`) so a user who installs an IDE later — or whose
 * config drifted (e.g. hooks got stripped) — can re-wire just that one without
 * re-running the whole init.
 *
 *   add    <agent>  — wire the Coodra bundle for one agent (a global native
 *                     plugin for both Claude Code and Codex). Idempotent.
 *   repair <agent>  — force re-wire to the current baseline (drift/self-heal).
 *   remove <agent>  — strip ONLY this agent's Coodra-owned entries.
 *   status          — read-only per-agent wiring report (same data `coodra
 *                     agents` shows).
 *
 * `<agent>` accepts claude | codex | all | detected.
 */

export interface AgentCommandOptions {
  readonly force?: boolean;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  // Test / advanced overrides (mirror init/graphify conventions).
  readonly cwd?: string;
  readonly userHome?: string;
  readonly coodraHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly settingsPath?: string;
  /** `ClaudeCliRunner` override (tests) — see `AgentPathContext.claudeCliRunner`. */
  readonly claudeCliRunner?: unknown;
  /** `CodexCliRunner` override (tests) — see `AgentPathContext.codexCliRunner`. */
  readonly codexCliRunner?: unknown;
}

export interface AgentIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_AGENT_IO: AgentIO = {
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

interface AgentActionResult {
  readonly id: string;
  readonly label: string;
  readonly outcomes: WriteOutcome[];
  readonly note?: string;
  readonly error?: string;
}

function glyphForAction(action: string): string {
  if (action === 'failed') return pc.red('✗');
  if (action === 'unchanged') return pc.gray('—');
  return pc.green('•');
}

/** Resolve the positional `<agent>` to a set of adapters + display labels. */
async function resolveTargets(
  agentArg: string,
  userHome: string,
): Promise<{ ok: true; adapters: AgentAdapter[]; labelById: Map<string, string> } | { ok: false; error: string }> {
  const token = agentArg.trim().toLowerCase();
  const labelById = new Map<string, string>();

  if (token === 'all') {
    const adapters = [...listAdapters()];
    for (const a of adapters) labelById.set(a.id, a.displayName);
    return { ok: true, adapters, labelById };
  }
  if (token === 'detected') {
    const adapters: AgentAdapter[] = [];
    for (const a of listAdapters()) {
      const d = await a.detect(userHome);
      if (d.installed) {
        adapters.push(a);
        labelById.set(a.id, a.displayName);
      }
    }
    if (adapters.length === 0) {
      return {
        ok: false,
        error: 'No agents detected on this machine. Name one explicitly, e.g. `coodra agent add claude`.',
      };
    }
    return { ok: true, adapters, labelById };
  }

  const resolved = resolveAgentInput(token);
  if (resolved === null) {
    return {
      ok: false,
      error: `Unknown agent '${agentArg}'. Expected one of: ${ACCEPTED_AGENT_TOKENS.join(', ')}, all, detected.`,
    };
  }
  labelById.set(resolved.id, resolved.label);
  return { ok: true, adapters: [resolved.adapter], labelById };
}

// ---------------------------------------------------------------------------
// add / repair (repair = add with force)
// ---------------------------------------------------------------------------

async function runWire(
  agentArg: string,
  options: AgentCommandOptions,
  io: AgentIO,
  mode: 'add' | 'repair',
): Promise<never> {
  const json = options.json === true;
  const dryRun = options.dryRun === true;
  const force = options.force === true || mode === 'repair';
  const userHome = options.userHome ?? homedir();

  const targets = await resolveTargets(agentArg, userHome);
  if (!targets.ok) {
    if (json) io.writeStdout(`${JSON.stringify({ ok: false, error: targets.error }, null, 2)}\n`);
    else io.writeStderr(`${pc.red(`coodra agent ${mode}`)}: ${targets.error}\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  // Build the wiring context (mcp-server binary, secret, ports, mode). Throws
  // with a structured message when the runtime bundle can't be resolved.
  let resolved: Awaited<ReturnType<typeof resolveAgentWiringContext>>;
  try {
    resolved = await resolveAgentWiringContext({
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.userHome !== undefined ? { userHome: options.userHome } : {}),
      ...(options.coodraHome !== undefined ? { coodraHome: options.coodraHome } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.settingsPath !== undefined ? { settingsPath: options.settingsPath } : {}),
      ...(options.claudeCliRunner !== undefined ? { claudeCliRunner: options.claudeCliRunner } : {}),
      ...(options.codexCliRunner !== undefined ? { codexCliRunner: options.codexCliRunner } : {}),
      force,
      dryRun,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (json) io.writeStdout(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
    else io.writeStderr(`${pc.red(`coodra agent ${mode}`)}: ${msg}\n`);
    return io.exit(EXIT_ENVIRONMENT_PROBLEM);
  }

  const results: AgentActionResult[] = [];
  for (const adapter of targets.adapters) {
    const label = targets.labelById.get(adapter.id) ?? adapter.displayName;
    try {
      const outcomes = [...(await adapter.wire(resolved.context))];
      results.push({
        id: adapter.id,
        label,
        outcomes,
        ...(adapter.postWireNote !== undefined ? { note: adapter.postWireNote } : {}),
      });
    } catch (err) {
      results.push({ id: adapter.id, label, outcomes: [], error: err instanceof Error ? err.message : String(err) });
    }
  }

  try {
    const createdBy = `coodra agent ${mode} ${agentArg}`;
    const machinePaths: string[] = [];
    const installedAgents: Array<{ id: 'claude' | 'codex'; pluginPath: string; marketplacePath?: string }> = [];

    if (results.some((r) => r.id === 'claude' && r.error === undefined)) {
      const paths = claudePluginPaths(userHome, resolved.coodraHome);
      machinePaths.push(
        paths.settingsPath,
        paths.knownMarketplacesPath,
        paths.marketplaceRoot,
        paths.marketplacePath,
        paths.pluginRoot,
        paths.manifestPath,
        paths.mcpPath,
        paths.hooksPath,
        paths.skillsRoot,
        paths.cachePluginRoot,
        paths.cacheManifestPath,
        paths.cacheMcpPath,
        paths.cacheHooksPath,
        paths.cacheSkillsRoot,
        paths.readmePath,
      );
      installedAgents.push({ id: 'claude', pluginPath: paths.cachePluginRoot, marketplacePath: paths.marketplacePath });
    }

    if (results.some((r) => r.id === 'codex' && r.error === undefined)) {
      const paths = codexPluginPaths(userHome, resolved.coodraHome);
      machinePaths.push(
        paths.marketplaceRoot,
        paths.marketplacePath,
        paths.pluginRoot,
        paths.manifestPath,
        paths.mcpPath,
        paths.hooksPath,
        paths.hookRunnerPath,
        paths.skillsRoot,
      );
      installedAgents.push({
        id: 'codex',
        pluginPath: paths.pluginRoot,
        marketplacePath: paths.marketplacePath,
      });
    }

    if (machinePaths.length > 0 || installedAgents.length > 0) {
      await recordMachineManifest({
        home: resolved.coodraHome,
        entries: machinePaths.map((path) => classifyMachineRuntimePath(resolved.coodraHome, path, createdBy)),
        installedAgents,
        dryRun,
      });
    }
  } catch (err) {
    io.writeStderr(
      `${pc.yellow('⚠')} Could not update ~/.coodra/manifest.json: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  const projectionAgents = results
    .filter((r) => r.error === undefined && (r.id === 'codex' || r.id === 'claude'))
    .map((r) => r.id as PolicyProjectionAgent);
  const projectionOutcome =
    projectionAgents.length > 0
      ? await syncPolicyProjectionForAgents({
          resolved,
          agents: projectionAgents,
          dryRun,
          createdBy: `coodra agent ${mode} ${agentArg}`,
        })
      : null;

  if (json) {
    io.writeStdout(
      `${JSON.stringify(
        {
          ok: true,
          command: mode,
          projectRoot: resolved.projectRoot,
          mode: resolved.mode,
          dryRun,
          agents: results,
          ...(projectionOutcome !== null ? { policyProjection: projectionOutcome } : {}),
        },
        null,
        2,
      )}\n`,
    );
    return io.exit(EXIT_OK);
  }

  io.writeStdout(`${commandTitle('Agent', `${mode} · Coodra wiring`, { width: terminalWidth(), indent: 0 })}\n`);
  io.writeStdout(`  ${pc.gray(`project root: ${resolved.projectRoot}`)}${dryRun ? pc.gray('  (dry-run)') : ''}\n`);
  let slot = 1;
  for (const r of results) {
    io.writeStdout(`${sectionHead(String(slot).padStart(2, '0'), r.label)}\n`);
    slot += 1;
    if (r.error !== undefined) {
      io.writeStdout(`  ${pc.red('✗')} ${pc.red(`could not wire: ${r.error}`)}\n`);
      continue;
    }
    for (const o of r.outcomes) {
      io.writeStdout(`  ${glyphForAction(o.action)} ${o.path}: ${o.action} ${pc.gray(`(${o.notes ?? ''})`)}\n`);
    }
    if (r.note !== undefined) io.writeStdout(`  ${pc.gray(`→ ${r.note}`)}\n`);
  }
  if (projectionOutcome !== null) {
    if (projectionOutcome.written.length > 0) {
      io.writeStdout(`\n${pc.green('✓')} Policy projection synced for ${projectionOutcome.agents.join(', ')}\n`);
      for (const path of projectionOutcome.written) io.writeStdout(`  ${pc.gray(path)}\n`);
    } else if (projectionOutcome.skippedReason !== undefined) {
      io.writeStdout(`\n${pc.gray('=')} Policy projection skipped: ${projectionOutcome.skippedReason}\n`);
    }
  }
  io.writeStdout(
    `\n${hintLine(
      mode === 'add'
        ? 'Restart the agent to pick up new plugin/MCP/hooks surfaces. `coodra agent status` shows current wiring.'
        : 'Re-wired to the current baseline. Restart the agent to apply.',
    )}\n`,
  );
  return io.exit(EXIT_OK);
}

async function syncPolicyProjectionForAgents(args: {
  readonly resolved: Awaited<ReturnType<typeof resolveAgentWiringContext>>;
  readonly agents: readonly PolicyProjectionAgent[];
  readonly dryRun: boolean;
  readonly createdBy: string;
}): Promise<{ agents: readonly PolicyProjectionAgent[]; written: readonly string[]; skippedReason?: string }> {
  const uniqueAgents = [...new Set(args.agents)].sort();
  if (uniqueAgents.length === 0) return { agents: [], written: [] };
  if (args.dryRun) return { agents: uniqueAgents, written: [], skippedReason: 'dry run' };

  let handle: Awaited<ReturnType<typeof openLocalDb>>;
  try {
    handle = await openLocalDb(resolveCoodraDataDb(args.resolved.coodraHome));
  } catch (err) {
    return {
      agents: uniqueAgents,
      written: [],
      skippedReason: `local store is not ready; run coodra install/init first (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  try {
    const project = await lookupProjectBySlug(handle, args.resolved.projectSlug);
    if (project === null) {
      return {
        agents: uniqueAgents,
        written: [],
        skippedReason: await describeNoProjectHereReason(handle, args.resolved.projectRoot),
      };
    }
    const projection = await buildPolicyProjection(handle, { projectId: project.id, projectSlug: project.slug });
    const result = await writePolicyProjectionFiles(args.resolved.projectRoot, projection, { agents: uniqueAgents });
    const written = [result.codexPath, result.claudePath].filter((path): path is string => path !== undefined);
    if (written.length > 0) {
      await recordManifestEntries({
        root: args.resolved.projectRoot,
        projectSlug: args.resolved.projectSlug,
        entries: written.map((path) => classifyGeneratedPath(path, args.resolved.projectRoot, args.createdBy)),
        dryRun: false,
      });
    }
    return { agents: uniqueAgents, written };
  } catch (err) {
    return {
      agents: uniqueAgents,
      written: [],
      skippedReason: `policy projection sync skipped: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    handle.close();
  }
}

const MAX_LISTED_PROJECTS = 5;

/**
 * `coodra agent add` opportunistically syncs the CURRENT directory's policy
 * into the agent config it just wired — but the agent plugin install itself
 * is machine-global, so this command is routinely run from `~` or some other
 * directory that was never `coodra init`-ed. Naming that (often nonsensical)
 * cwd in the skip message, or a bare "run coodra init first" with no
 * indication of where, both read as instructions to init the wrong place.
 * List whatever projects ARE registered so the user can tell at a glance
 * whether this is "nothing registered anywhere yet" vs. "registered, just
 * not here — go there instead."
 */
async function describeNoProjectHereReason(
  handle: Awaited<ReturnType<typeof openLocalDb>>,
  cwd: string,
): Promise<string> {
  // Every migrated DB carries the `__global__` sentinel row (F7's
  // unregistered-cwd audit fallback) — it's never a real project a user
  // can cd into, so it would be a confusing false positive here.
  const registered = (await listProjects(handle)).filter((p) => p.id !== GLOBAL_PROJECT_ID);
  if (registered.length === 0) {
    return (
      'no Coodra project registered yet (the agent plugin above is already installed — that part is ' +
      "machine-global). Run `coodra init` in your project's repo folder, then `coodra agent add` there, to " +
      'sync its policy.'
    );
  }
  const names = registered.slice(0, MAX_LISTED_PROJECTS).map((p) => p.slug);
  const more = registered.length > MAX_LISTED_PROJECTS ? `, +${registered.length - MAX_LISTED_PROJECTS} more` : '';
  return (
    `not synced — ${cwd} isn't a registered Coodra project. ${registered.length} registered elsewhere: ` +
    `${names.join(', ')}${more}. cd into one and run \`coodra agent add\` again there, or run \`coodra init\` ` +
    'here to register this directory.'
  );
}

export function runAgentAddCommand(
  agentArg: string,
  options: AgentCommandOptions = {},
  io: AgentIO = DEFAULT_AGENT_IO,
) {
  return runWire(agentArg, options, io, 'add');
}

export function runAgentRepairCommand(
  agentArg: string,
  options: AgentCommandOptions = {},
  io: AgentIO = DEFAULT_AGENT_IO,
) {
  return runWire(agentArg, options, io, 'repair');
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

export async function runAgentRemoveCommand(
  agentArg: string,
  options: AgentCommandOptions = {},
  io: AgentIO = DEFAULT_AGENT_IO,
): Promise<never> {
  const json = options.json === true;
  const dryRun = options.dryRun === true;
  const userHome = options.userHome ?? homedir();
  const coodraHome = options.coodraHome ?? join(userHome, '.coodra');
  const cwd = options.cwd ?? (await detectProjectRoot(process.cwd(), { homeDir: userHome })).root;
  const bridgePort = portFromEnv(options.env ?? process.env, 'HOOKS_BRIDGE_PORT', 3101);

  const targets = await resolveTargets(agentArg, userHome);
  if (!targets.ok) {
    if (json) io.writeStdout(`${JSON.stringify({ ok: false, error: targets.error }, null, 2)}\n`);
    else io.writeStderr(`${pc.red('coodra agent remove')}: ${targets.error}\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  const removeCtx = {
    cwd,
    userHome,
    coodraHome,
    bridgePort,
    dryRun,
    ...(options.settingsPath !== undefined ? { settingsPath: options.settingsPath } : {}),
    ...(options.claudeCliRunner !== undefined ? { claudeCliRunner: options.claudeCliRunner } : {}),
    ...(options.codexCliRunner !== undefined ? { codexCliRunner: options.codexCliRunner } : {}),
  };

  const results: AgentActionResult[] = [];
  for (const adapter of targets.adapters) {
    const label = targets.labelById.get(adapter.id) ?? adapter.displayName;
    try {
      const outcomes = [...(await adapter.remove(removeCtx))];
      results.push({ id: adapter.id, label, outcomes });
    } catch (err) {
      results.push({ id: adapter.id, label, outcomes: [], error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (json) {
    io.writeStdout(
      `${JSON.stringify({ ok: true, command: 'remove', projectRoot: cwd, dryRun, agents: results }, null, 2)}\n`,
    );
    return io.exit(EXIT_OK);
  }

  io.writeStdout(`${commandTitle('Agent', 'remove · strip Coodra wiring', { width: terminalWidth(), indent: 0 })}\n`);
  io.writeStdout(`  ${pc.gray(`project root: ${cwd}`)}${dryRun ? pc.gray('  (dry-run)') : ''}\n`);
  let slot = 1;
  for (const r of results) {
    io.writeStdout(`${sectionHead(String(slot).padStart(2, '0'), r.label)}\n`);
    slot += 1;
    if (r.error !== undefined) {
      io.writeStdout(`  ${pc.red('✗')} ${pc.red(`could not remove: ${r.error}`)}\n`);
      continue;
    }
    for (const o of r.outcomes) {
      io.writeStdout(`  ${glyphForAction(o.action)} ${o.path}: ${o.action} ${pc.gray(`(${o.notes ?? ''})`)}\n`);
    }
  }
  return io.exit(EXIT_OK);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function runAgentStatusCommand(
  options: AgentCommandOptions = {},
  io: AgentIO = DEFAULT_AGENT_IO,
): Promise<never> {
  const json = options.json === true;
  const userHome = options.userHome ?? homedir();
  const cwd = options.cwd ?? (await detectProjectRoot(process.cwd(), { homeDir: userHome })).root;
  const pathCtx = {
    cwd,
    userHome,
    ...(options.settingsPath !== undefined ? { settingsPath: options.settingsPath } : {}),
    ...(options.claudeCliRunner !== undefined ? { claudeCliRunner: options.claudeCliRunner } : {}),
    ...(options.codexCliRunner !== undefined ? { codexCliRunner: options.codexCliRunner } : {}),
  };

  const statuses: AgentStatus[] = [];
  for (const adapter of listAdapters()) {
    statuses.push(await adapter.status(pathCtx));
  }

  if (json) {
    io.writeStdout(`${JSON.stringify({ ok: true, projectRoot: cwd, agents: statuses }, null, 2)}\n`);
    return io.exit(EXIT_OK);
  }

  io.writeStdout(`${commandTitle('Agent', 'wiring status', { width: terminalWidth(), indent: 0 })}\n`);
  let slot = 1;
  for (const s of statuses) {
    io.writeStdout(`${sectionHead(String(slot).padStart(2, '0'), s.displayName)}\n`);
    slot += 1;
    const detGlyph = s.detection.installed ? pc.green('✓') : pc.gray('✗');
    io.writeStdout(
      `  ${detGlyph} ${s.detection.detectionPath}  ${pc.gray(s.detection.installed ? '(detected)' : '(not installed)')}\n`,
    );
    const rows: KvRow[] = s.files.map((f) => ({
      glyph: f.state === 'wired' ? pc.green('✓') : f.state === 'partial' ? pc.yellow('◌') : pc.gray('✗'),
      key: f.label,
      value: `${f.state}${f.notes !== undefined ? ` — ${f.notes}` : ''}`,
    }));
    io.writeStdout(`${kvBlock(rows, { keyWidth: 42, indent: 2 })}\n`);
  }
  io.writeStdout(
    `\n${hintLine('`coodra agent add <agent>` to wire · `coodra agent repair <agent>` to re-baseline drift.')}\n`,
  );
  return io.exit(EXIT_OK);
}

function portFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}
