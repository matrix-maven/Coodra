import { randomUUID } from 'node:crypto';
import { createLogger } from '@coodra/shared';
import { and, eq } from 'drizzle-orm';

import type { DbHandle } from './client.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

/**
 * `packages/db/src/ensure-default-policy` — seeds a baseline Policy
 * + first-match-wins rule set for a project so a fresh
 * `coodra init` ships with real policy enforcement on day one.
 *
 * Phase 3 Fix D (2026-05-02 — closes Phase 2 verification finding
 * F5/F8): pre-Phase-3 init created the project row but inserted
 * zero policy rules. The MCP `check_policy` evaluator returned
 * `'allow'` for everything because no rule ever matched. Fix D
 * seeded a default Policy named `'__default__'` with rules covering
 * `Write` and `Edit` against `.env`, `.git/**`, `node_modules/**`.
 *
 * **Phase 4 Fix F (2026-05-02 — caught during demo rehearsal):**
 *
 *   The Phase 3 rule set covered only TWO file-mutating tools
 *   (Write, Edit). Claude Code / Cursor / Windsurf actually fire
 *   FOUR distinct file-mutating tool names: Write, Edit, MultiEdit,
 *   NotebookEdit. PreToolUse calls naming MultiEdit or NotebookEdit
 *   sailed through the evaluator's "no rule matched → allow"
 *   default. Result: an agent invoking `MultiEdit` against `.env`
 *   slipped past the protection users believed was in place.
 *
 *   The Phase 3 globs also missed nested `.git/` and nested
 *   `node_modules/` (e.g. submodules + monorepo workspaces) —
 *   `.git/**` matches `.git/HEAD` but NOT `apps/foo/.git/HEAD`.
 *
 *   Phase 4 Fix F expands DEFAULT_RULES to the full cross-product:
 *
 *     tools = { Write, Edit, MultiEdit, NotebookEdit }
 *     globs = { .env, **\/.env, .git/**, **\/.git/**,
 *               node_modules/**, **\/node_modules/** }
 *
 *   Plus the existing `Bash → ask` rule. 24 deny rules + 1 ask = 25.
 *
 *   The matcher in `~/.claude/settings.json` is fixed in the same
 *   slice — see `packages/cli/src/lib/init/claude-settings-merge.ts`.
 *
 * **Existing-install repair semantics (Phase 4 Fix F):**
 *
 *   `ensureDefaultPolicy` now performs an additive merge:
 *
 *     - If `__default__` policy doesn't exist → insert + all rules.
 *     - If it exists but is missing some rules from DEFAULT_RULES
 *       (matched by `(priority, matchEventType, matchToolName,
 *        matchPathGlob)`) → insert only the missing rules.
 *     - Existing rules (including any user-modified or user-added
 *       ones) are NEVER deleted or updated.
 *
 *   Re-running `coodra init` on a Phase 3 install brings the
 *   default rule set up to current. Re-running on an already-current
 *   install is a no-op (`rulesInserted: 0`).
 *
 * Idempotency: keyed on `(projectId, name='__default__')` for the
 * policy row, and on `(priority, matchEventType, matchToolName,
 * matchPathGlob)` for each rule. A `--force` flag is NOT supported
 * — once a user customizes their policy, re-running init never
 * overwrites their tuning, only fills gaps.
 */

const seedLogger = createLogger('db.ensure-default-policy');

const DEFAULT_POLICY_NAME = '__default__' as const;
const DEFAULT_POLICY_DESCRIPTION =
  'Default policy seeded by `coodra init` (Phase 3 Fix D + Phase 4 Fix F, 2026-05-02). ' +
  'Denies file-mutating tools (Write, Edit, MultiEdit, NotebookEdit) writing to ' +
  '.env / **/.env / .git/** / **/.git/** / node_modules/** / **/node_modules/**; ' +
  'asks before Bash. Edit via `policy` UI or by writing custom rules with higher priority.';

interface DefaultRuleSpec {
  readonly priority: number;
  readonly matchEventType: string;
  readonly matchToolName: string;
  readonly matchPathGlob: string | null;
  readonly matchAgentType: string;
  readonly decision: 'allow' | 'deny' | 'ask';
  readonly reason: string;
}

/**
 * The six dangerous-path globs every file-mutating tool must be
 * denied against. Each glob has a stable suffix appended to the
 * priority offset assigned to each tool (Write 10-15, Edit 40-45,
 * MultiEdit 80-85, NotebookEdit 90-95). The Phase-3 priorities for
 * Write+Edit (10, 11, 20, 30, 40, 41, 50, 60) are preserved for
 * existing-install compatibility — Phase 4 only adds new priorities
 * (12-13, 42-43, 80-95). The additive-merge logic below uses the
 * `(priority, eventType, toolName, pathGlob)` 4-tuple as the rule
 * identity so the Phase 3 rules at priorities 10/11/20/30/40/41/50/60
 * are recognised as already-present and not re-inserted.
 */

