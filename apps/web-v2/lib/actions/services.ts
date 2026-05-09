'use server';

import { runStart, runStatus, runStop } from '@coodra/contextos-cli/lib/services';
import { redirect } from 'next/navigation';

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
 * Solo-mode-only gate (mirrored from page-level + here so a stray POST
 * doesn't bypass the UI).
 */

function ensureSoloMode(action: string): void {
  const mode = process.env.CONTEXTOS_MODE ?? 'solo';
  if (mode !== 'solo') {
    throw new Error(
      `${action} is only available in solo mode. CONTEXTOS_MODE=${mode}; service control via the web UI is solo-only.`,
    );
  }
}

const WORKSPACE_HREF = '/workspace';

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
      `${WORKSPACE_HREF}?error=${encodeURIComponent(result.error)}&errorMessage=${encodeURIComponent(result.howToFix)}`,
    );
  }
  redirect(`${WORKSPACE_HREF}?started=1`);
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
      `${WORKSPACE_HREF}?error=${encodeURIComponent(result.error)}&errorMessage=${encodeURIComponent(result.howToFix)}`,
    );
  }
  redirect(`${WORKSPACE_HREF}?stopped=1`);
}

export async function refreshStatusAction(): Promise<void> {
  ensureSoloMode('refreshStatusAction');
  redirect(`${WORKSPACE_HREF}?refreshed=${Date.now()}`);
}

export async function getServicesStatus(): Promise<Awaited<ReturnType<typeof runStatus>>> {
  return runStatus();
}
