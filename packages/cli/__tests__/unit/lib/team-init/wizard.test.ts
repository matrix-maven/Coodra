import { describe, expect, it, vi } from 'vitest';

import type { ClerkBootstrapResult } from '../../../../src/lib/team-init/clerk-bootstrap.js';
import type { FinalizeConfigResult } from '../../../../src/lib/team-init/finalize-config.js';
import type { PostgresBootstrapResult } from '../../../../src/lib/team-init/postgres-bootstrap.js';
import { runWizard, type WizardDeps, type WizardStepResult } from '../../../../src/lib/team-init/wizard.js';

/**
 * Phase B (clarity-pass-plan, 2026-05-11) — wizard orchestrator tests.
 *
 * The orchestrator's behaviour is pure (depends only on the three
 * bootstrap function results); these tests inject mock deps for full
 * coverage of the happy + sad paths.
 *
 * What we cover:
 *   1. Happy path — all three steps succeed, returns ok:true with all
 *      three result shapes merged.
 *   2. Postgres failure — short-circuits, never calls Clerk or Finalize.
 *   3. Clerk failure — Postgres ran, Finalize did not.
 *   4. Multi-org Clerk without preferredOrgId — surfaces a synthetic
 *      `org_not_found` failure rather than crashing.
 *   5. onStep streaming — fires once per step in order.
 */

function pgOk(over: Partial<Extract<PostgresBootstrapResult, { ok: true }>> = {}): PostgresBootstrapResult {
  return {
    ok: true,
    migrationsApplied: 14,
    pgvectorInstalled: true,
    serverVersion: 'PostgreSQL 17.4',
    ...over,
  };
}

function clerkOk(over: Partial<Extract<ClerkBootstrapResult, { ok: true }>> = {}): ClerkBootstrapResult {
  return {
    ok: true,
    userId: 'user_alice',
    userEmail: 'alice@acme.com',
    orgs: [{ id: 'org_acme', slug: 'acme', name: 'Acme', role: 'org:admin' }],
    selectedOrg: { id: 'org_acme', slug: 'acme', name: 'Acme', role: 'org:admin' },
    ...over,
  };
}

function finalizeOk(over: Partial<FinalizeConfigResult> = {}): FinalizeConfigResult {
  return {
    localHookSecret: 'a'.repeat(64),
    inviteHmacSecret: 'b'.repeat(64),
    configPath: '/tmp/home/.coodra/config.json',
    envPath: '/tmp/home/.coodra/.env',
    joinedAt: 1700000000000,
    ...over,
  };
}

function makeDeps(over: Partial<WizardDeps> = {}): WizardDeps {
  return {
    bootstrapPostgres: vi.fn().mockResolvedValue(pgOk()),
    bootstrapClerk: vi.fn().mockResolvedValue(clerkOk()),
    finalizeConfig: vi.fn().mockReturnValue(finalizeOk()),
    ...over,
  };
}

describe('runWizard', () => {
  it('happy path: all three steps succeed and return a merged ok:true result', async () => {
    const deps = makeDeps();
    const result = await runWizard({
      input: { databaseUrl: 'postgres://x:y@h/d', clerkSecretKey: 'sk_test_xxx' },
      deps,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.postgres.migrationsApplied).toBe(14);
      expect(result.clerk.userId).toBe('user_alice');
      expect(result.finalize.localHookSecret).toBe('a'.repeat(64));
    }
    expect(deps.bootstrapPostgres).toHaveBeenCalledOnce();
    expect(deps.bootstrapClerk).toHaveBeenCalledOnce();
    expect(deps.finalizeConfig).toHaveBeenCalledOnce();
  });

  it('Postgres failure short-circuits — Clerk and Finalize are never called', async () => {
    const deps = makeDeps({
      bootstrapPostgres: vi.fn().mockResolvedValue({
        ok: false,
        error: 'connect_failed',
        howToFix: 'check the URL',
        underlyingError: 'ECONNREFUSED',
      } satisfies PostgresBootstrapResult),
    });
    const result = await runWizard({
      input: { databaseUrl: 'bad', clerkSecretKey: 'sk_test_xxx' },
      deps,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedStep).toBe('postgres');
      expect(result.failure.error).toBe('connect_failed');
    }
    expect(deps.bootstrapClerk).not.toHaveBeenCalled();
    expect(deps.finalizeConfig).not.toHaveBeenCalled();
  });

  it('Clerk failure: Postgres ran but Finalize did not', async () => {
    const deps = makeDeps({
      bootstrapClerk: vi.fn().mockResolvedValue({
        ok: false,
        error: 'invalid_key',
        howToFix: 'use sk_test_ or sk_live_',
        underlyingError: '401',
      } satisfies ClerkBootstrapResult),
    });
    const result = await runWizard({
      input: { databaseUrl: 'postgres://x:y@h/d', clerkSecretKey: 'wrong' },
      deps,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedStep).toBe('clerk');
      expect(result.failure.error).toBe('invalid_key');
    }
    expect(deps.bootstrapPostgres).toHaveBeenCalledOnce();
    expect(deps.finalizeConfig).not.toHaveBeenCalled();
  });

  it('multi-org Clerk without preferredOrgId surfaces a synthetic org_not_found failure', async () => {
    const deps = makeDeps({
      bootstrapClerk: vi.fn().mockResolvedValue(
        clerkOk({
          orgs: [
            { id: 'org_a', slug: 'a', name: 'A', role: null },
            { id: 'org_b', slug: 'b', name: 'B', role: null },
          ],
          selectedOrg: null, // no auto-select for multi-org
        }),
      ),
    });
    const result = await runWizard({
      input: { databaseUrl: 'postgres://x:y@h/d', clerkSecretKey: 'sk_test_xxx' },
      deps,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedStep).toBe('clerk');
      expect(result.failure.error).toBe('org_not_found');
    }
    expect(deps.finalizeConfig).not.toHaveBeenCalled();
  });

  it('onStep streams one event per step in order', async () => {
    const events: WizardStepResult[] = [];
    const deps = makeDeps();
    await runWizard({
      input: { databaseUrl: 'postgres://x:y@h/d', clerkSecretKey: 'sk_test_xxx' },
      deps,
      onStep: (e) => events.push(e),
    });
    expect(events.map((e) => e.step)).toEqual(['postgres', 'clerk', 'finalize']);
  });
});
