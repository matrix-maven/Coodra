import { EXIT_OK } from '../exit-codes.js';
import { resolveCoodraHome } from '../lib/coodra-home.js';
import { selectDaemonManager } from '../lib/daemon/index.js';
import { SERVICES, type ServiceName } from '../lib/services.js';
import { clearTunnelUrlFromHomeEnv, stopTunnelByPid } from '../lib/tunnel.js';
import { commandTitle, pc, terminalWidth } from '../ui/index.js';

export interface StopOptions {
  readonly service?: string;
  readonly uninstall?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}

export interface StopIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_STOP_IO: StopIO = {
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

export async function runStopCommand(options: StopOptions = {}, io: StopIO = DEFAULT_STOP_IO): Promise<never> {
  io.writeStdout(`${commandTitle('Stop', 'halt Coodra daemons', { width: terminalWidth() })}\n`);
  const env = options.env ?? process.env;
  const coodraHome = resolveCoodraHome({
    ...(options.home !== undefined ? { override: options.home } : {}),
    env,
  });
  const manager = await selectDaemonManager({ coodraHome });

  const target = options.service;
  const candidates =
    target === undefined ? SERVICES.map((s) => s.name) : SERVICES.map((s) => s.name).filter((n) => n === target);
  if (candidates.length === 0) {
    io.writeStderr(`${pc.red('coodra stop')}: unknown service '${target}'.\n`);
    return io.exit(EXIT_OK); // stop is idempotent — unknown service is a no-op
  }

  for (const name of candidates as ServiceName[]) {
    try {
      await manager.stop(name);
      if (options.uninstall === true) {
        await manager.uninstall(name);
      }
      io.writeStdout(`${pc.green('✓')} Stopped ${name}\n`);
    } catch (err) {
      io.writeStderr(`${pc.yellow('⚠')} ${name} stop reported: ${(err as Error).message}\n`);
    }
  }

  // W4 (2026-05-13) — tear down the Cloudflare quick-tunnel if one is
  // running. The tunnel state pointer lives in `~/.coodra/tunnel.json`;
  // `start --tunnel` wrote it (PID + URL + startedAt). Stop runs in a
  // different process so we can't share the QuickTunnel object; the
  // PID file is the handoff.
  //
  // Also unwind COODRA_PUBLIC_URL from `~/.coodra/.env` — quick-
  // tunnel URLs are ephemeral, leaving the dead hostname there would
  // make future `coodra invite` mint URLs that 404 the moment a
  // teammate clicks them.
  //
  // Only fires when stop is called without `--service <name>` (i.e.,
  // the full stop), since `--service web` is a targeted op that may
  // leave the tunnel orphaned by user choice.
  if (target === undefined) {
    const result = stopTunnelByPid(coodraHome);
    if (result.stopped) {
      io.writeStdout(`${pc.green('✓')} Stopped cloudflared tunnel (pid ${result.pid})\n`);
    } else if (result.pid !== null) {
      io.writeStdout(`${pc.gray('·')} cloudflared tunnel pid ${result.pid} already gone; cleaned up state\n`);
    }
    clearTunnelUrlFromHomeEnv(coodraHome);
  }

  return io.exit(EXIT_OK);
}
