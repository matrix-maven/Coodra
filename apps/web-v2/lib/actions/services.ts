'use server';

import { runStart, runStatus, runStop } from '@coodra/cli/lib/services';
import { redirect } from 'next/navigation';

import { refuseInTeamHosted } from '@/lib/action-guards';

/**
 * web-v2 server actions for service control.
 *
 * Three actions, reachable from /workspace + topbar:
 *
 *   startServicesAction()  — spawns hooks-bridge + mcp-server (+ sync
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

export async function startServicesAction(formData: FormData): Promise<void> {
  refuseInTeamHosted('startServicesAction');
  const onlyMcp = formData.get('only') === 'mcp';
  const onlyHooks = formData.get('only') === 'hooks';
  const result = await runStart({
    ...(onlyMcp ? { mcp: true, hooks: false } : {}),
    ...(onlyHooks ? { hooks: true, mcp: false } : {}),
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
  const result = await runStop(
    typeof service === 'string' && (service === 'mcp-server' || service === 'hooks-bridge' || service === 'sync-daemon')
      ? { service }
      : {},
  );
  if (!result.ok) {
    redirect(
      `${WORKSPACE_HREF}?error=${encodeURIComponent(result.error)}&errorMessage=${encodeURIComponent(result.howToFix)}`,
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
