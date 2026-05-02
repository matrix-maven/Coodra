import { join, resolve } from 'node:path';
import { resolveContextosLogsDir } from './contextos-home.js';
import type { DaemonUnit } from './daemon/index.js';
import { loadHomeEnv } from './load-home-env.js';
import { bundledMigrationsDir, resolveRuntimeBinary } from './runtime-paths.js';

export type ServiceName = 'mcp-server' | 'hooks-bridge' | 'sync-daemon';

/**
 * Service descriptors are a discriminated union: HTTP services bind to
 * a port and expose `/healthz`; worker services (sync-daemon, M04a)
 * expose no port and are tracked via the daemon-manager's PID file.
 */
export interface HttpServiceDescriptor {
  readonly kind: 'http';
  readonly name: ServiceName;
  readonly displayName: string;
  readonly port: number;
  readonly defaultPort: number;
  readonly relativeEntry: string;
  readonly healthUrl: (port: number) => string;
}

export interface WorkerServiceDescriptor {
  readonly kind: 'worker';
  readonly name: ServiceName;
  readonly displayName: string;
  readonly relativeEntry: string;
  /** Worker only launches when CONTEXTOS_MODE=team (DATABASE_URL set). */
  readonly requiresTeamMode: true;
}

export type ServiceDescriptor = HttpServiceDescriptor | WorkerServiceDescriptor;

export const SERVICES: readonly ServiceDescriptor[] = [
  {
    kind: 'http',
    name: 'mcp-server',
    displayName: 'ContextOS MCP Server',
    port: 3100,
    defaultPort: 3100,
    relativeEntry: 'apps/mcp-server/dist/index.js',
    healthUrl: (port) => `http://127.0.0.1:${port}/healthz`,
  },
  {
    kind: 'http',
    name: 'hooks-bridge',
    displayName: 'ContextOS Hooks Bridge',
    port: 3101,
    defaultPort: 3101,
    relativeEntry: 'apps/hooks-bridge/dist/index.js',
    healthUrl: (port) => `http://127.0.0.1:${port}/healthz`,
  },
  {
    kind: 'worker',
    name: 'sync-daemon',
    displayName: 'ContextOS Sync Daemon',
    relativeEntry: 'apps/sync-daemon/dist/index.js',
    requiresTeamMode: true,
  },
];

