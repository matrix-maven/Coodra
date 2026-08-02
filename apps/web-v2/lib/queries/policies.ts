import {
  type AddPolicyRuleArgs,
  type AddPolicyRuleResult,
  addPolicyRule as addPolicyRuleDb,
  createPolicyException as createPolicyExceptionDb,
  deletePolicyRule as deletePolicyRuleDb,
  getActivePolicyVersion as getActivePolicyVersionDb,
  getPolicy as getPolicyDb,
  listPolicies as listPoliciesDb,
  listPolicyExceptions as listPolicyExceptionsDb,
  listPolicyVersions as listPolicyVersionsDb,
  type PolicyExceptionRow,
  type PolicyExceptionScopeType,
  type PolicyExceptionStatus,
  type PolicyRow,
  type PolicyVersionRow,
  type PolicyWithRules,
  publishPolicyVersion as publishPolicyVersionDb,
  setPolicyActive as setPolicyActiveDb,
  type UpdatePolicyRuleArgs,
  updatePolicyExceptionStatus as updatePolicyExceptionStatusDb,
  updatePolicyRule as updatePolicyRuleDb,
} from '@coodra/db';

import { createWebDb } from '@/lib/db';

/**
 * `apps/web/lib/queries/policies.ts` — server-only wrappers around the
 * policies helpers from M08b S9 (`packages/db/src/policies.ts`). Every
 * server component / action that touches policies goes through here so
 * the storage-adapter selection stays centralised.
 */

export async function listPolicies(projectId: string | null = null): Promise<PolicyWithRules[]> {
  const handle = createWebDb();
  return listPoliciesDb(handle, projectId);
}

export async function getPolicy(identifier: string, projectId?: string): Promise<PolicyWithRules | null> {
  const handle = createWebDb();
  return getPolicyDb(handle, identifier, projectId === undefined ? {} : { projectId });
}

export async function addPolicyRule(args: AddPolicyRuleArgs): Promise<AddPolicyRuleResult> {
  const handle = createWebDb();
  return addPolicyRuleDb(handle, args);
}

export async function setPolicyActive(
  identifier: string,
  active: boolean,
  projectId?: string,
): Promise<PolicyRow | null> {
  const handle = createWebDb();
  return setPolicyActiveDb(handle, identifier, active, projectId === undefined ? {} : { projectId });
}

export async function deletePolicyRule(ruleId: string): Promise<boolean> {
  const handle = createWebDb();
  return deletePolicyRuleDb(handle, ruleId);
}

export async function updatePolicyRule(args: UpdatePolicyRuleArgs) {
  const handle = createWebDb();
  return updatePolicyRuleDb(handle, args);
}

export async function publishPolicyVersion(policyId: string, changeSummary?: string): Promise<PolicyVersionRow> {
  const handle = createWebDb();
  return publishPolicyVersionDb(handle, policyId, changeSummary !== undefined ? { changeSummary } : {});
}

export async function listPolicyVersions(policyId: string): Promise<PolicyVersionRow[]> {
  const handle = createWebDb();
  return listPolicyVersionsDb(handle, policyId);
}

export async function getActivePolicyVersion(policyId: string): Promise<PolicyVersionRow | null> {
  const handle = createWebDb();
  return getActivePolicyVersionDb(handle, policyId);
}

export async function listPolicyExceptions(projectId: string | null = null): Promise<PolicyExceptionRow[]> {
  const handle = createWebDb();
  return listPolicyExceptionsDb(handle, projectId);
}

export async function createPolicyException(args: {
  readonly projectId: string;
  readonly policyId: string;
  readonly policyVersionId?: string | null;
  readonly ruleId?: string | null;
  readonly scopeType: PolicyExceptionScopeType;
  readonly scopeJson?: string;
  readonly decisionOverride: 'allow' | 'deny' | 'ask';
  readonly reason: string;
  readonly justification: string;
  readonly startsAt?: Date | null;
  readonly expiresAt?: Date | null;
  readonly status?: PolicyExceptionStatus;
}): Promise<PolicyExceptionRow> {
  const handle = createWebDb();
  return createPolicyExceptionDb(handle, args);
}

export async function updatePolicyExceptionStatus(
  exceptionId: string,
  status: Extract<PolicyExceptionStatus, 'active' | 'revoked' | 'rejected'>,
): Promise<PolicyExceptionRow | null> {
  const handle = createWebDb();
  return updatePolicyExceptionStatusDb(handle, exceptionId, status);
}
