import { join } from 'node:path';
import { resolveCoodraLogsDir } from './coodra-home.js';
import type { DaemonUnit } from './daemon/index.js';
import { loadHomeEnv } from './load-home-env.js';
import { bundledMigrationsDir, resolveRuntimeBinary } from './runtime-paths.js';

export type ServiceName = 'mcp-server' | 'hooks-bridge' | 'sync-daemon' | 'web';

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
  /** Worker only launches when COODRA_MODE=team (DATABASE_URL set). */
  readonly requiresTeamMode: true;
}

export type ServiceDescriptor = HttpServiceDescriptor | WorkerServiceDescriptor;

export const SERVICES: readonly ServiceDescriptor[] = [
  {
    kind: 'http',
    name: 'mcp-server',
    displayName: 'Coodra MCP Server',
    port: 3100,
    defaultPort: 3100,
    relativeEntry: 'apps/mcp-server/dist/index.js',
    healthUrl: (port) => `http://127.0.0.1:${port}/healthz`,
  },
  {
    kind: 'http',
    name: 'hooks-bridge',
    displayName: 'Coodra Hooks Bridge',
    port: 3101,
    defaultPort: 3101,
    relativeEntry: 'apps/hooks-bridge/dist/index.js',
    healthUrl: (port) => `http://127.0.0.1:${port}/healthz`,
  },
  {
    kind: 'worker',
    name: 'sync-daemon',
    displayName: 'Coodra Sync Daemon',
    relativeEntry: 'apps/sync-daemon/dist/index.js',
    requiresTeamMode: true,
  },
  {
    // Web Bundle W1 (2026-05-13). The Next.js standalone server. Runs in
    // both solo and team mode; the page tree handles mode-awareness via
    // `lib/deployment-mode.ts` and the role helpers from Phase G.
    //
    // Port 3001 is the long-established dev port (apps/web-v2/package.json's
    // `next dev --port 3001`) and what every Phase G/H install link
    // hard-codes. /api/healthz is a public GET that returns
    // `{ ok: true, service: 'web-v2', deploymentMode, timestamp }`.
    kind: 'http',
    name: 'web',
    displayName: 'Coodra Web',
    port: 3001,
    defaultPort: 3001,
    relativeEntry: 'apps/web-v2/.next/standalone/apps/web-v2/server.js',
    healthUrl: (port) => `http://127.0.0.1:${port}/api/healthz`,
  },
];

export interface BuildServiceUnitOptions {
  readonly coodraHome: string;
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
 * resolveRuntimeBinary` — bundled (`@coodra/cli/dist/runtime/<app>/
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
  //   1. `<COODRA_HOME>/.env`  — user-global defaults
  //   2. `<process.cwd()>/.env`   — per-project overrides (this is where
  //                                 `coodra init` writes)
  //   3. options.env (process.env) — explicit shell exports always win
  // The two-file split matters because `init` writes (2) but commit
  // 34faa0e's first cut only read (1); the .env init wrote was therefore
  // decorative end-to-end and team-mode setups silently fell back to solo.
  // See `loadHomeEnv` for the layering rationale.
  const layered = loadHomeEnv(options.coodraHome, process.cwd());
  const env: NodeJS.ProcessEnv = { ...layered, ...options.env };
  const mcpPort = parsePort(env.MCP_SERVER_PORT, 3100);
  const bridgePort = parsePort(env.HOOKS_BRIDGE_PORT, 3101);
  // COODRA_WEB_PORT — env override path for the rare case the user
  // already runs something on 3001 (e.g. an unrelated Next.js dev server).
  // Default matches apps/web-v2/package.json's dev port.
  const webPort = parsePort(env.COODRA_WEB_PORT, 3001);

