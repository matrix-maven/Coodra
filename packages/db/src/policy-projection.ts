import { createHash } from 'node:crypto';

import type { PolicyProjection } from '@coodra/shared';
import { buildClaudeNativePermissionsProjection } from './claude-permissions.js';
import type { DbHandle } from './client.js';
import { buildCodexNativePermissionsProjection } from './codex-permissions.js';
import {
  getActivePolicyVersion,
  listPolicies,
  listPolicyExceptions,
  type PolicyExceptionRow,
  type PolicyWithRules,
} from './policies.js';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isCurrentlyActiveException(row: PolicyExceptionRow, now: Date): boolean {
  if (row.status !== 'active') return false;
  if (row.startsAt !== null && row.startsAt > now) return false;
  if (row.expiresAt !== null && row.expiresAt <= now) return false;
  return true;
}

export interface BuildPolicyProjectionArgs {
  readonly projectId: string;
  readonly projectSlug?: string | null;
  readonly now?: Date;
}

export async function buildPolicyProjection(db: DbHandle, args: BuildPolicyProjectionArgs): Promise<PolicyProjection> {
  const now = args.now ?? new Date();
  const policies = (await listPolicies(db, args.projectId)).filter((policy) => policy.isActive);
  const exceptions = (await listPolicyExceptions(db, args.projectId)).filter((row) =>
    isCurrentlyActiveException(row, now),
  );
  const projectionPolicies: Array<PolicyProjection['policies'][number]> = [];

  for (const policy of policies) {
    const version = await getActivePolicyVersion(db, policy.id);
    projectionPolicies.push({
      policyId: policy.id,
      name: policy.name,
      groupKey: policy.groupKey,
      profile: policy.profile,
      enforcementMode: policy.enforcementMode,
      activeVersionId: version?.id ?? null,
      versionNumber: version?.versionNumber ?? null,
      snapshotHash: version?.snapshotHash ?? null,
      ruleIds: policy.rules.map((rule) => rule.id).sort(),
    });
  }

  const activeRuleIds = policies.flatMap((policy: PolicyWithRules) => policy.rules.map((rule) => rule.id)).sort();
  const activeExceptionIds = exceptions.map((row) => row.id).sort();
  const policyVersionIds = projectionPolicies
    .map((policy) => policy.activeVersionId)
    .filter((id): id is string => id !== null)
    .sort();

  const payload = {
    schemaVersion: 1,
    managedBy: 'coodra',
    projectId: args.projectId,
    projectSlug: args.projectSlug ?? null,
    policies: [...projectionPolicies].sort((a, b) => a.policyId.localeCompare(b.policyId)),
    activeRuleIds,
    activeExceptionIds,
    policyVersionIds,
    nativePermissions: {
      claude: buildClaudeNativePermissionsProjection(policies),
      codex: buildCodexNativePermissionsProjection(policies),
    },
  } as const;
  const projectionHash = sha256(stableStringify(payload));
  return {
    ...payload,
    generatedAt: now.toISOString(),
    projectionHash,
  };
}
