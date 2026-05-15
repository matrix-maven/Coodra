'use server';

import { redirect } from 'next/navigation';

import { createPostgresDb } from '@coodra/db';

/**
 * `apps/web-v2/lib/actions/onboarding.ts` — server action backing the
 * team-mode onboarding wizard's "verify cloud connection" step.
 *
 * Pattern: redirect-with-result. Encodes the verify outcome into
 * search params on `/onboarding/team` so the same server-rendered page
 * can render success / error variants without needing a client form
 * helper. The action never persists the URL — the user's CLI command
 * is what writes credentials to `~/.coodra/.env` + `config.json`.
 *
 * Why we still verify here even though `coodra team setup` does the
 * same internally: some users will paste their URL into the wizard and
 * try it BEFORE running the CLI. Catching "wrong URL / no schema yet"
 * here saves them from a confusing CLI error trace.
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

export async function verifyCloudConnectionAction(formData: FormData): Promise<void> {
  const databaseUrl = String(formData.get('databaseUrl') ?? '').trim();
  const params = new URLSearchParams();

  if (databaseUrl.length === 0) {
    params.set('verifyStatus', 'err');
    params.set('verifyError', 'empty_url');
    redirect(`/onboarding/team?step=2&${params.toString()}`);
  }
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    params.set('verifyStatus', 'err');
    params.set('verifyError', 'bad_protocol');
    redirect(`/onboarding/team?step=2&${params.toString()}`);
  }

  const start = Date.now();
  let cloud: ReturnType<typeof createPostgresDb>;
  try {
    cloud = createPostgresDb({ databaseUrl });
  } catch (err) {
    params.set('verifyStatus', 'err');
    params.set('verifyError', 'cannot_construct');
    params.set('verifyMessage', err instanceof Error ? err.message : String(err));
    redirect(`/onboarding/team?step=2&${params.toString()}`);
  }
  try {
    await cloud.raw`SELECT 1`;
  } catch (err) {
    await tryClose(cloud);
    params.set('verifyStatus', 'err');
    params.set('verifyError', 'select_one_failed');
    params.set('verifyMessage', err instanceof Error ? err.message : String(err));
    redirect(`/onboarding/team?step=2&${params.toString()}`);
  }

  let tables: Array<{ table_name: string }>;
  try {
    tables = await cloud.raw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
  } catch (err) {
    await tryClose(cloud);
    params.set('verifyStatus', 'err');
    params.set('verifyError', 'schema_probe_failed');
    params.set('verifyMessage', err instanceof Error ? err.message : String(err));
    redirect(`/onboarding/team?step=2&${params.toString()}`);
  }
  await tryClose(cloud);

  const present = new Set(tables.map((r) => r.table_name));
  const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
  const elapsedMs = Date.now() - start;

  if (missing.length > 0) {
    params.set('verifyStatus', 'err');
    params.set('verifyError', 'schema_missing');
    params.set('verifyMissing', missing.length.toString());
    params.set('verifyElapsedMs', elapsedMs.toString());
    redirect(`/onboarding/team?step=2&${params.toString()}`);
  }

  params.set('verifyStatus', 'ok');
  params.set('verifyTables', present.size.toString());
  params.set('verifyElapsedMs', elapsedMs.toString());
  redirect(`/onboarding/team?step=3&${params.toString()}`);
}

async function tryClose(cloud: ReturnType<typeof createPostgresDb>): Promise<void> {
  try {
    await cloud.close();
  } catch {
    /* swallow — best-effort cleanup */
  }
}
