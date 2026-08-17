'use server';

import { runStart, runStatus, runStop } from '@coodra/cli/lib/services';
import { redirect } from 'next/navigation';

import { refuseInTeamHosted } from '@/lib/action-guards';

/**
 * web-v2 server actions for service control.
 *
 * Three actions, reachable from /workspace + topbar:
 *
 *   startServicesAction()  — spawns mcp-server + web (+ sync
 *                            in team mode); wraps `runStart`.
 *   stopServicesAction()   — kills the same; wraps `runStop`.
 *   refreshStatusAction()  — no-op redirect that triggers a rerun
 *                            so /workspace picks up the latest status.
 *
 * Deployment gate: in `team-hosted` mode the web app runs on a server
 * (Vercel/Fly/Docker) where there are no local daemons to spawn. We
 * refuse with a redirect to /forbidden so an operator can't
 * accidentally trigger launchd-style spawning from a serverless host.
 * In `local-solo` and `local-team` both, the daemons run on the same
 * machine as the web — service control is the right affordance there.
 */

const WORKSPACE_HREF = '/workspace';
const STOP_VERIFY_TIMEOUT_MS = 2_000;
const STOP_VERIFY_INTERVAL_MS = 150;

async function isReachable(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 500);
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntilUnreachable(url: string): Promise<boolean> {
  const deadline = Date.now() + STOP_VERIFY_TIMEOUT_MS;
  do {
    if (!(await isReachable(url))) return true;
    await new Promise((resolve) => setTimeout(resolve, STOP_VERIFY_INTERVAL_MS));
  } while (Date.now() < deadline);
  return !(await isReachable(url));
}

function serviceHealthUrl(service: 'mcp-server' | 'web' | 'sync-daemon'): string | null {
  if (service === 'mcp-server') {
    return `http://127.0.0.1:${process.env.MCP_SERVER_PORT ?? '3100'}/healthz`;
  }
  if (service === 'web') {
    return `http://127.0.0.1:${process.env.COODRA_WEB_PORT ?? '3001'}/api/healthz`;
  }
  return null;
}

export async function startServicesAction(formData: FormData): Promise<void> {
  refuseInTeamHosted('startServicesAction');
  const onlyMcp = formData.get('only') === 'mcp';
  const onlyWeb = formData.get('only') === 'web';
  const result = await runStart({
    ...(onlyMcp ? { mcp: true, web: false } : {}),
    ...(onlyWeb ? { web: true, mcp: false } : {}),
  });
  if (!result.ok) {
    redirect(
      `${WORKSPACE_HREF}?error=${encodeURIComponent(result.error)}&errorMessage=${encodeURIComponent(result.howToFix)}`,
    );
  }
  redirect(`${WORKSPACE_HREF}?started=1`);
}

export async function stopServicesAction(formData: FormData): Promise<void> {
  refuseInTeamHosted('stopServicesAction');
  const service = formData.get('service');
  const target =
    typeof service === 'string' && (service === 'mcp-server' || service === 'web' || service === 'sync-daemon')
      ? service
      : null;
  const result = await runStop(
    target !== null
      ? {
          service: target,
        }
      : {},
  );
  if (!result.ok) {
    redirect(
      `${WORKSPACE_HREF}?error=${encodeURIComponent(result.error)}&errorMessage=${encodeURIComponent(result.howToFix)}`,
    );
  }
  const healthUrl = target !== null ? serviceHealthUrl(target) : null;
  if (healthUrl !== null && !(await waitUntilUnreachable(healthUrl))) {
    redirect(
      `${WORKSPACE_HREF}?error=${encodeURIComponent('stop_not_confirmed')}&errorMessage=${encodeURIComponent(
        `${target} stop command completed, but its health check is still reachable. It may be unmanaged, auto-restarted, or running from a different launcher.`,
      )}`,
    );
  }
  redirect(`${WORKSPACE_HREF}?stopped=1`);
}

export async function refreshStatusAction(): Promise<void> {
  refuseInTeamHosted('refreshStatusAction');
  redirect(`${WORKSPACE_HREF}?refreshed=${Date.now()}`);
}

export async function getServicesStatus(): Promise<Awaited<ReturnType<typeof runStatus>>> {
  return runStatus();
}
