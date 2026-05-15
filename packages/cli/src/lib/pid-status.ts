import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveCoodraPidsDir } from './coodra-home.js';

/**
 * `packages/cli/src/lib/pid-status` — shared helper for "is the daemon
 * supposed to be running, and if so, is it actually alive?"
 *
 * Three states. The boundary between them is what lets doctor checks
 * 10/11 distinguish "bridge crashed" (RED) from "never started"
 * (YELLOW with remediation).
 *
 *   - `alive`        — `<coodra-home>/pids/<name>.pid` exists and the
 *                      PID responds to signal 0. Process is live.
 *   - `dead`         — PID file exists but the PID has gone away (kill
 *                      returned ESRCH). The fallback daemon manager
 *                      writes the PID file at start() and removes it at
 *                      stop(); a `dead` state means the process was
 *                      started, did not call stop() cleanly, and the
 *                      process has exited. RED-worthy in field.
 *   - `no-pid-file`  — no PID file. Either the daemon was never
 *                      started, was cleanly stopped, or is managed by
 *                      launchd/systemd (which don't write to
 *                      ~/.coodra/pids/). YELLOW-worthy.
 *
 * Caller responsibility: dead vs no-pid-file is the same exit-1 from
 * the doctor's perspective; both fail the healthz probe. The state
 * just upgrades the severity from yellow → red when a PID-tracked
 * process has crashed.
 */

export type PidStatus =
  | { readonly state: 'alive'; readonly pid: number }
  | { readonly state: 'dead'; readonly pid: number }
  | { readonly state: 'no-pid-file' };

export async function readPidStatus(coodraHome: string, unitName: string): Promise<PidStatus> {
  const pidsDir = resolveCoodraPidsDir(coodraHome);
  const path = join(pidsDir, `${unitName}.pid`);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { state: 'no-pid-file' };
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) return { state: 'no-pid-file' };
  return isProcessAlive(pid) ? { state: 'alive', pid } : { state: 'dead', pid };
}

export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 is the POSIX "no-op" — checks for process existence.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true; // exists but we can't signal it
    return false;
  }
}