  const logsDir = resolveCoodraLogsDir(options.coodraHome);
  const isTeamMode = env.COODRA_MODE === 'team';
  const resolved: ResolvedService[] = [];
  for (const descriptor of SERVICES) {
    // Module 04a: skip workers that require team mode when in solo. The
    // sync-daemon has no purpose without DATABASE_URL.
    if (descriptor.kind === 'worker' && descriptor.requiresTeamMode && !isTeamMode) continue;

    let port: number | null = null;
    if (descriptor.kind === 'http') {
      if (descriptor.name === 'mcp-server') port = mcpPort;
      else if (descriptor.name === 'hooks-bridge') port = bridgePort;
      else if (descriptor.name === 'web') port = webPort;
    }
    const resolvedBin = await resolveRuntimeBinary(descriptor.name);
    const entryPath = resolvedBin.path;
    const entrySource = resolvedBin.source;
    const unitEnv = buildServiceEnv({
      env,
      coodraHome: options.coodraHome,
      port,
      name: descriptor.name,
      entrySource,
    });
    // pino → stderr per COODRA_LOG_DESTINATION; both streams routed into
    // <coodra-home>/logs/<name>.log so doctor check 8 can read them and
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
  readonly coodraHome: string;
  readonly port: number | null;
  readonly name: ServiceName;
  readonly entrySource: 'bundled' | 'monorepo';
}): Record<string, string> {
  const env: Record<string, string> = {
    COODRA_LOG_DESTINATION: 'stderr',
    COODRA_HOME: args.coodraHome,
  };
  // When the binary is the bundled artifact under @coodra/cli/dist/
  // runtime/, the embedded `@coodra/db::MIGRATIONS_FOLDER` cannot
  // self-locate the SQL files (workspace-relative `..` walks land
  // outside the bundle). The bundler co-ships drizzle/ next to the
  // app bundles; this env var pins the parent directory so the
  // migrator finds it.
  if (args.entrySource === 'bundled') {
    const bundled = bundledMigrationsDir('sqlite');
    if (bundled !== null) {
      env.COODRA_MIGRATIONS_DIR = bundled.replace(/\/sqlite$/, '').replace(/\\sqlite$/, '');
    }
  }
  const FORWARD_LITERAL = new Set(['LOCAL_HOOK_SECRET', 'DATABASE_URL']);
  const RESERVED = new Set([
    'COODRA_LOG_DESTINATION',
    'COODRA_HOME',
    'COODRA_MIGRATIONS_DIR',
    'MCP_SERVER_PORT',
    'MCP_SERVER_TRANSPORT',
    'MCP_SERVER_HOST',
    'HOOKS_BRIDGE_PORT',
    'HOOKS_BRIDGE_HOST',
    // Web (W1 2026-05-13): standalone server reads PORT/HOSTNAME directly.
    // NODE_ENV must be 'production' so Next picks the prebuilt server (the
    // standalone bundle has no source maps / HMR baked in).
    'PORT',
    'HOSTNAME',
    'NODE_ENV',
  ]);
  for (const [key, value] of Object.entries(args.env)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (RESERVED.has(key)) continue;
    if (key.startsWith('COODRA_') || key.startsWith('CLERK_') || FORWARD_LITERAL.has(key)) {
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
  } else if (args.name === 'web' && args.port !== null) {
    // Bind to `localhost` (not raw `127.0.0.1`) so the listener binds
    // both IPv4 and IPv6 loopback, matching the kernel's preferred
    // resolution. W4 (2026-05-13) — discovered that with HOSTNAME=
    // 127.0.0.1, Next.js's team-mode internal proxy (Clerk middleware
    // path) fails with EADDRNOTAVAIL when COODRA_PUBLIC_URL=
    // http://localhost:3001 because `localhost` resolves to ::1 on
    // recent macOS / many Linux distros, but the server only listens
    // on 127.0.0.1 → connect fails → /api/healthz returns 500. Using
    // `localhost` as the bind hostname lets Node match the system's
    // own loopback resolution.
    //
    // Security: `localhost` is still loopback-only on standard
    // /etc/hosts setups (127.0.0.1 + ::1 only). The web is NOT
    // externally reachable; W4's tunnel is the explicit public path.
    env.PORT = String(args.port);
    env.HOSTNAME = 'localhost';
    env.NODE_ENV = 'production';
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
