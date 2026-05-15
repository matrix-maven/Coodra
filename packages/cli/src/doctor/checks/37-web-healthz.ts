import type { Check } from '../types.js';
import { probeHealthz } from './10-mcp-healthz.js';

/**
 * Web Bundle W1 (2026-05-13). Verifies the bundled Next.js standalone
 * server is serving /api/healthz on :3001. Mode-agnostic — the web runs
 * in both solo and team mode (mode-awareness happens inside the page
 * tree via `lib/deployment-mode.ts`, not at process level).
 *
 * Runs against the public healthz route (`/api/healthz`), which the
 * route handler annotates with `force-dynamic` so a Cloud Postgres
 * outage doesn't make the supervisor restart-loop the process.
 *
 * Reuses `probeHealthz` so PID-state-aware diagnostics work the same
 * way as the mcp-server / hooks-bridge checks: if the PID file exists
 * but the process is dead the result is RED with a clean recovery
 * remediation, otherwise YELLOW with `coodra start`.
 *
 * Non-essential — opt-in via `coodra doctor --full`. Web is
 * support-tier infrastructure for the dashboard; an MCP-only Claude
 * Code session doesn't depend on it. Promote to essential when we
 * make the web the discoverability hub for solo onboarding.
 */
export const webHealthzCheck: Check = {
  id: 37,
  name: 'Web Dashboard HTTP /api/healthz reachable',
  severity: 'red',
  async run(ctx) {
    return probeHealthz({
      url: `http://127.0.0.1:${ctx.webPort}/api/healthz`,
      timeoutMs: ctx.timeoutMs - 200,
      label: 'Web Dashboard',
      coodraHome: ctx.coodraHome,
      unitName: 'web',
    });
  },
};
