import { readPidStatus } from '../../lib/pid-status.js';
import type { Check } from '../types.js';

export const mcpHealthzCheck: Check = {
  id: 10,
  name: 'MCP server HTTP /healthz reachable',
  severity: 'red',
  async run(ctx) {
    return probeHealthz({
      url: `http://127.0.0.1:${ctx.mcpPort}/healthz`,
      timeoutMs: ctx.timeoutMs - 200,
      label: 'MCP server',
      coodraHome: ctx.coodraHome,
      unitName: 'mcp-server',
    });
  },
};

export interface ProbeHealthzArgs {
  readonly url: string;
  readonly timeoutMs: number;
  readonly label: string;
  /** Coodra home directory — used to read `<home>/pids/<unitName>.pid`. */
  readonly coodraHome: string;
  /** Daemon unit name; e.g. `mcp-server` or `hooks-bridge`. */
  readonly unitName: string;
}

/**
 * PID-aware healthz probe. Closes the post-08a integration walk gap:
 * doctor used to report YELLOW for both "never started" and "process
 * crashed", giving operators no signal that something needed attention.
 *
 * On healthz failure, the probe consults `<coodra-home>/pids/<unitName>.pid`:
 *   - PID file present + PID is dead → RED ("supposed to be running, crashed")
 *   - PID file absent                → YELLOW with `Run coodra start` remediation
 *   - PID file present + PID alive   → YELLOW (process up but not yet serving;
 *                                              transient — likely just booting)
 *
 * launchd/systemd-managed daemons do not write to `~/.coodra/pids/`
 * (their own restart machinery handles crashes), so PID file absent is
 * the expected state for them — yellow stays the right answer.
 */
export async function probeHealthz(args: ProbeHealthzArgs) {
  const { url, timeoutMs, label, coodraHome, unitName } = args;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 250));
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) {
      return { status: 'green' as const, detail: `${label} 200 OK at ${url}` };
    }
    return {
      status: 'yellow' as const,
      detail: `${label} returned ${response.status} at ${url}`,
      remediation: `Inspect ${label} logs; the daemon is up but failing health checks.`,
    };
  } catch (err) {
    clearTimeout(timer);
    const code = (err as { cause?: { code?: string } }).cause?.code;
    const pidStatus = await readPidStatus(coodraHome, unitName);
    if (pidStatus.state === 'dead') {
      return {
        status: 'red' as const,
        detail:
          `${label} not reachable at ${url} but PID file points at PID ${pidStatus.pid} which is no longer alive ` +
          '(crashed without cleanup)',
        remediation:
          `Run \`coodra stop\` to clean up the stale PID file, inspect ` +
          `\`<coodra-home>/logs/${unitName}.log\` for the crash cause, ` +
          'then `coodra start` to recover.',
      };
    }
    if (code === 'ECONNREFUSED') {
      return {
        status: 'yellow' as const,
        detail: `${label} not reachable at ${url} (ECONNREFUSED — service not running)`,
        remediation: 'Run `coodra start` to launch the daemons.',
      };
    }
    return {
      status: 'yellow' as const,
      detail: `${label} probe failed: ${(err as Error).message}`,
      remediation: 'Run `coodra start` and recheck.',
    };
  }
}