const DENY_REASONS: Readonly<Record<string, string>> = {
  '.env': 'writes to .env are denied — secrets must not flow through agent edits',
  '**/.env': 'writes to nested .env are denied — secrets must not flow through agent edits',
  '.git/**': 'writes inside .git/** are denied — repository metadata is owned by `git`, not the agent',
  '**/.git/**':
    'writes inside nested .git/** (submodules, monorepo workspaces) are denied — repository metadata is owned by `git`, not the agent',
  'node_modules/**': 'writes inside node_modules/** are denied — install via package manager, never edit by hand',
  '**/node_modules/**':
    'writes inside nested node_modules/** (workspace packages) are denied — install via package manager, never edit by hand',
};

interface ToolPriorityBlock {
  readonly toolName: string;
  /** Priorities aligned with the six globs in order. The first two
   * for `.env` + `**\/.env` were Phase-3 (10/11, 40/41) for Write/Edit
   * and are NEW for MultiEdit/NotebookEdit — picking 80-95 keeps
   * those after existing rules without colliding. */
  readonly priorities: readonly [number, number, number, number, number, number];
}

const TOOL_BLOCKS: readonly ToolPriorityBlock[] = [
  // Phase-3 Write rules: 10 (.env), 11 (**/.env), 20 (.git/**), 30 (node_modules/**).
  // Phase-4 NEW Write rules:                       12 (**/.git/**), 13 (**/node_modules/**).
  { toolName: 'Write', priorities: [10, 11, 20, 12, 30, 13] },
  // Phase-3 Edit rules:  40 (.env), 41 (**/.env), 50 (.git/**), 60 (node_modules/**).
  // Phase-4 NEW Edit rules:                       42 (**/.git/**), 43 (**/node_modules/**).
  { toolName: 'Edit', priorities: [40, 41, 50, 42, 60, 43] },
  // Phase-4 NEW MultiEdit rules across all six globs.
  { toolName: 'MultiEdit', priorities: [80, 81, 82, 83, 84, 85] },
  // Phase-4 NEW NotebookEdit rules across all six globs.
  { toolName: 'NotebookEdit', priorities: [90, 91, 92, 93, 94, 95] },
];

const GLOBS_IN_BLOCK_ORDER: readonly (keyof typeof DENY_REASONS)[] = [
  '.env',
  '**/.env',
  '.git/**',
  '**/.git/**',
  'node_modules/**',
  '**/node_modules/**',
];

function buildToolBlockRules(block: ToolPriorityBlock): DefaultRuleSpec[] {
  return GLOBS_IN_BLOCK_ORDER.map((glob, i) => ({
    priority: block.priorities[i] ?? 0,
    matchEventType: 'PreToolUse',
    matchToolName: block.toolName,
    matchPathGlob: glob,
    matchAgentType: '*',
    decision: 'deny' as const,
    reason: DENY_REASONS[glob] ?? `${block.toolName} → ${glob} is denied`,
  }));
}

const BASH_ASK_RULE: DefaultRuleSpec = {
  priority: 70,
  matchEventType: 'PreToolUse',
  matchToolName: 'Bash',
  matchPathGlob: null,
  matchAgentType: '*',
  decision: 'ask',
  reason:
    'Bash invocations require user confirmation — destructive commands (rm -rf, git push --force) are easy to slip through, and shell redirects (echo X > .env) bypass the file-tool deny rules above',
};

export const DEFAULT_RULES: readonly DefaultRuleSpec[] = [...TOOL_BLOCKS.flatMap(buildToolBlockRules), BASH_ASK_RULE];

export interface EnsureDefaultPolicyResult {
  readonly policyId: string;
  /** True only when the `__default__` policy row was just inserted. */
  readonly created: boolean;
  /**
   * Number of rules inserted on THIS call. Phase 4 Fix F changed
   * the semantics — for an existing policy this is the count of
   * MISSING-from-DEFAULT_RULES rules added on this call, not 0.
   * Idempotent re-run on an already-current install returns 0.
   */
  readonly rulesInserted: number;
}

/**
 * 4-tuple uniquely identifying a default rule. Used to detect which
 * DEFAULT_RULES entries are absent from an existing policy so the
 * additive-merge inserts only what's missing.
 */
function ruleIdentity(spec: {
  priority: number;
  matchEventType: string;
  matchToolName: string;
  matchPathGlob: string | null;
}): string {
  return `${spec.priority}|${spec.matchEventType}|${spec.matchToolName}|${spec.matchPathGlob ?? ''}`;
}

