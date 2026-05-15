/**
 * W4 (2026-05-13) — Cloudflare quick-tunnel orchestration for
 * `coodra start --tunnel`. Quick-tunnels are ephemeral by design:
 * `cloudflared tunnel --url http://localhost:3001` allocates a fresh
 * `https://*.trycloudflare.com` URL with no Cloudflare account, no
 * named-tunnel setup, no DNS. The URL lives for the lifetime of the
 * spawned `cloudflared` process; killing it tears the tunnel down.
 *
 * Use case: the team admin's laptop becomes publicly reachable just
 * long enough to mint + share invite URLs. Teammates click the
 * `<tunnel>/install/<token>` link, complete the curl|sh + browser
 * sign-in flow, and end up with their OWN local web on their own
 * laptop. After install, neither party needs the admin's tunnel.
 *
 * The tunnel is NOT meant to be a persistent dashboard endpoint.
 * Quick-tunnels rotate every restart; teams that want a stable host
 * should set up a named tunnel (`cloudflared tunnel login` + plist)
 * separately — out of scope for W4.
 */

import type { ChildProcess } from 'node:child_process';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

import { removeEnvKey, upsertEnvKey } from './team-init/finalize-config.js';

export interface CloudflaredLookup {
  readonly path: string;
}

/**
 * Locate `cloudflared` on the user's PATH. Returns `null` when the
 * binary is missing — the caller is expected to print the install
 * instructions and degrade gracefully (local web still runs; no
 * public URL).
 */
export async function detectCloudflared(): Promise<CloudflaredLookup | null> {
  try {
    const { stdout } = await execFile('which', ['cloudflared']);
    const path = stdout.trim();
    if (path.length === 0 || !existsSync(path)) return null;
    return { path };
  } catch {
    return null;
  }
}

export interface StartQuickTunnelOptions {
  readonly localPort: number;
  /** Override for tests; defaults to 60_000. */
  readonly timeoutMs?: number;
  /**
   * Where to redirect cloudflared's stdout + stderr. Required: a real
   * file is the only way to keep the tunnel alive after the parent
   * process exits — piped stdio dies with the parent regardless of
   * `detached: true`.
   */
  readonly logPath: string;
}

export interface QuickTunnel {
  readonly url: string;
  readonly pid: number;
  /** Path to the file where cloudflared's stderr/stdout are tailing. */
  readonly logPath: string;
}

/**
 * Spawn `cloudflared tunnel --url http://localhost:<port> --no-autoupdate`,
 * scrape stderr for the printed `https://*.trycloudflare.com` URL, and
 * resolve with it. Throws after `timeoutMs` (default 60s) if the URL
 * never appears.
 *
 * Why stderr: cloudflared 2025+ writes log lines (incl. the tunnel URL
 * banner) to stderr and reserves stdout for "data" use cases. Parsing
 * stdout misses the URL entirely.
 */
/**
 * Spawn `cloudflared tunnel --url http://127.0.0.1:<port>` as a
 * detached background process with its stdout/stderr redirected to a
 * log file, then poll the log file until the `https://*.trycloudflare.com`
 * banner appears. Resolves with the URL + PID.
 *
 * Why the file-then-poll dance instead of just piping stderr through
 * Node: with piped stdio, cloudflared dies the moment the parent CLI
 * exits — Node closes the pipe, cloudflared gets EPIPE on its next
 * write, exits. Even `detached: true` doesn't save us because the
 * child still inherits the parent's controlling TTY through the pipe.
 *
 * Redirecting to a real file at spawn time means the child holds the
 * FD itself and never depends on the parent. Combined with
 * `detached: true` + `child.unref()`, this lets the parent CLI exit
 * cleanly while cloudflared keeps tunneling in its own session.
 *
 * Why 127.0.0.1 not localhost: on recent macOS, `localhost` resolves
 * preferentially to ::1 (IPv6) but the bundled web binds 127.0.0.1
 * (IPv4) — cloudflared then returns 530 to teammates. Hard-coding
 * the IPv4 loopback sidesteps the resolver mismatch.
 */