export interface BuildServiceUnitOptions {
  readonly contextosHome: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface ResolvedService {
  readonly descriptor: ServiceDescriptor;
  readonly entryPath: string;
  /** Present only for HTTP services. Workers report `null`. */
  readonly port: number | null;
  readonly unit: DaemonUnit;
}

/**
 * Build the DaemonUnit each service runs as. The mcp-server and
 * hooks-bridge binary paths come from `lib/runtime-paths.ts::
 * resolveRuntimeBinary` — bundled (`@coodra/contextos-cli/dist/runtime/<app>/
 * index.js`) when available, monorepo dev path
 * (`apps/<app>/dist/index.js`) as fallback. Pre dec_83ba10c1 this
 * threw outright when no monorepo was detected; bundled artifacts in
 * the published tarball mean the throw path now only fires when the
 * dev contributor has not built the apps yet.
 *
 * The sync-daemon (worker, team-mode-only) ships the same way; v1
 * skips it in solo mode so the resolver is never called.
 */
export async function resolveServices(options: BuildServiceUnitOptions): Promise<ResolvedService[]> {
  // Layer the env, low → high precedence:
  //   1. `<CONTEXTOS_HOME>/.env`  — user-global defaults
  //   2. `<process.cwd()>/.env`   — per-project overrides (this is where
  //                                 `contextos init` writes)
  //   3. options.env (process.env) — explicit shell exports always win
  // The two-file split matters because `init` writes (2) but commit
  // 34faa0e's first cut only read (1); the .env init wrote was therefore
  // decorative end-to-end and team-mode setups silently fell back to solo.
  // See `loadHomeEnv` for the layering rationale.
  const layered = loadHomeEnv(options.contextosHome, process.cwd());
  const env: NodeJS.ProcessEnv = { ...layered, ...options.env };
  const mcpPort = parsePort(env.MCP_SERVER_PORT, 3100);
  const bridgePort = parsePort(env.HOOKS_BRIDGE_PORT, 3101);

  const logsDir = resolveContextosLogsDir(options.contextosHome);
  const isTeamMode = env.CONTEXTOS_MODE === 'team';
  const resolved: ResolvedService[] = [];
  for (const descriptor of SERVICES) {
    // Module 04a: skip workers that require team mode when in solo. The
    // sync-daemon has no purpose without DATABASE_URL.
    if (descriptor.kind === 'worker' && descriptor.requiresTeamMode && !isTeamMode) continue;

    const port = descriptor.kind === 'http' ? (descriptor.name === 'mcp-server' ? mcpPort : bridgePort) : null;
    let entryPath: string;
    let entrySource: 'bundled' | 'monorepo';
    if (descriptor.name === 'sync-daemon') {
      // Worker has no `runtime/` bundle yet — solo mode skips it above
      // and team-mode self-host runs from the monorepo for v1.0.
      // Maintain legacy resolution via `relativeEntry` for now.
      entryPath = resolve(options.contextosHome, '..', descriptor.relativeEntry);
      entrySource = 'monorepo';
    } else {
      const runtimeApp = descriptor.name as 'mcp-server' | 'hooks-bridge';
      const resolvedBin = await resolveRuntimeBinary(runtimeApp);
      entryPath = resolvedBin.path;
      entrySource = resolvedBin.source;
    }
    const unitEnv = buildServiceEnv({
      env,
      contextosHome: options.contextosHome,
      port,
      name: descriptor.name,
      entrySource,
    });
    // pino → stderr per CONTEXTOS_LOG_DESTINATION; both streams routed into
    // <contextos-home>/logs/<name>.log so doctor check 8 can read them and
    // field debugging is possible (vs the pre-fix /dev/null sink).
    const stdoutPath = join(logsDir, `${descriptor.name}.log`);
    const stderrPath = join(logsDir, `${descriptor.name}.log`);
    // Working directory: the daemons are env-driven and don't care about
    // cwd. Anchor to the user's project root (process.cwd) so any
    // accidental relative-path lookup lands somewhere sensible.
    const workingDir = process.cwd();
    const unit: DaemonUnit = {
      name: descriptor.name,
      command: process.execPath,
      args: [entryPath],
      env: unitEnv,
      workingDir,
      stdoutPath,
      stderrPath,
    };
    resolved.push({ descriptor, entryPath, port, unit });
  }
  return resolved;
}

function buildServiceEnv(args: {
  readonly env: NodeJS.ProcessEnv;
  readonly contextosHome: string;
  readonly port: number | null;
  readonly name: ServiceName;
  readonly entrySource: 'bundled' | 'monorepo';
}): Record<string, string> {
  const env: Record<string, string> = {
    CONTEXTOS_LOG_DESTINATION: 'stderr',
    CONTEXTOS_HOME: args.contextosHome,
  };
  // When the binary is the bundled artifact under @coodra/contextos-cli/dist/
  // runtime/, the embedded `@coodra/contextos-db::MIGRATIONS_FOLDER` cannot
  // self-locate the SQL files (workspace-relative `..` walks land
  // outside the bundle). The bundler co-ships drizzle/ next to the
  // app bundles; this env var pins the parent directory so the
  // migrator finds it.
  if (args.entrySource === 'bundled') {
    const bundled = bundledMigrationsDir('sqlite');
    if (bundled !== null) {
      env.CONTEXTOS_MIGRATIONS_DIR = bundled.replace(/\/sqlite$/, '').replace(/\\sqlite$/, '');
    }
  }
  const FORWARD_LITERAL = new Set(['LOCAL_HOOK_SECRET', 'DATABASE_URL']);
  const RESERVED = new Set([
    'CONTEXTOS_LOG_DESTINATION',
    'CONTEXTOS_HOME',
    'CONTEXTOS_MIGRATIONS_DIR',
    'MCP_SERVER_PORT',
    'MCP_SERVER_TRANSPORT',
    'MCP_SERVER_HOST',
    'HOOKS_BRIDGE_PORT',
    'HOOKS_BRIDGE_HOST',
  ]);
  for (const [key, value] of Object.entries(args.env)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (RESERVED.has(key)) continue;
    if (key.startsWith('CONTEXTOS_') || key.startsWith('CLERK_') || FORWARD_LITERAL.has(key)) {
      env[key] = value;
    }
  }
  if (args.name === 'mcp-server' && args.port !== null) {
    env.MCP_SERVER_PORT = String(args.port);
    env.MCP_SERVER_TRANSPORT = 'http';
    env.MCP_SERVER_HOST = '127.0.0.1';
  } else if (args.name === 'hooks-bridge' && args.port !== null) {
    env.HOOKS_BRIDGE_PORT = String(args.port);
    env.HOOKS_BRIDGE_HOST = '127.0.0.1';
  }
  // sync-daemon: no port-bound env. DATABASE_URL is forwarded via the
  // FORWARD_LITERAL pattern above; the daemon's env validation (Zod)
  // refuses to boot without it.
  return env;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return fallback;
  return parsed;
}