export async function ensureDefaultPolicy(db: DbHandle, projectId: string): Promise<EnsureDefaultPolicyResult> {
  if (db.kind === 'sqlite') {
    const existing = await db.db
      .select({ id: sqliteSchema.policies.id })
      .from(sqliteSchema.policies)
      .where(and(eq(sqliteSchema.policies.projectId, projectId), eq(sqliteSchema.policies.name, DEFAULT_POLICY_NAME)))
      .limit(1);
    const existingPolicyId = existing[0]?.id;

    let policyId: string;
    let created: boolean;
    if (existingPolicyId === undefined) {
      policyId = randomUUID();
      await db.db.insert(sqliteSchema.policies).values({
        id: policyId,
        projectId,
        name: DEFAULT_POLICY_NAME,
        description: DEFAULT_POLICY_DESCRIPTION,
        isActive: true,
      });
      created = true;
    } else {
      policyId = existingPolicyId;
      created = false;
    }

    const existingRules = created
      ? []
      : await db.db
          .select({
            priority: sqliteSchema.policyRules.priority,
            matchEventType: sqliteSchema.policyRules.matchEventType,
            matchToolName: sqliteSchema.policyRules.matchToolName,
            matchPathGlob: sqliteSchema.policyRules.matchPathGlob,
          })
          .from(sqliteSchema.policyRules)
          .where(eq(sqliteSchema.policyRules.policyId, policyId));
    const existingIdentities = new Set(existingRules.map(ruleIdentity));
    const missingSpecs = DEFAULT_RULES.filter((spec) => !existingIdentities.has(ruleIdentity(spec)));

    if (missingSpecs.length > 0) {
      const ruleRows = missingSpecs.map((spec) => ({
        id: randomUUID(),
        policyId,
        priority: spec.priority,
        matchEventType: spec.matchEventType,
        matchToolName: spec.matchToolName,
        matchPathGlob: spec.matchPathGlob,
        matchAgentType: spec.matchAgentType,
        decision: spec.decision,
        reason: spec.reason,
      }));
      await db.db.insert(sqliteSchema.policyRules).values(ruleRows);
    }

    seedLogger.info(
      {
        event: created ? 'default_policy_seeded' : 'default_policy_repaired',
        projectId,
        policyId,
        created,
        rulesInserted: missingSpecs.length,
      },
      created
        ? 'inserted default policy + full baseline rule set (Phase 3 Fix D + Phase 4 Fix F)'
        : missingSpecs.length > 0
          ? 'default policy already present — additively repaired missing baseline rules (Phase 4 Fix F)'
          : 'default policy already present — all baseline rules accounted for',
    );
    return { policyId, created, rulesInserted: missingSpecs.length };
  }

  // postgres — same logic, mirrored against postgresSchema.
  const existing = await db.db
    .select({ id: postgresSchema.policies.id })
    .from(postgresSchema.policies)
    .where(and(eq(postgresSchema.policies.projectId, projectId), eq(postgresSchema.policies.name, DEFAULT_POLICY_NAME)))
    .limit(1);
  const existingPolicyId = existing[0]?.id;

  let policyId: string;
  let created: boolean;
  if (existingPolicyId === undefined) {
    policyId = randomUUID();
    await db.db.insert(postgresSchema.policies).values({
      id: policyId,
      projectId,
      name: DEFAULT_POLICY_NAME,
      description: DEFAULT_POLICY_DESCRIPTION,
      isActive: true,
    });
    created = true;
  } else {
    policyId = existingPolicyId;
    created = false;
  }

  const existingRules = created
    ? []
    : await db.db
        .select({
          priority: postgresSchema.policyRules.priority,
          matchEventType: postgresSchema.policyRules.matchEventType,
          matchToolName: postgresSchema.policyRules.matchToolName,
          matchPathGlob: postgresSchema.policyRules.matchPathGlob,
        })
        .from(postgresSchema.policyRules)
        .where(eq(postgresSchema.policyRules.policyId, policyId));
  const existingIdentities = new Set(existingRules.map(ruleIdentity));
  const missingSpecs = DEFAULT_RULES.filter((spec) => !existingIdentities.has(ruleIdentity(spec)));

  if (missingSpecs.length > 0) {
    const ruleRows = missingSpecs.map((spec) => ({
      id: randomUUID(),
      policyId,
      priority: spec.priority,
      matchEventType: spec.matchEventType,
      matchToolName: spec.matchToolName,
      matchPathGlob: spec.matchPathGlob,
      matchAgentType: spec.matchAgentType,
      decision: spec.decision,
      reason: spec.reason,
    }));
    await db.db.insert(postgresSchema.policyRules).values(ruleRows);
  }

  seedLogger.info(
    {
      event: created ? 'default_policy_seeded' : 'default_policy_repaired',
      projectId,
      policyId,
      created,
      rulesInserted: missingSpecs.length,
    },
    created
      ? 'inserted default policy + full baseline rule set (Phase 3 Fix D + Phase 4 Fix F)'
      : missingSpecs.length > 0
        ? 'default policy already present — additively repaired missing baseline rules (Phase 4 Fix F)'
        : 'default policy already present — all baseline rules accounted for',
  );
  return { policyId, created, rulesInserted: missingSpecs.length };
}