export async function startQuickTunnel(options: StartQuickTunnelOptions): Promise<QuickTunnel> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  mkdirSync(dirname(options.logPath), { recursive: true });
  // Truncate any prior log so the URL parse never matches a stale banner.
  writeFileSync(options.logPath, '', 'utf8');
  const fd = openSync(options.logPath, 'a');

  let child: ChildProcess;
  try {
    child = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${options.localPort}`, '--no-autoupdate'], {
      stdio: ['ignore', fd, fd],
      detached: true,
    });
  } catch (err) {
    throw new Error(`cloudflared spawn failed: ${(err as Error).message}`);
  }

  const childPid = child.pid;
  if (typeof childPid !== 'number') {
    child.kill();
    throw new Error('cloudflared spawn returned no PID');
  }

  // Detach completely. The child holds its own fd → log file; we don't
  // need to wait on it. After unref(), the parent's event loop is free
  // to exit even with the (now-orphaned) child still tunneling.
  child.unref();

  const urlRe = /https?:\/\/[a-z0-9.-]+\.trycloudflare\.com\b/i;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Bail if cloudflared died before printing the URL.
    if (child.exitCode !== null) {
      const tail = (() => {
        try {
          return readFileSync(options.logPath, 'utf8').slice(-500);
        } catch {
          return '(no log)';
        }
      })();
      throw new Error(`cloudflared exited before printing a tunnel URL (code=${child.exitCode}); log tail: ${tail}`);
    }
    try {
      const log = readFileSync(options.logPath, 'utf8');
      const match = log.match(urlRe);
      if (match !== null) {
        return { url: match[0], pid: childPid, logPath: options.logPath };
      }
    } catch {
      // File still empty / not flushed.
    }
    await sleep(200);
  }

  // Timed out. Kill the child so we don't leak a half-up tunnel.
  try {
    process.kill(childPid, 'SIGTERM');
  } catch {
    // already dead
  }
  const tail = (() => {
    try {
      return readFileSync(options.logPath, 'utf8').slice(-500);
    } catch {
      return '(no log)';
    }
  })();
  throw new Error(
    `cloudflared did not print a https://*.trycloudflare.com URL within ${timeoutMs}ms; log tail: ${tail}`,
  );
}

/**
 * W4 (2026-05-13) — write/remove COODRA_PUBLIC_URL in `~/.coodra/.env`.
 *
 * Why `~/.coodra/.env` and not the cwd `.env`: machine-level config
 * (the tunnel applies to the daemon supervisor on THIS machine, not to
 * a specific project). The same precedence applies as everywhere else
 * in the CLI — home env is the per-machine layer, project env is the
 * per-project layer, shell env wins. See `loadHomeEnv`.
 */
export function writeTunnelUrlToHomeEnv(coodraHome: string, url: string): void {
  const envPath = join(coodraHome, '.env');
  upsertEnvKey(envPath, 'COODRA_PUBLIC_URL', url);
}

export function clearTunnelUrlFromHomeEnv(coodraHome: string): void {
  const envPath = join(coodraHome, '.env');
  removeEnvKey(envPath, 'COODRA_PUBLIC_URL');
}

/**
 * Tunnel state pointer — track the PID of the cloudflared child so
 * `coodra stop` (a different process from the one that spawned
 * `start --tunnel`) can find + kill it. Kept under `~/.coodra/`
 * alongside the daemon PIDs (which point at launchd-managed children;
 * the tunnel is the only one we own directly).
 */
export function tunnelStatePath(coodraHome: string): string {
  return join(coodraHome, 'tunnel.json');
}

export interface TunnelState {
  readonly pid: number;
  readonly url: string;
  readonly startedAt: number;
}

export function readTunnelState(coodraHome: string): TunnelState | null {
  const path = tunnelStatePath(coodraHome);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as TunnelState;
    if (typeof parsed.pid !== 'number' || typeof parsed.url !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeTunnelState(coodraHome: string, state: TunnelState): void {
  const path = tunnelStatePath(coodraHome);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export function clearTunnelState(coodraHome: string): void {
  const path = tunnelStatePath(coodraHome);
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // best-effort
  }
}

/**
 * W4 (2026-05-13) — kill a previously-started tunnel by reading the
 * persisted PID. `coodra stop` runs in a different process from
 * `coodra start --tunnel`, so we can't share the `QuickTunnel`
 * object — we go through the filesystem state pointer.
 *
 * Idempotent: missing state file = no-op, dead PID = no-op (cleared
 * the file), kill failure = logged and continues.
 */
export function stopTunnelByPid(coodraHome: string): { stopped: boolean; pid: number | null; err?: string } {
  const state = readTunnelState(coodraHome);
  if (state === null) return { stopped: false, pid: null };
  let stopped = false;
  let err: string | undefined;
  try {
    process.kill(state.pid, 'SIGTERM');
    stopped = true;
  } catch (e) {
    // ESRCH: PID gone (already dead). EPERM: not our process — same.
    // Either way: state file is stale, clean it up.
    err = (e as Error).message;
  }
  clearTunnelState(coodraHome);
  return err === undefined ? { stopped, pid: state.pid } : { stopped, pid: state.pid, err };
}
