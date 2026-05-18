import { join } from 'node:path';
import { EXIT_OK, EXIT_SERVICE_STARTUP_FAILED, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { resolveCoodraHome, resolveCoodraLogsDir } from '../lib/coodra-home.js';
import { selectDaemonManager } from '../lib/daemon/index.js';
import { loadHomeEnv } from '../lib/load-home-env.js';
import { type ResolvedService, resolveServices } from '../lib/services.js';
import { detectCloudflared, startQuickTunnel, writeTunnelState, writeTunnelUrlToHomeEnv } from '../lib/tunnel.js';
import { waitForHealth } from '../lib/wait-for-health.js';
import { commandTitle, pc, terminalWidth } from '../ui/index.js';

export interface StartOptions {
  readonly mcp?: boolean;
  readonly hooks?: boolean;
  readonly sync?: boolean;
  /** W1 (2026-05-13) — `--no-web` flag opts out of the bundled Next.js standalone server. */
  readonly web?: boolean;
  /**
   * W4 (2026-05-13) — `--tunnel` spawns a Cloudflare quick-tunnel that
   * publishes the bundled web on a `https://*.trycloudflare.com` URL.
   * Cross-machine teammates can then click the install link the admin
   * shares. cloudflared must be on PATH; the start command degrades
   * gracefully (warning + EXIT 0) when it isn't.
   */
  readonly tunnel?: boolean;
  readonly foreground?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly waitTimeoutMs?: number;
}

export interface StartIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_START_IO: StartIO = {
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

export async function runStartCommand(options: StartOptions = {}, io: StartIO = DEFAULT_START_IO): Promise<never> {
  const processEnv = options.env ?? process.env;

  if (options.foreground === true) {
    io.writeStderr(
      `${pc.yellow('coodra start --foreground')}: not implemented in 08a — for foreground debug use ` +
        '`pnpm --filter @coodra/{mcp-server,hooks-bridge} dev` directly per docs/DEVELOPMENT.md.\n',
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  io.writeStdout(`${commandTitle('Start', 'launch Coodra daemons', { width: terminalWidth() })}\n`);

  const coodraHome = resolveCoodraHome({
    ...(options.home !== undefined ? { override: options.home } : {}),
    env: processEnv,
  });

  // Merge `~/.coodra/.env` (plus the project's `.env` if cwd is a
  // registered project) under the parent shell's env so that service
  // resolution sees COODRA_MODE=team / DATABASE_URL / LOCAL_HOOK_SECRET
  // even when the operator didn't `source` the file before running
  // `coodra start`. Without this merge the sync-daemon silently
  // never launches in team mode — the team install flow writes
  // COODRA_MODE=team to `~/.coodra/.env` but never to the shell,
  // so a fresh terminal post-`team install` would only see solo. Process
  // env wins on conflicts so operators can still pin overrides via
  // `COODRA_MODE=solo coodra start` etc.
  const homeEnvOverlay = loadHomeEnv(coodraHome);
  const env: NodeJS.ProcessEnv = { ...homeEnvOverlay, ...processEnv };

  let resolved: ResolvedService[];
  try {
    resolved = await resolveServices({ coodraHome, env });
  } catch (err) {
    io.writeStderr(`${pc.red('coodra start')}: ${(err as Error).message}\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  // W5 / beta.5 (2026-05-13) — team-mode env preflight. If
  // COODRA_MODE=team but DATABASE_URL is missing/empty, the
  // sync-daemon's Zod env validation throws on boot. systemd/launchd
  // dutifully restart it, hit the restart rate-limiter after ~5 tries,
  // and leave a permanently-failed unit + a log full of identical
  // ValidationError stacks — with no signal to the operator about WHY.
  //
  // Catch it here: a missing DATABASE_URL in team mode means team
  // setup never completed (e.g. `coodra team init` failed at the
  // Postgres step, or only `coodra login` ran). Print one clear
  // actionable line and SKIP the sync-daemon — the MCP server, Hooks
  // Bridge, and Web still come up, so the machine is usable while the
  // operator finishes team setup.
  const teamMode = env.COODRA_MODE === 'team';
  const databaseUrl = env.DATABASE_URL;
  const teamSetupIncomplete = teamMode && (typeof databaseUrl !== 'string' || databaseUrl.trim().length === 0);
  if (teamSetupIncomplete) {
    io.writeStderr(
      `${pc.yellow('⚠')} ${pc.bold('COODRA_MODE=team')} but ${pc.bold('DATABASE_URL')} is not set in ` +
        `${pc.cyan('~/.coodra/.env')}.\n` +
        `  Team setup is incomplete — the Sync Daemon needs a cloud Postgres URL.\n` +
        `  Finish setup with ${pc.cyan('coodra team init')} (it writes DATABASE_URL + Clerk keys + local config).\n` +
        `  ${pc.gray('Skipping the Sync Daemon for now; MCP server + Hooks Bridge + Web will still start.')}\n`,
    );
  }

  const skip = (name: string): boolean =>
    (name === 'mcp-server' && options.mcp === false) ||
    (name === 'hooks-bridge' && options.hooks === false) ||
    (name === 'sync-daemon' && (options.sync === false || teamSetupIncomplete)) ||
    (name === 'web' && options.web === false);

  const manager = await selectDaemonManager({ coodraHome });
  io.writeStdout(`${pc.gray(`Using ${manager.kind} daemon manager.`)}\n`);

  let anyFailure = false;

  for (const service of resolved) {
    if (skip(service.descriptor.name)) {
      const reason =
        service.descriptor.name === 'sync-daemon' && teamSetupIncomplete && options.sync !== false
          ? 'team setup incomplete — see warning above'
          : `--no-${service.descriptor.name}`;
      io.writeStdout(`${pc.gray('·')} Skipping ${service.descriptor.displayName} (${reason}).\n`);
      continue;
    }
    try {
      await manager.install(service.unit);
      await manager.start(service.descriptor.name);
    } catch (err) {
      io.writeStderr(`${pc.red('✗')} Failed to start ${service.descriptor.displayName}: ${(err as Error).message}\n`);
      anyFailure = true;
      continue;
    }
    if (service.descriptor.kind === 'http' && service.port !== null) {
      // Phase H.7 — bump the default health-wait from 10s to 30s. The
      // mcp-server's first cold boot under launchd consistently took
      // 12-15s in the 2026-05-12 live test (COODRA_HOME resolution
      // + SQLite init + tool registry load); a 10s window flagged
      // healthy services as failed. 30s is the right floor.
      const healthy = await waitForHealth({
        url: service.descriptor.healthUrl(service.port),
        timeoutMs: options.waitTimeoutMs ?? 30_000,
      });
      if (healthy) {
        io.writeStdout(`${pc.green('✓')} ${service.descriptor.displayName} listening on :${service.port}\n`);
      } else {
        io.writeStderr(
          `${pc.red('✗')} ${service.descriptor.displayName} did not become healthy on :${service.port} within ${options.waitTimeoutMs ?? 30_000}ms\n`,
        );
        anyFailure = true;
      }
    } else {
      // Worker (sync-daemon): no /healthz to poll. The daemon manager's
      // start() already wrote the PID file; trust that for now. The
      // doctor's queue-depth checks (M03.1 21–23 + M04a 24–27 in S5)
      // surface anything weirder.
      io.writeStdout(`${pc.green('✓')} ${service.descriptor.displayName} started\n`);
    }
  }

  if (anyFailure) {
    io.writeStderr(`${pc.red('Start failed.')} Run \`coodra doctor\` for diagnostics.\n`);
    return io.exit(EXIT_SERVICE_STARTUP_FAILED);
  }
  io.writeStdout(`${pc.green('All Coodra services running.')}\n`);

  // W4 (2026-05-13) — optional Cloudflare quick-tunnel. Runs only when
  // `--tunnel` is set, AFTER every daemon is healthy. Failures here are
  // never fatal: the local web is already up, the tunnel is purely a
  // shareability nicety. Print install instructions on missing
  // cloudflared, then fall through to a clean EXIT_OK.
  if (options.tunnel === true) {
    const tunnelUrl = await orchestrateTunnel({ coodraHome, io });
    // beta.8 (2026-05-18) — when the tunnel produces a URL, re-install
    // the web service so its plist picks up the freshly-written
    // COODRA_PUBLIC_URL from ~/.coodra/.env. Without this, the running
    // web process keeps the env it inherited at boot (no
    // COODRA_PUBLIC_URL set), its `resolveDeploymentBaseUrl()` falls
    // through to the COODRA_HOME local fallback (returning
    // http://localhost:3001), and invite URLs / JWT iss claims / web
    // cli.sh render all use localhost — making cross-machine
    // /api/install/<token> redemption fail with iss-mismatch.
    if (tunnelUrl !== null) {
      await reinstallWebForTunnel({ coodraHome, manager, io });
    }
  }

  return io.exit(EXIT_OK);
}

async function orchestrateTunnel(args: { readonly coodraHome: string; readonly io: StartIO }): Promise<string | null> {
  const { io } = args;
  const lookup = await detectCloudflared();
  if (lookup === null) {
    io.writeStdout(
      `\n${pc.yellow('⚠')} ${pc.bold('--tunnel')} requested but ${pc.cyan('cloudflared')} is not on PATH.\n` +
        `  Install it and re-run \`coodra start --tunnel\`:\n` +
        `    macOS:  ${pc.cyan('brew install cloudflared')}\n` +
        `    Linux:  ${pc.cyan('curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared')}\n` +
        `  Local web is up on http://localhost:3001/; only public URL is missing.\n`,
    );
    return null;
  }

  io.writeStdout(`${pc.gray('Starting Cloudflare quick-tunnel …')}\n`);
  const logPath = join(resolveCoodraLogsDir(args.coodraHome), 'cloudflared.log');
  try {
    const tunnel = await startQuickTunnel({ localPort: 3001, logPath });
    writeTunnelUrlToHomeEnv(args.coodraHome, tunnel.url);
    writeTunnelState(args.coodraHome, {
      pid: tunnel.pid,
      url: tunnel.url,
      startedAt: Date.now(),
    });
    io.writeStdout(
      `${pc.green('✓')} Public tunnel: ${pc.cyan(tunnel.url)} → http://127.0.0.1:3001\n` +
        `  Invite URLs now use this host. Quick-tunnels expire when ` +
        `\`${pc.cyan('coodra stop')}\` runs.\n` +
        `  Log: ${pc.gray(tunnel.logPath)}\n`,
    );
    return tunnel.url;
  } catch (err) {
    io.writeStderr(
      `${pc.yellow('⚠')} Tunnel start failed: ${(err as Error).message}\n` +
        `  Local web is still up on http://127.0.0.1:3001/.\n`,
    );
    return null;
  }
}

/**
 * beta.8 (2026-05-18) — re-install the `web` service after the tunnel URL is
 * captured.
 *
 * Why: the daemon manager bootstrap runs BEFORE the tunnel (cloudflared
 * targets `http://127.0.0.1:3001`, which has to be live first). At that
 * point `~/.coodra/.env` has no `COODRA_PUBLIC_URL` so the launchd plist
 * is generated without it. Once the tunnel exists, `orchestrateTunnel`
 * writes `COODRA_PUBLIC_URL=<tunnel-url>` to `.env` — but the running
 * web process's env is already frozen, and launchd's view of the plist
 * env is too. `resolveDeploymentBaseUrl()` inside the web then falls
 * through to the `COODRA_HOME` local fallback (returning
 * `http://localhost:3001`), and EVERY surface that reads it — invite
 * URLs the web's `mintInviteAction` builds, the `/install/<token>/cli.sh`
 * route, the JWT `iss` claim issuer comparison on `/api/install/<token>`
 * — disagrees with the URL the admin is sharing.
 *
 * The fix is to re-load env, re-resolve services (so the web's
 * DaemonUnit.env now includes the tunnel URL), and re-install + restart
 * just the web service. Cloudflared's tunnel target (loopback :3001)
 * tolerates a brief outage; the new web binds within ~2 seconds and the
 * tunnel resumes proxying transparently.
 */
async function reinstallWebForTunnel(args: {
  readonly coodraHome: string;
  readonly manager: {
    install(unit: import('../lib/daemon/types.js').DaemonUnit): Promise<void>;
    start(name: string): Promise<void>;
    stop(name: string): Promise<void>;
  };
  readonly io: StartIO;
}): Promise<void> {
  const { coodraHome, manager, io } = args;
  io.writeStdout(`${pc.gray('Reloading web with tunnel URL in env …')}\n`);
  const layered = loadHomeEnv(coodraHome, process.cwd());
  const env = { ...process.env, ...layered };
  let resolved: ResolvedService[];
  try {
    resolved = await resolveServices({ coodraHome, env });
  } catch (err) {
    io.writeStderr(`${pc.yellow('⚠')} Web reload after tunnel skipped: ${(err as Error).message}\n`);
    return;
  }
  const web = resolved.find((s) => s.descriptor.name === 'web');
  if (web === undefined) return;
  try {
    await manager.stop('web');
    await manager.install(web.unit);
    await manager.start('web');
    if (web.descriptor.kind === 'http' && web.port !== null) {
      await waitForHealth({ url: web.descriptor.healthUrl(web.port), timeoutMs: 30_000 });
    }
    io.writeStdout(
      `${pc.green('✓')} Web reloaded; invite URLs + JWT iss + /install/<token>/cli.sh now use the tunnel host.\n`,
    );
  } catch (err) {
    io.writeStderr(
      `${pc.yellow('⚠')} Web reload after tunnel failed: ${(err as Error).message}\n` +
        `  Workaround: manually add COODRA_PUBLIC_URL to ~/Library/LaunchAgents/com.coodra.web.plist and launchctl bootout/bootstrap.\n`,
    );
  }
}
