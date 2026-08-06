import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { resolveCoodraHome } from '../coodra-home.js';
import { detectProjectRoot } from '../detect.js';
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
 * Native adapters use this context to generate plugin-scoped MCP files;
 * non-native adapters use their own agent-specific config files. Coodra does
 * not create or manage a repo-root `.mcp.json`.
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
  /** `ClaudeCliRunner` override (tests) — see `AgentPathContext.claudeCliRunner`. */
  readonly claudeCliRunner?: unknown;
  /** `CodexCliRunner` override (tests) — see `AgentPathContext.codexCliRunner`. */
  readonly codexCliRunner?: unknown;
  /** `DevinCliRunner` override (tests) — see `AgentPathContext.devinCliRunner`. */
  readonly devinCliRunner?: unknown;
  /** Interactive-prompt override (tests) — see `AgentPathContext.readPrompt`. */
  readonly readPrompt?: ((prompt: string) => Promise<string>) | false;
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
    ...(opts.claudeCliRunner !== undefined ? { claudeCliRunner: opts.claudeCliRunner } : {}),
    ...(opts.codexCliRunner !== undefined ? { codexCliRunner: opts.codexCliRunner } : {}),
    // Both were previously accepted by `ResolveAgentContextOptions`'
    // caller (`commands/agent.ts` already spread `devinCliRunner` into
    // this function's input) but silently dropped here — the option
    // never reached `AgentContext`, so any override passed at the
    // command layer (e.g. a test's fake `DevinCliRunner`) never actually
    // took effect once the call went through `resolveAgentWiringContext`
    // rather than calling `installDevinPlugin` directly. Fixed alongside
    // adding `readPrompt`, which needs the exact same forwarding.
    ...(opts.devinCliRunner !== undefined ? { devinCliRunner: opts.devinCliRunner } : {}),
    ...(opts.readPrompt !== undefined ? { readPrompt: opts.readPrompt } : {}),
    force: opts.force,
    dryRun: opts.dryRun,
  };

  return { context, coodraHome, projectRoot, projectSlug, mode: machineCfg.mode };
}
