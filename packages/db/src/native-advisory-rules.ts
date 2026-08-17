import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type { DbHandle } from './client.js';
import { publishPolicyVersion } from './policies.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

export const NATIVE_ADVISORY_POLICY_NAME = '__native_advisory__' as const;

export interface NativeAdvisoryRuleTemplate {
  readonly controlKey: string;
  readonly priority: number;
  readonly matchEventType: 'PreToolUse' | 'PostToolUse';
  readonly matchToolName: string;
  readonly matchPathGlob?: string | null;
  readonly matchCommandPattern?: string | null;
  readonly governanceVerdict: 'record' | 'advise' | 'warn';
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  readonly ruleType: 'tool_call' | 'bash_command' | 'file_protection' | 'release_readiness';
  readonly reason: string;
  readonly details: string;
}

export interface EnsureNativeAdvisoryRulesResult {
  readonly policyId: string;
  readonly created: boolean;
  readonly rulesInserted: number;
  readonly totalTemplates: number;
}

export const NATIVE_ADVISORY_RULE_TEMPLATES: readonly NativeAdvisoryRuleTemplate[] = [
  {
    controlKey: 'COODRA-GOV-005',
    priority: 1000,
    matchEventType: 'PostToolUse',
    matchToolName: '*',
    governanceVerdict: 'record',
    severity: 'low',
    ruleType: 'tool_call',
    reason: 'record agent-visible governance activity for COODRA-GOV-005',
    details: 'Detective advisory record for tool activity that may support governance traceability.',
  },
  {
    controlKey: 'COODRA-GOV-008',
    priority: 1001,
    matchEventType: 'PreToolUse',
    matchToolName: 'Bash',
    matchCommandPattern: 'git commit*',
    governanceVerdict: 'record',
    severity: 'medium',
    ruleType: 'bash_command',
    reason: 'record commit creation for COODRA-GOV-008 change traceability',
    details: 'Captures commit-producing shell activity for advisory governance evidence.',
  },
  {
    controlKey: 'COODRA-CLD-001',
    priority: 1002,
    matchEventType: 'PreToolUse',
    matchToolName: 'Bash',
    matchCommandPattern: '*terraform*',
    governanceVerdict: 'warn',
    severity: 'high',
    ruleType: 'bash_command',
    reason: 'terraform activity should be reviewed against cloud provisioning controls',
    details: 'Advisory signal for infrastructure-as-code commands; does not grant or deny permission.',
  },
  {
    controlKey: 'COODRA-CLD-002',
    priority: 1003,
    matchEventType: 'PreToolUse',
    matchToolName: 'Bash',
    matchCommandPattern: '*kubectl*',
    governanceVerdict: 'warn',
    severity: 'high',
    ruleType: 'bash_command',
    reason: 'kubectl activity should be reviewed against cluster governance controls',
    details: 'Advisory signal for Kubernetes operations from agent-visible command text.',
  },
  {
    controlKey: 'COODRA-CLD-006',
    priority: 1004,
    matchEventType: 'PreToolUse',
    matchToolName: 'Bash',
    matchCommandPattern: '*aws*',
    governanceVerdict: 'advise',
    severity: 'medium',
    ruleType: 'bash_command',
    reason: 'AWS CLI activity is tracked for cloud governance review',
    details: 'Advisory signal for cloud-provider command usage.',
  },
  {
    controlKey: 'COODRA-CLD-007',
    priority: 1005,
    matchEventType: 'PreToolUse',
    matchToolName: 'Bash',
    matchCommandPattern: '*az*',
    governanceVerdict: 'advise',
    severity: 'medium',
    ruleType: 'bash_command',
    reason: 'Azure CLI activity is tracked for cloud governance review',
    details: 'Advisory signal for cloud-provider command usage.',
  },
  {
    controlKey: 'COODRA-CLD-008',
    priority: 1006,
    matchEventType: 'PreToolUse',
    matchToolName: 'Bash',
    matchCommandPattern: '*gcloud*',
    governanceVerdict: 'advise',
    severity: 'medium',
    ruleType: 'bash_command',
    reason: 'Google Cloud CLI activity is tracked for cloud governance review',
    details: 'Advisory signal for cloud-provider command usage.',
  },
  {
    controlKey: 'COODRA-CLD-010',
    priority: 1007,
    matchEventType: 'PreToolUse',
    matchToolName: 'Bash',
    matchCommandPattern: '*docker*push*',
    governanceVerdict: 'record',
    severity: 'medium',
    ruleType: 'bash_command',
    reason: 'container image publishing is recorded for cloud release governance',
    details: 'Advisory record for image publication commands.',
  },
  {
    controlKey: 'COODRA-ARC-008',
    priority: 1008,
    matchEventType: 'PreToolUse',
    matchToolName: '*Edit',
    matchPathGlob: '**/*architecture*',
    governanceVerdict: 'advise',
    severity: 'medium',
    ruleType: 'tool_call',
    reason: 'architecture document edits should stay aligned to governance decisions',
    details: 'Advisory signal when an agent edits architecture-related files.',
  },
  {
    controlKey: 'COODRA-SEC-001',
    priority: 1009,
    matchEventType: 'PreToolUse',
    matchToolName: '*Edit',
    matchPathGlob: '**/*.env*',
    governanceVerdict: 'warn',
    severity: 'critical',
    ruleType: 'file_protection',
    reason: 'environment/secret-like file edits require security review evidence',
    details: 'Advisory companion to hard secret-protection rules; lower priority than preventive defaults.',
  },
  {
    controlKey: 'COODRA-SEC-002',
    priority: 1010,
    matchEventType: 'PreToolUse',
    matchToolName: 'Bash',
    matchCommandPattern: '*openssl*',
    governanceVerdict: 'record',
    severity: 'medium',
    ruleType: 'bash_command',
    reason: 'cryptographic command usage is recorded for security governance',
    details: 'Advisory evidence for crypto/secrets-adjacent shell activity.',
  },
  {
    controlKey: 'COODRA-SEC-003',
    priority: 1011,
    matchEventType: 'PreToolUse',
    matchToolName: 'Bash',
    matchCommandPattern: '*chmod 777*',
    governanceVerdict: 'warn',
    severity: 'high',
    ruleType: 'bash_command',
    reason: 'world-writable permission changes should be reviewed',
    details: 'Advisory signal for unsafe permission patterns.',
  },
  {
    controlKey: 'COODRA-SEC-008',
    priority: 1012,
    matchEventType: 'PreToolUse',
    matchToolName: '*Edit',
    matchPathGlob: '**/package.json',
    governanceVerdict: 'advise',
    severity: 'medium',
    ruleType: 'tool_call',
    reason: 'dependency manifest edits should include supply-chain review evidence',
    details: 'Advisory signal for dependency changes that may require security review.',
  },
  {
    controlKey: 'COODRA-SEC-009',
    priority: 1013,
    matchEventType: 'PreToolUse',
    matchToolName: 'Bash',
    matchCommandPattern: '*trivy*',
    governanceVerdict: 'record',
    severity: 'medium',
    ruleType: 'bash_command',
    reason: 'security scanning command usage is recorded for evidence',
    details: 'Advisory evidence for vulnerability scanning activity.',
  },
  {
    controlKey: 'COODRA-CMDB-003',
    priority: 1014,
    matchEventType: 'PreToolUse',
    matchToolName: '*Edit',
    matchPathGlob: '**/package.json',
    governanceVerdict: 'record',
    severity: 'medium',
    ruleType: 'tool_call',
    reason: 'application dependency metadata changes are recorded for CMDB evidence',
    details: 'Advisory record for package manifest edits.',
  },
  {
    controlKey: 'COODRA-CMDB-004',
    priority: 1015,
    matchEventType: 'PreToolUse',
    matchToolName: '*Edit',
    matchPathGlob: '**/Dockerfile',
    governanceVerdict: 'record',
    severity: 'medium',
    ruleType: 'tool_call',
    reason: 'runtime image metadata changes are recorded for CMDB evidence',
    details: 'Advisory record for Dockerfile edits.',
  },
  {
    controlKey: 'COODRA-REL-001',
    priority: 1016,
    matchEventType: 'PreToolUse',
    matchToolName: 'Bash',
    matchCommandPattern: '*test*',
    governanceVerdict: 'record',
    severity: 'low',
    ruleType: 'release_readiness',
    reason: 'test execution is recorded for release-readiness evidence',
    details: 'Advisory evidence for test activity.',
  },
  {
    controlKey: 'COODRA-REL-002',
    priority: 1017,
    matchEventType: 'PreToolUse',
    matchToolName: 'Bash',
    matchCommandPattern: '*lint*',
    governanceVerdict: 'record',
    severity: 'low',
    ruleType: 'release_readiness',
    reason: 'lint/static check execution is recorded for release-readiness evidence',
    details: 'Advisory evidence for static checks.',
  },
  {
    controlKey: 'COODRA-REL-006',
    priority: 1018,
    matchEventType: 'PreToolUse',
    matchToolName: 'Bash',
    matchCommandPattern: '*deploy*',
    governanceVerdict: 'warn',
    severity: 'high',
    ruleType: 'release_readiness',
    reason: 'deployment-like commands should have planned release approval context',
    details: 'Advisory signal for deployment-like shell activity.',
  },
  {
    controlKey: 'COODRA-REL-007',
    priority: 1019,
    matchEventType: 'PreToolUse',
    matchToolName: 'Bash',
    matchCommandPattern: '*rollback*',
    governanceVerdict: 'warn',
    severity: 'high',
    ruleType: 'release_readiness',
    reason: 'rollback-like commands should have incident/release context',
    details: 'Advisory signal for rollback-like shell activity.',
  },
];

