import {
  addPolicyRule,
  getPolicy,
  listPolicies,
  lookupProjectBySlug,
  type PolicyDecisionKind,
  type PolicyRow,
  type PolicyRuleRow,
  type PolicyWithRules,
  setPolicyActive,
} from '@coodra/contextos-db';
import pc from 'picocolors';

import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { resolveContextosDataDb, resolveContextosHome } from '../lib/contextos-home.js';
import { openLocalDb } from '../lib/open-local-db.js';

/**
 * `contextos policy {list|show|add|enable|disable}` — admin surface
 * for the `policies` + `policy_rules` tables.
 *
 * Module 08b S9. Ships five subcommands that replace the
 * `sqlite3 ~/.contextos/data.db "SELECT * FROM policies …"` workflow
 * operators have been using since M02.
 *
 * Cache-staleness note: the bridge's `createPolicyClient` caches
 * policy lookups for 60s. Mutations made via this CLI take up to
 * 60 seconds to be visible to a running bridge. Documented in
 * `spec.md §4.2` for operators who hit the gap.
 *
 * Local-only: this surface mutates `~/.contextos/data.db`. No sync
 * to cloud. The cross-developer admin path is M04's surface.
 */

const VALID_DECISIONS: ReadonlyArray<PolicyDecisionKind> = ['allow', 'deny', 'ask'];

export interface PolicyListOptions {
  readonly project?: string;
  readonly json?: boolean;
}

export interface PolicyShowOptions {
  readonly project?: string;
  readonly json?: boolean;
}

export interface PolicyAddOptions {
  readonly project: string;
  readonly tool: string;
  readonly decision: string;
  readonly reason: string;
  readonly eventType?: string;
  readonly pathGlob?: string;
  readonly agentType?: string;
  readonly priority?: string;
  readonly policyName?: string;
  readonly json?: boolean;
}

export interface PolicyEnableDisableOptions {
  readonly project?: string;
  readonly json?: boolean;
}

export interface PolicyIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
  readonly contextosHome?: string;
}

export const DEFAULT_POLICY_IO: PolicyIO = {
  writeStdout: (chunk) => {
    process.stdout.write(chunk);
  },
  writeStderr: (chunk) => {
    process.stderr.write(chunk);
  },
  exit: (code) => {
    process.exit(code);
  },
};

// ============================================================================
// list
// ============================================================================

export async function runPolicyListCommand(options: PolicyListOptions, ioOverride?: PolicyIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_POLICY_IO;
  const json = options.json === true;
  const handle = await openHandle(io);
  try {
    let projectId: string | null = null;
    if (options.project !== undefined && options.project.length > 0) {
      const project = await lookupProjectBySlug(handle, options.project.trim());
      if (project === null) {
        return surfaceError(io, json, EXIT_USER_RECOVERABLE, `project slug "${options.project}" does not exist`);
      }
      projectId = project.id;
    }
    const policies = await listPolicies(handle, projectId);
    if (json) {
      io.writeStdout(`${JSON.stringify({ ok: true, policies: policies.map(serializePolicy) }, null, 2)}\n`);
    } else if (policies.length === 0) {
      io.writeStdout(
        options.project !== undefined
          ? `${pc.dim('—')} no policies for project "${options.project}".\n`
          : `${pc.dim('—')} no policies in this contextos store.\n`,
      );
    } else {
      for (const p of policies) {
        printPolicyHuman(io, p);
        io.writeStdout('\n');
      }
    }
    io.exit(EXIT_OK);
  } finally {
    handle.close();
  }
}

// ============================================================================
// show
// ============================================================================

export async function runPolicyShowCommand(
  identifier: string,
  options: PolicyShowOptions,
  ioOverride?: PolicyIO,
): Promise<void> {
  const io = ioOverride ?? DEFAULT_POLICY_IO;
  const json = options.json === true;
  if (identifier.trim().length === 0) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, 'policy show requires <identifier> (id or name)');
  }
  const handle = await openHandle(io);
  try {
    let projectId: string | undefined;
    if (options.project !== undefined && options.project.length > 0) {
      const project = await lookupProjectBySlug(handle, options.project.trim());
      if (project === null) {
        return surfaceError(io, json, EXIT_USER_RECOVERABLE, `project slug "${options.project}" does not exist`);
      }
      projectId = project.id;
    }
    const policy = await getPolicy(handle, identifier.trim(), projectId !== undefined ? { projectId } : {});
    if (policy === null) {
      return surfaceError(
        io,
        json,
        EXIT_USER_RECOVERABLE,
        `no policy with id or name "${identifier}"${options.project !== undefined ? ` in project "${options.project}"` : ''}`,
      );
    }
    if (json) {
      io.writeStdout(`${JSON.stringify({ ok: true, policy: serializePolicy(policy) }, null, 2)}\n`);
    } else {
      printPolicyHuman(io, policy);
    }
    io.exit(EXIT_OK);
  } finally {
    handle.close();
  }
}

