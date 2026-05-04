'use server';

import { runStart, runStatus, runStop } from '@coodra/contextos-cli/lib/services';
import { redirect } from 'next/navigation';

/**
 * `apps/web/lib/actions/services.ts` — Server Actions for the M04
 * Phase 2 S12 service-control surface.
 *
 * Three actions, all reachable from `/settings/workspace`:
 *
 *   startServicesAction()  — spawns hooks-bridge + mcp-server (and
 *                            sync-daemon when team mode env is set);
 *                            wraps `runStart`.
 *   stopServicesAction()   — kills the same; wraps `runStop`.
 *   refreshStatusAction()  — no-op redirect that triggers a server
 *                            re-render so the page picks up the
 *                            latest status without a full reload.
 *
 * Solo-mode-only gate. The web app's deployment story for team mode
 * runs the dashboard remotely; spawning local daemons from a remote
 * dashboard is out of scope (and a security concern). The page that
 * mounts these actions enforces the gate; we mirror the check here
 * so a stray POST doesn't bypass the UI.
 */

function ensureSoloMode(action: string): void {
  const mode = process.env.CONTEXTOS_MODE ?? 'solo';
  if (mode !== 'solo') {
    throw new Error(
      `${action} is only available in solo mode. CONTEXTOS_MODE=${mode}; service control via the web UI is solo-only.`,
    );
  }
}

const SETTINGS_HREF = '/settings/workspace';

export async function startServicesAction(formData: FormData): Promise<void> {
  ensureSoloMode('startServicesAction');
  const onlyMcp = formData.get('only') === 'mcp';
  const onlyHooks = formData.get('only') === 'hooks';
  const result = await runStart({
    ...(onlyMcp ? { mcp: true, hooks: false } : {}),
    ...(onlyHooks ? { hooks: true, mcp: false } : {}),
  });
  if (!result.ok) {
    redirect(
      `${SETTINGS_HREF}?error=${encodeURIComponent(result.error)}&errorMessage=${encodeURIComponent(result.howToFix)}`,
    );
  }
  redirect(`${SETTINGS_HREF}?started=1`);
}

export async function stopServicesAction(formData: FormData): Promise<void> {
  ensureSoloMode('stopServicesAction');
  const service = formData.get('service');
  const result = await runStop(
    typeof service === 'string' && (service === 'mcp-server' || service === 'hooks-bridge' || service === 'sync-daemon')
      ? { service }
      : {},
  );
  if (!result.ok) {
    redirect(
      `${SETTINGS_HREF}?error=${encodeURIComponent(result.error)}&errorMessage=${encodeURIComponent(result.howToFix)}`,
    );
  }
  redirect(`${SETTINGS_HREF}?stopped=1`);
}

export async function refreshStatusAction(): Promise<void> {
  ensureSoloMode('refreshStatusAction');
  redirect(`${SETTINGS_HREF}?refreshed=${Date.now()}`);
}

// Re-export runStatus so the page can call it server-side without
// importing from the cli package directly.
export async function getServicesStatus(): Promise<Awaited<ReturnType<typeof runStatus>>> {
  return runStatus();
}