export async function ensureNativeAdvisoryRules(
  db: DbHandle,
  projectId: string,
  policyName: string = NATIVE_ADVISORY_POLICY_NAME,
): Promise<EnsureNativeAdvisoryRulesResult> {
  if (db.kind === 'sqlite') {
    const existing = await db.db
      .select({ id: sqliteSchema.policies.id })
      .from(sqliteSchema.policies)
      .where(and(eq(sqliteSchema.policies.projectId, projectId), eq(sqliteSchema.policies.name, policyName)))
      .limit(1);
    const created = existing[0] === undefined;
    const policyId = existing[0]?.id ?? randomUUID();
    if (created) {
      await db.db.insert(sqliteSchema.policies).values({
        id: policyId,
        projectId,
        name: policyName,
        description: 'Native advisory controls seeded from the COOD-34 Track A control classification.',
        groupKey: 'governance_advisory',
        profile: 'native_advisory',
        enforcementMode: 'advisory',
        denyOnPolicyError: false,
        isActive: true,
      });
    }
    const existingRules = created
      ? []
      : await db.db
          .select({
            priority: sqliteSchema.policyRules.priority,
            matchEventType: sqliteSchema.policyRules.matchEventType,
            matchToolName: sqliteSchema.policyRules.matchToolName,
            matchPathGlob: sqliteSchema.policyRules.matchPathGlob,
            matchCommandPattern: sqliteSchema.policyRules.matchCommandPattern,
          })
          .from(sqliteSchema.policyRules)
          .where(eq(sqliteSchema.policyRules.policyId, policyId));
    const existingIdentities = new Set(existingRules.map(templateIdentity));
    const missing = NATIVE_ADVISORY_RULE_TEMPLATES.filter(
      (template) => !existingIdentities.has(templateIdentity(template)),
    );
    if (missing.length > 0) {
      await db.db.insert(sqliteSchema.policyRules).values(missing.map((template) => ruleRow(policyId, template)));
    }
    await publishPolicyVersion(db, policyId, {
      changeSummary: created ? 'Seeded native advisory controls' : 'Repaired native advisory controls',
    });
    return { policyId, created, rulesInserted: missing.length, totalTemplates: NATIVE_ADVISORY_RULE_TEMPLATES.length };
  }

  const existing = await db.db
    .select({ id: postgresSchema.policies.id })
    .from(postgresSchema.policies)
    .where(and(eq(postgresSchema.policies.projectId, projectId), eq(postgresSchema.policies.name, policyName)))
    .limit(1);
  const created = existing[0] === undefined;
  const policyId = existing[0]?.id ?? randomUUID();
  if (created) {
    await db.db.insert(postgresSchema.policies).values({
      id: policyId,
      projectId,
      name: policyName,
      description: 'Native advisory controls seeded from the COOD-34 Track A control classification.',
      groupKey: 'governance_advisory',
      profile: 'native_advisory',
      enforcementMode: 'advisory',
      denyOnPolicyError: false,
      isActive: true,
    });
  }
  const existingRules = created
    ? []
    : await db.db
        .select({
          priority: postgresSchema.policyRules.priority,
          matchEventType: postgresSchema.policyRules.matchEventType,
          matchToolName: postgresSchema.policyRules.matchToolName,
          matchPathGlob: postgresSchema.policyRules.matchPathGlob,
          matchCommandPattern: postgresSchema.policyRules.matchCommandPattern,
        })
        .from(postgresSchema.policyRules)
        .where(eq(postgresSchema.policyRules.policyId, policyId));
  const existingIdentities = new Set(existingRules.map(templateIdentity));
  const missing = NATIVE_ADVISORY_RULE_TEMPLATES.filter(
    (template) => !existingIdentities.has(templateIdentity(template)),
  );
  if (missing.length > 0) {
    await db.db.insert(postgresSchema.policyRules).values(missing.map((template) => ruleRow(policyId, template)));
  }
  await publishPolicyVersion(db, policyId, {
    changeSummary: created ? 'Seeded native advisory controls' : 'Repaired native advisory controls',
  });
  return { policyId, created, rulesInserted: missing.length, totalTemplates: NATIVE_ADVISORY_RULE_TEMPLATES.length };
}

function templateIdentity(template: {
  readonly priority: number;
  readonly matchEventType: string;
  readonly matchToolName: string;
  readonly matchPathGlob?: string | null;
  readonly matchCommandPattern?: string | null;
}): string {
  return `${template.priority}|${template.matchEventType}|${template.matchToolName}|${template.matchPathGlob ?? ''}|${template.matchCommandPattern ?? ''}`;
}

function ruleRow(policyId: string, template: NativeAdvisoryRuleTemplate) {
  return {
    id: randomUUID(),
    policyId,
    priority: template.priority,
    matchEventType: template.matchEventType,
    matchToolName: template.matchToolName,
    matchPathGlob: template.matchPathGlob ?? null,
    matchCommandPattern: template.matchCommandPattern ?? null,
    matchAgentType: '*',
    decision: 'allow' as const,
    enforcementDecision: 'allow' as const,
    governanceVerdict: template.governanceVerdict,
    enforcementMode: 'advisory',
    reason: template.reason,
    controlKey: template.controlKey,
    ruleType: template.ruleType,
    severity: template.severity,
    details: template.details,
  };
}
