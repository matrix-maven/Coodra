import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { resolveCoodraHome } from '../coodra-home.js';
import { detectProjectRoot } from '../detect.js';
import { buildCoodraMcpEntry, mergeMcpJson } from '../init/mcp-merge.js';
import type { WriteOutcome } from '../init/types.js';
import { readProjectConfig } from '../project-store/config.js';
import { bundledMigrationsDir, resolveRuntimeBinary } from '../runtime-paths.js';
import { readTeamConfig } from '../team-config.js';
import type { AgentContext } from './types.js';

/**
 * Builds the shared `AgentContext` the adapters need to wire an agent —
 * the standalone counterpart to the inline resolution `coodra init` does
 * (mcp-server binary, bundled migrations dir, LOCAL_HOOK_SECRET, bridge
 * port, solo/team mode + DATABASE_URL). Keeping this here lets
 * `coodra agent add/repair` wire an agent WITHOUT re-running project init.
 * Codex uses this context to generate its global plugin `.mcp.json`; legacy
 * adapters still use it for their existing config files while their native
 * plugin features land.
 */

export interface ResolveAgentContextOptions {
  /** Project root. Default: walk up from process.cwd() to the nearest marker. */
  readonly cwd?: string;
  /** $HOME override (tests). */
  readonly userHome?: string;
  /** ~/.coodra override (tests). */
  readonly coodraHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly force: boolean;
  readonly dryRun: boolean;
  /** ~/.claude/settings.json override (tests). */
  readonly settingsPath?: string;
}

export interface ResolvedAgentWiring {
  readonly context: AgentContext;
  readonly coodraHome: string;
  readonly projectRoot: string;
  readonly projectSlug: string;
  readonly mode: 'solo' | 'team';
}

/**
 * Read the project slug via the shared project-store reader
 * (`.coodra/config.json`); default to the directory name when it is absent.
 */
async function readProjectSlug(root: string): Promise<string> {
  const cfg = await readProjectConfig(root);
  return cfg?.projectSlug ?? basename(root);
}

function portFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

export async function resolveAgentWiringContext(opts: ResolveAgentContextOptions): Promise<ResolvedAgentWiring> {
  const env = opts.env ?? process.env;
  const userHome = opts.userHome ?? homedir();
  const projectRoot = opts.cwd ?? (await detectProjectRoot(process.cwd(), { homeDir: userHome })).root;
  const coodraHome = resolveCoodraHome({
    ...(opts.coodraHome !== undefined ? { override: opts.coodraHome } : {}),
    env,
  });
  const machineCfg = readTeamConfig({ homeOverride: coodraHome });

  // mcp-server runtime binary — throws with a structured message when the
  // bundle can't be resolved; the caller surfaces it as a clean CLI error.
  const mcpServerBin = (await resolveRuntimeBinary('mcp-server')).path;

  const bundledMigrations = bundledMigrationsDir('sqlite');
  const migrationsDir =
    bundledMigrations !== null ? bundledMigrations.replace(/\/sqlite$/, '').replace(/\\sqlite$/, '') : null;

  // Reuse the daemon's LOCAL_HOOK_SECRET so the Claude hook header and the
  // bridge agree (see init.ts F1/F.6+). Fall back to a fresh secret only when
  // ~/.coodra/.env has none yet.
  let localHookSecret: string;
  try {
    const homeRaw = await readFile(join(coodraHome, '.env'), 'utf8');
    localHookSecret = homeRaw.match(/^LOCAL_HOOK_SECRET=(\S+)/m)?.[1] ?? randomBytes(32).toString('hex');
  } catch {
    localHookSecret = randomBytes(32).toString('hex');
  }

  const bridgePort = portFromEnv(env, 'HOOKS_BRIDGE_PORT', 3101);
  const databaseUrl = machineCfg.mode === 'team' && machineCfg.team !== undefined ? env.DATABASE_URL : undefined;
  const projectSlug = await readProjectSlug(projectRoot);

  const context: AgentContext = {
    cwd: projectRoot,
    userHome,
    projectSlug,
    bridgePort,
    localHookSecret,
    mcpEntryOptions: {
      mcpServerBin,
      clerkSecretKey: env.CLERK_SECRET_KEY ?? 'sk_test_replace_me',
      migrationsDir,
      coodraHome,
      mode: machineCfg.mode,
      ...(typeof databaseUrl === 'string' && databaseUrl.length > 0 ? { databaseUrl } : {}),
      localHookSecret,
    },
    ...(opts.settingsPath !== undefined ? { settingsPath: opts.settingsPath } : {}),
    force: opts.force,
    dryRun: opts.dryRun,
  };

  return { context, coodraHome, projectRoot, projectSlug, mode: machineCfg.mode };
}

/**
 * Ensure `<cwd>/.mcp.json` carries the legacy project-level Coodra MCP
 * registration for adapters that still need it. Codex does not call this path;
 * it gets MCP through its native global plugin.
 */
export async function ensureProjectMcpJson(ctx: AgentContext): Promise<WriteOutcome> {
  const entry = buildCoodraMcpEntry({ ...ctx.mcpEntryOptions, agentType: 'claude_code' });
  return mergeMcpJson({ cwd: ctx.cwd, entry, force: ctx.force, dryRun: ctx.dryRun });
}
