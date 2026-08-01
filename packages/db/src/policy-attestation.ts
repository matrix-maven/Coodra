import {
  expectedCodexProjectionBlockContentHash,
  hashPolicyProjectionSurface,
  type PolicyProjectionReadResult,
  readClaudePolicyProjection,
  readCodexPolicyProjection,
} from '@coodra/shared';

import { insertAuditEvent } from './audit-events.js';
import type { DbHandle } from './client.js';
import { buildPolicyProjection } from './policy-projection.js';

export type PolicyProjectionAttestationStatus = 'match' | 'missing' | 'drift' | 'unsupported_agent';

export interface AttestPolicyProjectionArgs {
  readonly projectId: string;
  readonly projectSlug: string | null;
  readonly projectRoot: string;
  readonly agentType: string;
  readonly sessionId?: string;
  readonly runId?: string | null;
  readonly now?: Date;
}

export interface PolicyProjectionAttestation {
  readonly status: PolicyProjectionAttestationStatus;
  readonly expectedHash: string;
  readonly actualHash: string | null;
  readonly configPath: string | null;
  readonly eventId: string;
}

async function readProjectionForAgent(
  projectRoot: string,
  agentType: string,
): Promise<PolicyProjectionReadResult | null> {
  if (agentType === 'claude_code' || agentType === 'claude') {
    return await readClaudePolicyProjection(projectRoot);
  }
  if (agentType === 'codex') {
    return await readCodexPolicyProjection(projectRoot);
  }
  return null;
}

export async function attestPolicyProjection(
  db: DbHandle,
  args: AttestPolicyProjectionArgs,
): Promise<PolicyProjectionAttestation> {
  const now = args.now ?? new Date();
  const expected = await buildPolicyProjection(db, {
    projectId: args.projectId,
    projectSlug: args.projectSlug,
    now,
  });
  const actual = await readProjectionForAgent(args.projectRoot, args.agentType);
  const expectedNativePermissionsHash =
    args.agentType === 'codex'
      ? (expected.nativePermissions?.codex?.projectionHash ?? null)
      : args.agentType === 'claude_code' || args.agentType === 'claude'
        ? (expected.nativePermissions?.claude?.projectionHash ?? null)
        : null;
  const nativePermissionsMatch =
    expectedNativePermissionsHash === null || actual?.permissionsHash === expectedNativePermissionsHash;
  const expectedProjectionContentHash =
    args.agentType === 'codex'
      ? expectedCodexProjectionBlockContentHash(expected)
      : hashPolicyProjectionSurface(expected);
  const projectionContentMatch = actual?.projectionContentHash === expectedProjectionContentHash;
  const status: PolicyProjectionAttestationStatus =
    actual === null
      ? 'unsupported_agent'
      : actual.projectionHash === null
        ? 'missing'
        : actual.projectionHash === expected.projectionHash &&
            projectionContentMatch &&
            nativePermissionsMatch &&
            (actual.missingNativePermissions?.length ?? 0) === 0
          ? 'match'
          : 'drift';
  const event = await insertAuditEvent(db, {
    projectId: args.projectId,
    runId: args.runId ?? null,
    actorRunId: args.runId ?? null,
    eventType: status === 'match' ? 'policy.config.attested' : 'policy.config.drift_detected',
    subjectTable: 'projects',
    subjectId: args.projectId,
    action: status === 'match' ? 'attest' : 'detect_drift',
    result: status,
    reason:
      status === 'match'
        ? 'Coodra-managed policy projection matched the DB source of truth at SessionStart.'
        : 'Coodra-managed policy projection is missing, stale, or unsupported; DB hook policy remains authoritative.',
    beforeHash: actual?.projectionHash ?? null,
    afterHash: expected.projectionHash,
    metadata: {
      projectSlug: args.projectSlug,
      projectRoot: args.projectRoot,
      agentType: args.agentType,
      sessionId: args.sessionId,
      configPath: actual?.path ?? null,
      configExists: actual?.exists ?? false,
      expectedHash: expected.projectionHash,
      actualHash: actual?.projectionHash ?? null,
      expectedProjectionContentHash,
      actualProjectionContentHash: actual?.projectionContentHash ?? null,
      expectedPermissionsHash: expectedNativePermissionsHash,
      actualPermissionsHash: actual?.permissionsHash ?? null,
      missingNativePermissions: actual?.missingNativePermissions ?? [],
      warnings: actual?.warnings ?? [],
      activeRuleIds: expected.activeRuleIds,
      activeExceptionIds: expected.activeExceptionIds,
      policyVersionIds: expected.policyVersionIds,
      error: actual?.error,
    },
  });
  return {
    status,
    expectedHash: expected.projectionHash,
    actualHash: actual?.projectionHash ?? null,
    configPath: actual?.path ?? null,
    eventId: event.id,
  };
}

export function renderPolicyProjectionDriftContext(attestation: PolicyProjectionAttestation): string | null {
  if (attestation.status === 'match') return null;
  return [
    '## Coodra policy projection drift',
    '',
    'Coodra detected that the agent config policy projection is missing or stale.',
    'The database policy evaluated by Coodra hooks remains authoritative for allow/ask/deny decisions.',
    '',
    `Expected: \`${attestation.expectedHash}\``,
    `Actual: \`${attestation.actualHash ?? 'missing'}\``,
    attestation.configPath !== null ? `Config: \`${attestation.configPath}\`` : null,
    '',
    'Run `coodra policy sync` from the project root after intentional policy changes.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}
