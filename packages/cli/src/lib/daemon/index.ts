import { FallbackDaemonManager } from './fallback.js';
import { LaunchdDaemonManager } from './launchd.js';
import { SystemdDaemonManager } from './systemd.js';
import type { DaemonManager } from './types.js';

export { FallbackDaemonManager } from './fallback.js';
export { LaunchdDaemonManager } from './launchd.js';
export { SystemdDaemonManager } from './systemd.js';
export type { DaemonManager, DaemonStatus, DaemonUnit } from './types.js';

export interface SelectDaemonManagerOptions {
  /** Resolved ~/.coodra/ — used by the fallback for PID files. */
  readonly coodraHome: string;
  /** Override for tests. */
  readonly platform?: NodeJS.Platform;
  /** Override `process.env` for tests. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Pick the right daemon manager for the current OS, falling back to the
 * detached-child + PID-file `FallbackDaemonManager` when the native manager
 * is unreachable. Decision matrix per techstack.md "Process management".
 *
 * `COODRA_DAEMON_MANAGER=fallback` forces the PID-file manager. This is
 * REQUIRED for any second Coodra instance on one machine (the core-smoke,
 * a scratch COODRA_HOME): launchd/systemd unit names are global per user
 * (`com.coodra.<name>`, not scoped by COODRA_HOME), so a smoke's
 * start/stop would otherwise boot out the user's real daemons —
 * observed 2026-07-02 when `pnpm smoke:core` stopped a dev's live stack.
 *
 * Note: Windows always uses fallback in 08a (Task Scheduler integration is
 * deferred per spec §3 non-goals).
 */
export async function selectDaemonManager(options: SelectDaemonManagerOptions): Promise<DaemonManager> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (env.COODRA_DAEMON_MANAGER === 'fallback') {
    return new FallbackDaemonManager({ coodraHome: options.coodraHome });
  }

  if (platform === 'darwin') {
    const launchd = new LaunchdDaemonManager();
    if (await launchd.isAvailable()) return launchd;
  } else if (platform === 'linux') {
    const systemd = new SystemdDaemonManager();
    if (await systemd.isAvailable()) return systemd;
  }

  return new FallbackDaemonManager({ coodraHome: options.coodraHome });
}
