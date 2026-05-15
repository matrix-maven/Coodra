import {
  type AddPolicyRuleArgs,
  type AddPolicyRuleResult,
  addPolicyRule as addPolicyRuleDb,
  getPolicy as getPolicyDb,
  listPolicies as listPoliciesDb,
  type PolicyRow,
  type PolicyWithRules,
  setPolicyActive as setPolicyActiveDb,
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
