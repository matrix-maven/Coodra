'use server';

import { redirect } from 'next/navigation';

/**
 * `apps/web-v2/lib/actions/team-init.ts` — Phase B (clarity-pass-plan,
 * 2026-05-11). Server action that runs the FULL three-step
 * `team init` wizard from a single form submission on the local solo
 * web wizard.
 *
 * Why this exists (vs. the CLI wizard):
 *   - Some admins prefer a browser form to a terminal prompt.
 *   - The local solo web wizard is the natural place to wrap that —
 *     the writes go to `~/.coodra/` on the SAME machine the dev
 *     server is running on.
 *   - Hard-fenced to `local-solo` deployment mode: in `team-hosted`
 *     this action would write to the server's filesystem (wrong
 *     machine); in `local-team` the laptop is already set up so the
 *     wizard would just overwrite. Both are refused.
 *
 * Pattern: redirect-with-result (same as `verifyCloudConnectionAction`
 * in `onboarding.ts`). The page re-renders with the success / failure
 * snapshot encoded into search params; no client state.
 *
 * Inputs come from a single HTML form:
 *   - databaseUrl: pasted DATABASE_URL
 *   - clerkSecretKey: pasted sk_test_… or sk_live_…
 *   - orgId (optional): pre-selected org id (skips the picker round-trip)
 *
 * ----------------------------------------------------------------------
 * Import strategy (2026-05-11 fix — Build Error reproduction):
 *
 *   The team-init library transitively imports `@coodra/db`
 *   (which loads native `better-sqlite3`) plus `@clerk/backend`, and
 *   `@/lib/deployment-mode` is marked `'server-only'`. When statically
 *   imported at module top, Next.js's webpack pipeline pulls them into
 *   the server-action chunk and tries to validate the chunk's import
 *   graph in BOTH the App Router server bundle AND a Pages-router-style
 *   client manifest. The `server-only` package's runtime check fires
 *   in the second pass and crashes the build:
 *
 *     ./lib/deployment-mode.ts
 *     You're importing a component that needs "server-only".
 *     That only works in a Server Component which is not supported
 *     in the pages/ directory.
 *
 *   Switching to dynamic `await import(...)` inside the action body
 *   keeps the static import graph empty (only `next/navigation`).
 *   Next bundles the server action correctly, and the heavy modules
 *   resolve lazily at invocation time on the server.
 * ----------------------------------------------------------------------
 */

export async function runTeamInitWizardAction(formData: FormData): Promise<void> {
  // Refuse in any mode that isn't the local solo web wizard.
  const { resolveDeploymentMode } = await import('@/lib/deployment-mode');
  const dm = resolveDeploymentMode();
  if (dm !== 'local-solo') {
    redirect(`/onboarding/team?execStatus=refused&execError=wrong_mode&execMode=${dm}`);
  }

  const databaseUrl = String(formData.get('databaseUrl') ?? '').trim();
  const clerkSecretKey = String(formData.get('clerkSecretKey') ?? '').trim();
  const preferredOrgIdRaw = String(formData.get('orgId') ?? '').trim();
  const preferredOrgId = preferredOrgIdRaw.length > 0 ? preferredOrgIdRaw : undefined;

  if (databaseUrl.length === 0) {
    redirect('/onboarding/team?execStatus=err&execError=missing_database_url');
  }
  if (clerkSecretKey.length === 0) {
    redirect('/onboarding/team?execStatus=err&execError=missing_clerk_key');
  }

  const { bootstrapClerk, bootstrapPostgres, finalizeConfig } = await import(
    '@coodra/cli/lib/team-init'
  );

  // Step 1 — Postgres
  const pg = await bootstrapPostgres({ databaseUrl });
  if (!pg.ok) {
    const params = new URLSearchParams({
      execStatus: 'err',
      execStep: 'postgres',
      execError: pg.error,
      execHowToFix: pg.howToFix,
    });
    redirect(`/onboarding/team?${params.toString()}`);
  }

  // Step 2 — Clerk
  const clerk = await bootstrapClerk({
    secretKey: clerkSecretKey,
    ...(preferredOrgId !== undefined ? { preferredOrgId } : {}),
  });
  if (!clerk.ok) {
    const params = new URLSearchParams({
      execStatus: 'err',
      execStep: 'clerk',
      execError: clerk.error,
      execHowToFix: clerk.howToFix,
    });
    redirect(`/onboarding/team?${params.toString()}`);
  }

  // Multi-org path: when the admin didn't pre-select an org and the
  // membership list has more than one, redirect back to the page with
  // the org list encoded so the page can render a picker. The picker's
  // form resubmits to this action with `orgId` filled.
  if (clerk.selectedOrg === null) {
    const params = new URLSearchParams({
      execStatus: 'pickOrg',
      execStep: 'clerk',
      execOrgs: JSON.stringify(
        clerk.orgs.map((o) => ({ id: o.id, slug: o.slug, name: o.name, role: o.role })),
      ),
      execDatabaseUrl: databaseUrl,
      execClerkSecretKey: clerkSecretKey,
    });
    redirect(`/onboarding/team?${params.toString()}`);
  }

  // Step 3 — finalize (writes ~/.coodra/config.json + .env)
  finalizeConfig({
    databaseUrl,
    clerkUserId: clerk.userId,
    clerkOrgId: clerk.selectedOrg.id,
    clerkOrgSlug: clerk.selectedOrg.slug,
  });

  // Success — redirect to /settings/team which will re-render in
  // local-team mode now that config.json has been written.
  redirect('/settings/team?onboarded=1');
}
