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
}

/**
 * Pick the right daemon manager for the current OS, falling back to the
 * detached-child + PID-file `FallbackDaemonManager` when the native manager
 * is unreachable. Decision matrix per techstack.md "Process management".
 *
 * Note: Windows always uses fallback in 08a (Task Scheduler integration is
 * deferred per spec §3 non-goals).
 */
export async function selectDaemonManager(options: SelectDaemonManagerOptions): Promise<DaemonManager> {
  const platform = options.platform ?? process.platform;

  if (platform === 'darwin') {
    const launchd = new LaunchdDaemonManager();
    if (await launchd.isAvailable()) return launchd;
  } else if (platform === 'linux') {
    const systemd = new SystemdDaemonManager();
    if (await systemd.isAvailable()) return systemd;
  }

  return new FallbackDaemonManager({ coodraHome: options.coodraHome });
}