// ============================================================================
// add
// ============================================================================

export async function runPolicyAddCommand(options: PolicyAddOptions, ioOverride?: PolicyIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_POLICY_IO;
  const json = options.json === true;
  if (options.project.trim().length === 0) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, '--project <slug> is required');
  }
  if (options.tool.trim().length === 0) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, '--tool <name> is required');
  }
  if (!VALID_DECISIONS.includes(options.decision as PolicyDecisionKind)) {
    return surfaceError(
      io,
      json,
      EXIT_USER_RECOVERABLE,
      `--decision must be one of ${VALID_DECISIONS.join(', ')} (got "${options.decision}")`,
    );
  }
  if (options.reason.trim().length === 0) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, '--reason <text> is required (operator audit context)');
  }

  let priority: number | undefined;
  if (options.priority !== undefined) {
    priority = Number(options.priority);
    if (!Number.isInteger(priority) || priority < 0) {
      return surfaceError(
        io,
        json,
        EXIT_USER_RECOVERABLE,
        `--priority must be a non-negative integer (got "${options.priority}")`,
      );
    }
  }

  const handle = await openHandle(io);
  try {
    const project = await lookupProjectBySlug(handle, options.project.trim());
    if (project === null) {
      return surfaceError(
        io,
        json,
        EXIT_USER_RECOVERABLE,
        `project slug "${options.project}" does not exist. Run \`contextos init --project-slug ${options.project}\` in the project root first.`,
      );
    }
    const result = await addPolicyRule(handle, {
      projectId: project.id,
      ...(options.policyName !== undefined ? { policyName: options.policyName } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(options.eventType !== undefined ? { matchEventType: options.eventType } : {}),
      matchToolName: options.tool.trim(),
      ...(options.pathGlob !== undefined ? { matchPathGlob: options.pathGlob } : {}),
      ...(options.agentType !== undefined ? { matchAgentType: options.agentType } : {}),
      decision: options.decision as PolicyDecisionKind,
      reason: options.reason,
    });
    if (json) {
      io.writeStdout(
        `${JSON.stringify(
          {
            ok: true,
            policyId: result.policyId,
            policyCreated: result.policyCreated,
            ruleId: result.ruleId,
            priority: result.priority,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      const created = result.policyCreated ? ' (auto-created policy)' : '';
      io.writeStdout(
        `${pc.green('✓')} Added policy_rule (priority=${result.priority}, decision=${options.decision}) to policy ${result.policyId}${created}.\n`,
      );
      io.writeStdout(`  Rule id: ${result.ruleId}\n`);
      io.writeStdout(
        `  ${pc.dim('Note: bridge cache TTL is 60s; running bridges will see the rule on the next cache miss.')}\n`,
      );
    }
    io.exit(EXIT_OK);
  } finally {
    handle.close();
  }
}

// ============================================================================
// enable / disable
// ============================================================================

export async function runPolicyEnableCommand(
  identifier: string,
  options: PolicyEnableDisableOptions,
  ioOverride?: PolicyIO,
): Promise<void> {
  await runPolicySetActive(identifier, true, options, ioOverride);
}

export async function runPolicyDisableCommand(
  identifier: string,
  options: PolicyEnableDisableOptions,
  ioOverride?: PolicyIO,
): Promise<void> {
  await runPolicySetActive(identifier, false, options, ioOverride);
}

async function runPolicySetActive(
  identifier: string,
  active: boolean,
  options: PolicyEnableDisableOptions,
  ioOverride?: PolicyIO,
): Promise<void> {
  const io = ioOverride ?? DEFAULT_POLICY_IO;
  const json = options.json === true;
  if (identifier.trim().length === 0) {
    return surfaceError(
      io,
      json,
      EXIT_USER_RECOVERABLE,
      `policy ${active ? 'enable' : 'disable'} requires <identifier>`,
    );
  }
  const handle = await openHandle(io);
  try {
    let projectId: string | undefined;
    if (options.project !== undefined && options.project.length > 0) {
      const project = await lookupProjectBySlug(handle, options.project.trim());
      if (project === null) {
        return surfaceError(io, json, EXIT_USER_RECOVERABLE, `project slug "${options.project}" does not exist`);
      }
      projectId = project.id;
    }
    const updated = await setPolicyActive(
      handle,
      identifier.trim(),
      active,
      projectId !== undefined ? { projectId } : {},
    );
    if (updated === null) {
      return surfaceError(
        io,
        json,
        EXIT_USER_RECOVERABLE,
        `no policy with id or name "${identifier}"${options.project !== undefined ? ` in project "${options.project}"` : ''}`,
      );
    }
    if (json) {
      io.writeStdout(`${JSON.stringify({ ok: true, policy: serializePolicy({ ...updated, rules: [] }) }, null, 2)}\n`);
    } else {
      const verb = active ? 'enabled' : 'disabled';
      io.writeStdout(`${pc.green('✓')} Policy "${updated.name}" (id: ${updated.id}) is now ${verb}.\n`);
    }
    io.exit(EXIT_OK);
  } finally {
    handle.close();
  }
}

// ============================================================================
// helpers
// ============================================================================

async function openHandle(io: PolicyIO): Promise<Awaited<ReturnType<typeof openLocalDb>>> {
  const homePath = io.contextosHome ?? resolveContextosHome();
  const dbPath = resolveContextosDataDb(homePath);
  return await openLocalDb(dbPath);
}

interface SerializedPolicy {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly rules: ReadonlyArray<SerializedRule>;
}

interface SerializedRule {
  readonly id: string;
  readonly priority: number;
  readonly matchEventType: string;
  readonly matchToolName: string;
  readonly matchPathGlob: string | null;
  readonly matchAgentType: string | null;
  readonly decision: string;
  readonly reason: string;
  readonly createdAt: string;
}

function serializePolicy(p: PolicyWithRules): SerializedPolicy {
  return {
    id: p.id,
    projectId: p.projectId,
    name: p.name,
    description: p.description,
    isActive: p.isActive,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    rules: p.rules.map(serializeRule),
  };
}

function serializeRule(r: PolicyRuleRow): SerializedRule {
  return {
    id: r.id,
    priority: r.priority,
    matchEventType: r.matchEventType,
    matchToolName: r.matchToolName,
    matchPathGlob: r.matchPathGlob,
    matchAgentType: r.matchAgentType,
    decision: r.decision,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  };
}

function printPolicyHuman(io: PolicyIO, p: PolicyRow & { readonly rules?: ReadonlyArray<PolicyRuleRow> }): void {
  const status = p.isActive ? pc.green('active') : pc.dim('disabled');
  io.writeStdout(`${pc.bold(p.name)} (${status}) — id: ${p.id}\n`);
  io.writeStdout(`  project: ${p.projectId}\n`);
  if (p.description !== null && p.description.length > 0) {
    io.writeStdout(`  description: ${p.description}\n`);
  }
  const rules = p.rules ?? [];
  if (rules.length === 0) {
    io.writeStdout(`  ${pc.dim('(no rules)')}\n`);
    return;
  }
  io.writeStdout(`  rules (${rules.length}):\n`);
  for (const r of rules) {
    const decisionColor = r.decision === 'deny' ? pc.red : r.decision === 'allow' ? pc.green : pc.yellow;
    io.writeStdout(
      `    [${String(r.priority).padStart(3, ' ')}] ${decisionColor(r.decision.padEnd(5, ' '))} ${r.matchEventType} ${r.matchToolName}${r.matchPathGlob !== null ? ` ${r.matchPathGlob}` : ''}${r.matchAgentType !== null && r.matchAgentType !== '*' ? ` agent=${r.matchAgentType}` : ''}\n`,
    );
  }
}

function surfaceError(io: PolicyIO, json: boolean, exitCode: number, message: string): void {
  if (json) {
    io.writeStdout(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  } else {
    io.writeStderr(`${pc.red('error')}: ${message}\n`);
  }
  io.exit(exitCode);
}
