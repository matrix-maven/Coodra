'use server';

import { upgradeToTeamConfig, writeTeamHomeEnv } from '@coodra/cli/lib/team-config';
import { createPostgresDb } from '@coodra/db';
import { redirect } from 'next/navigation';

import { refuseInTeamHosted } from '@/lib/action-guards';

/**
 * `apps/web-v2/lib/actions/team-join.ts` — server action backing the
 * web flow at `/onboarding/team/join`.
 *
 * This is the web-app equivalent of the CLI's `coodra team join`
 * command. It exists because the per-developer local-web deployment
 * pattern needs a way for *anyone* (admin on a new machine, freshly
 * onboarded member, viewer who only browses the web) to bootstrap
 * their local config from the credential bundle their team gave them.
 *
 * What it does — in this exact order:
 *   1. Validates connectivity (`SELECT 1`) against the supplied DATABASE_URL.
 *   2. Counts the 12 expected Coodra tables — sanity check that
 *      this is actually a Coodra-provisioned cloud, not someone
 *      else's database.
 *   3. Calls `upgradeToTeamConfig` (writes `~/.coodra/config.json::team`).
 *   4. Calls `writeTeamHomeEnv` (writes `~/.coodra/.env` with
 *      COODRA_MODE=team + DATABASE_URL + LOCAL_HOOK_SECRET +
 *      COODRA_TEAM_ORG_ID).
 *   5. Redirects to `/?joined=ok` so the dashboard renders the new
 *      team-mode banner.
 *
 * What it does NOT do — and why:
 *   - It does NOT write the Clerk keys to ~/.coodra/.env. Those
 *     vary by deployment and live at the discretion of the operator.
 *     A future iteration could prompt for them; for now we expect
 *     the user to append them manually (the page tells them how).
 *   - It does NOT call any Clerk API. There's no Coodra-side
 *     Clerk integration for "verify this user is in this org" — that
 *     happens at the team's web deployment via `clerkMiddleware`.
 *     This action only writes config; the next time the daemon spawn
 *     reads ~/.coodra/.env, it sees the team identity.
 *   - It does NOT generate a hook secret. The whole point is that
 *     the user supplies the *team's existing* secret so they
 *     authenticate against existing teammates' machines.
 *
 * Pattern: redirect-with-result, identical to onboarding.ts. Errors
 * encode into search params so the same server-rendered page shows
 * success/error variants without a client component.
 */

const REQUIRED_TABLES: ReadonlyArray<string> = [
  'projects',
  'runs',
  'run_events',
  'context_packs',
  'pending_jobs',
  'policies',
  'policy_rules',
  'policy_decisions',
  'feature_packs',
  'decisions',
  'kill_switches',
  'run_diffs',
];

export async function joinExistingTeamAction(formData: FormData): Promise<void> {
  // `team join` writes ~/.coodra/config.json + .env on the local
  // laptop. On a Vercel deployment there's no ~/.coodra to write
  // to. Refuse so an operator doesn't accidentally try to "join" the
  // hosted deployment to itself.
  refuseInTeamHosted('joinExistingTeamAction');

  const databaseUrl = String(formData.get('databaseUrl') ?? '').trim();
  const userId = String(formData.get('userId') ?? '').trim();
  const orgId = String(formData.get('orgId') ?? '').trim();
  const orgSlug = String(formData.get('orgSlug') ?? '').trim();
  const secret = String(formData.get('secret') ?? '').trim();

  const params = new URLSearchParams();
  const setErr = (code: string, message?: string): never => {
    params.set('joinStatus', 'err');
    params.set('joinError', code);
    if (message !== undefined) params.set('joinMessage', message);
    redirect(`/onboarding/team/join?${params.toString()}`);
  };

  if (databaseUrl.length === 0) setErr('empty_url');
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) setErr('bad_protocol');
  if (userId.length === 0) setErr('empty_user_id');
  if (!/^user_[a-zA-Z0-9_-]+$/.test(userId)) setErr('bad_user_id');
  if (orgId.length === 0) setErr('empty_org_id');
  if (!/^org_[a-zA-Z0-9_-]+$/.test(orgId)) setErr('bad_org_id');
  if (secret.length < 32) setErr('bad_secret');

  let cloud: ReturnType<typeof createPostgresDb>;
  try {
    cloud = createPostgresDb({ databaseUrl });
  } catch (err) {
    setErr('cannot_construct', err instanceof Error ? err.message : String(err));
  }
  // ts can't see that setErr never returns. Re-assign through a non-null
  // local so the closure compiler is happy. (cloud was assigned in the
  // `try` above; if it wasn't, setErr already redirected.)
  const handle = cloud!;

  try {
    await handle.raw`SELECT 1`;
  } catch (err) {
    await tryClose(handle);
    setErr('select_one_failed', err instanceof Error ? err.message : String(err));
  }

  let tables: Array<{ table_name: string }>;
  try {
    tables = await handle.raw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
  } catch (err) {
    await tryClose(handle);
    setErr('schema_probe_failed', err instanceof Error ? err.message : String(err));
    return;
  }
  await tryClose(handle);

  const present = new Set(tables.map((r) => r.table_name));
  const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
  if (missing.length > 0) {
    params.set('joinMissing', String(missing.length));
    setErr('schema_missing');
  }

  // All validations passed — write the team config locally.
  try {
    upgradeToTeamConfig({
      clerkUserId: userId,
      clerkOrgId: orgId,
      ...(orgSlug.length > 0 ? { clerkOrgSlug: orgSlug } : {}),
      localHookSecret: secret,
      joinedAt: Date.now(),
    });
    writeTeamHomeEnv({
      databaseUrl,
      localHookSecret: secret,
      clerkOrgId: orgId,
    });
  } catch (err) {
    setErr('write_failed', err instanceof Error ? err.message : String(err));
  }

  // Success — redirect to dashboard with a one-time banner.
  redirect(`/?joined=ok&org=${encodeURIComponent(orgSlug.length > 0 ? orgSlug : orgId)}`);
}

async function tryClose(cloud: ReturnType<typeof createPostgresDb>): Promise<void> {
  try {
    await cloud.close();
  } catch {
    /* swallow */
  }
}
