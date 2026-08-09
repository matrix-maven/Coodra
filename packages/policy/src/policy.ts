import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import {
  BrokenCircuitError,
  ConsecutiveBreaker,
  circuitBreaker,
  handleAll,
  IsolatedCircuitError,
  TaskCancelledError,
  TimeoutStrategy,
  timeout,
  wrap,
} from 'cockatiel';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import picomatch from 'picomatch';

import type {
  PolicyCheck,
  PolicyClient,
  PolicyDecision,
  PolicyEnforcementMode,
  PolicyGovernanceVerdict,
  PolicyInput,
  PolicyResult,
} from './types.js';

/**
 * `@coodra/policy` — cache-first policy evaluator backed by the
 * `policies` + `policy_rules` DB tables, wrapped in a cockatiel
 * timeout-then-breaker fuse, fail-open on every error path.
 *
 * Module 03 S3 moved this file from `apps/mcp-server/src/lib/policy.ts`.
 * The original location remains as a thin re-export shim for the
 * duration of one slice; both `apps/mcp-server` (check_policy tool +
 * registry pre/post wrap) and `apps/hooks-bridge` (pre-tool-use hook
 * handler) depend on the same evaluator instance.
 *
 * Wiring:
 *   - mcp-server's `src/index.ts` calls `createPolicyClient({ db, ... })`
 *     once at boot with the local `DbHandle`.
 *   - hooks-bridge's `src/index.ts` (Module 03 S5) calls the same
 *     factory with its own local `DbHandle`. Both instances share
 *     this code; neither depends on the other.
 *
 * Fail-open contract (`system-architecture.md` §7):
 *
 *   Any of the following returns `{ decision: 'allow',
 *   reason: 'policy_check_unavailable', matchedRuleId: null }`:
 *     - breaker is open                 (cockatiel `BrokenCircuitError`)
 *     - breaker is isolated             (cockatiel `IsolatedCircuitError`)
 *     - per-call timeout tripped        (cockatiel `TaskCancelledError`)
 *     - DB throws a non-breaker error   (any other Error)
 *     - rule-cache refill failed mid-eval
 *
 *   The only `deny` ever returned is from a rule that explicitly
 *   matched with `decision = 'deny'`. §7 defines this as the only
 *   intentional block.
 *
 * Cache (`system-architecture.md` §5: Policy Evaluation → AP):
 *
 *   In-process rule cache with a 60s TTL. Cache key is `projectId`
 *   when the caller supplies it (S14 of Module 02 added the slot);
 *   callers that omit `projectId` hit the `__global__` slot with
 *   every-project rules loaded.
 *
 * Audit writes (`system-architecture.md` §4.3):
 *
 *   `recordPolicyDecision(db, args)` is the wire code for the audit
 *   write to `policy_decisions`. Callers (the MCP `check_policy` tool
 *   and the Module 03 hooks-bridge pre-tool handler) dispatch via
 *   `setImmediate(...)` per Q-02-2; this function is synchronous-
 *   throwing so the caller's `.catch()` sees the error.
 */

const policyLogger = createLogger('policy');

/**
 * Deterministic 32-bit FNV-1a hash → 8-char hex. Sync + dependency-free
 * (works in every runtime — no node:crypto import). Used only to
 * disambiguate audit-key collisions, so cryptographic strength is not
 * required; collision probability across one session's tool inputs is
 * negligible.
 */
function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * `pd:{sessionId}:{toolUseId | noturn-<hash>}:{toolName}:{eventType}` per
 * `system-architecture.md` §4.3.
 *
 * F14 closure (2026-04-27 verification): the original formula
 * `pd:{sessionId}:{toolName}:{eventType}` collapsed legitimately distinct
 * tool invocations within a single session to one audit row — Write to
 * file A (deny) and Write to file B (allow) shared the key, the second row
 * was dropped on the UNIQUE index, and the audit trail lost the second
 * decision. So the formula includes `toolUseId` (the agent's per-invocation
 * turn id). Retry dedupe (same toolUseId + toolName + eventType in the same
 * session) still collapses to one row.
 *
 * F7 (2026-07-04): when `toolUseId` is absent, the disambiguator is a hash
 * of the tool input (see `toolInputSnapshot`) rather than the constant
 * `'no-turn'`, so distinct direct-MCP calls still land distinct rows.
 */
export function buildPolicyDecisionIdempotencyKey(args: {
  readonly sessionId: string;
  readonly toolUseId?: string;
  readonly toolName: string;
  readonly eventType: string;
  /**
   * F7 (E2E finding, 2026-07-04): disambiguator used ONLY when `toolUseId`
   * is absent. Pre-fix, direct MCP callers that omit `toolUseId` collapsed
   * every same-tool call in a session onto `'no-turn'`, so three distinct
   * Write checks (.env deny, .git deny, src allow) landed ONE audit row —
   * breaking the "every decision has an audit row" invariant. When a turn
   * id is present it alone disambiguates and this field is ignored, so the
   * key is byte-identical to pre-fix for the Claude Code bridge path.
   */
  readonly toolInputSnapshot?: string;
}): string {
  const turn =
    args.toolUseId ?? (args.toolInputSnapshot !== undefined ? `noturn-${fnv1aHex(args.toolInputSnapshot)}` : 'no-turn');
  return `pd:${args.sessionId}:${turn}:${args.toolName}:${args.eventType}`;
}

// ---------------------------------------------------------------------------
// Test-supporting factories.
// ---------------------------------------------------------------------------

/**
 * Build a `PolicyClient` by wrapping a lower-level `PolicyCheck` —
 * the narrow callback that takes `PolicyInput` and returns
 * `PolicyResult`. Tests use this to inject tracking / deny / throw
 * stubs without having to implement the full `PolicyClient`
 * interface every time.
 */
export function createPolicyClientFromCheck(check: PolicyCheck): PolicyClient {
  if (typeof check !== 'function') {
    throw new TypeError('createPolicyClientFromCheck: check must be a PolicyCheck function');
  }
  return {
    async evaluate(input) {
      const req: PolicyInput = {
        toolName: input.toolName,
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        input: input.input,
        phase: input.phase,
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(input.activeCapabilities !== undefined ? { activeCapabilities: input.activeCapabilities } : {}),
      };
      const out: PolicyResult = await check(req);
      return {
        decision: out.decision,
        reason: out.reason,
        matchedRuleId: out.matchedRuleId,
        ...(out.matchedCapability !== undefined ? { matchedCapability: out.matchedCapability } : {}),
        ...(out.baseDecision !== undefined ? { baseDecision: out.baseDecision } : {}),
        ...(out.governanceVerdict !== undefined ? { governanceVerdict: out.governanceVerdict } : {}),
        ...(out.enforcementMode !== undefined ? { enforcementMode: out.enforcementMode } : {}),
        ...(out.matchedExceptionId !== undefined ? { matchedExceptionId: out.matchedExceptionId } : {}),
        ...(out.policyVersionId !== undefined ? { policyVersionId: out.policyVersionId } : {}),
      };
    },
  };
}

/**
 * Deterministic always-allow `PolicyCheck` — the test stand-in.
 * `__tests__/helpers/fake-deps.ts` uses it as the default for tests
 * that don't care about policy.
 */
export const devNullPolicyCheck: PolicyCheck = async () => ({
  decision: 'allow',
  reason: 'dev-null: policy engine not wired (test stand-in)',
  matchedRuleId: null,
});

/**
 * Test-only factory — returns a `PolicyClient` whose `.evaluate` is
 * `allow` for any input.
 */
export function createDevNullPolicyClient(): PolicyClient {
  return createPolicyClientFromCheck(devNullPolicyCheck);
}

// ---------------------------------------------------------------------------
// Real evaluator.
// ---------------------------------------------------------------------------

const PHASE_TO_EVENT_TYPE: Readonly<Record<'pre' | 'post', string>> = {
  pre: 'PreToolUse',
  post: 'PostToolUse',
};

/** Tunables surfaced for tests that need to override them. */
export interface CreatePolicyClientOptions {
  /** `DbHandle` — usually `dbClient.asInternalHandle()` from index.ts. */
  readonly db: DbHandle;
  /** Clock injection for deterministic cache-TTL tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Cache TTL override (tests only). Defaults to 60s per §5. */
  readonly cacheTtlMs?: number;
  /** Per-call timeout fuse. Defaults to 100ms per user S7b directive. */
  readonly timeoutMs?: number;
  /** Breaker threshold override. Defaults to 5 consecutive failures per §7. */
  readonly breakerThreshold?: number;
  /** Breaker half-open probe delay. Defaults to 30_000ms per §7. */
  readonly breakerHalfOpenMs?: number;
}

/** Internal cached rule with its compiled path matcher. */
interface CompiledRule {
  readonly id: string;
  readonly policyId: string;
  readonly policyVersionId?: string | null;
  readonly priority: number;
  readonly matchEventType: string;
  readonly matchToolName: string;
  /** `null` = any path matches; otherwise the compiled picomatch result. */
  readonly matchPath: ((p: string) => boolean) | null;
  /** `null` = any command matches; otherwise the compiled shell-command matcher. */
  readonly matchCommand: ((command: string) => boolean) | null;
  readonly matchAgentType: string | null;
  readonly decision: PolicyDecision;
  readonly enforcementDecision: PolicyDecision;
  readonly governanceVerdict: PolicyGovernanceVerdict;
  readonly enforcementMode: PolicyEnforcementMode;
  readonly denyOnPolicyError: boolean;
  readonly requiredCapability: string | null;
  readonly excludedCapability: string | null;
  readonly reason: string;
}

interface CompiledException {
  readonly id: string;
  readonly policyId: string;
  readonly policyVersionId: string | null;
  readonly ruleId: string | null;
  readonly scopeType: string;
  readonly scope: Record<string, unknown>;
  readonly decisionOverride: 'allow' | 'deny' | 'ask';
  readonly reason: string;
  readonly startsAt: Date | null;
  readonly expiresAt: Date | null;
}

interface CacheEntry {
  readonly rules: ReadonlyArray<CompiledRule>;
  readonly exceptions: ReadonlyArray<CompiledException>;
  readonly loadedAt: number;
}

const DEFAULTS = {
  CACHE_TTL_MS: 60_000,
  TIMEOUT_MS: 100,
  BREAKER_THRESHOLD: 5,
  BREAKER_HALF_OPEN_MS: 30_000,
} as const;

function compileRule(row: {
  id: string;
  policyId: string;
  priority: number;
  policyEnforcementMode: string;
  policyDenyOnPolicyError: boolean;
  matchEventType: string;
  matchToolName: string;
  matchPathGlob: string | null;
  matchCommandPattern?: string | null;
  matchAgentType: string | null;
  decision: string;
  enforcementDecision?: string | null;
  governanceVerdict?: string | null;
  ruleEnforcementMode?: string | null;
  requiredCapability?: string | null;
  excludedCapability?: string | null;
  reason: string;
}): CompiledRule {
  // F6 (2026-07-04): preserve all three tiers. Pre-fix this collapsed
  // `'ask'` → `'allow'`, so the seeded "ask before Bash" rule matched but
  // silently allowed. `'ask'` now propagates through evaluate() → the
  // check_policy response + the bridge's Claude Code permissionDecision.
  const decision = normalizePolicyDecision(row.decision);
  const hasSplitDecision =
    row.enforcementDecision != null || row.governanceVerdict != null || row.ruleEnforcementMode != null;
  const enforcementDecision = normalizePolicyDecision(row.enforcementDecision ?? row.decision);
  const governanceVerdict = normalizeGovernanceVerdict(
    row.governanceVerdict ?? legacyGovernanceVerdictForDecision(row.decision),
  );
  const enforcementMode = normalizeEnforcementMode(
    row.ruleEnforcementMode ?? (hasSplitDecision ? row.policyEnforcementMode : legacyEnforcementModeForDecision(row.decision)),
  );
  const matcher = row.matchPathGlob ? picomatch(row.matchPathGlob, { dot: false, nobrace: true }) : null;
  const commandMatcher =
    row.matchCommandPattern !== undefined && row.matchCommandPattern !== null && row.matchCommandPattern.length > 0
      ? picomatch(row.matchCommandPattern, { dot: true, nobrace: true })
      : null;
  return {
    id: row.id,
    policyId: row.policyId,
    policyVersionId: null,
    priority: row.priority,
    matchEventType: row.matchEventType,
    matchToolName: row.matchToolName,
    matchPath: matcher,
    matchCommand: commandMatcher,
    matchAgentType: row.matchAgentType,
    decision,
    enforcementDecision,
    governanceVerdict,
    enforcementMode,
    denyOnPolicyError: row.policyDenyOnPolicyError,
    requiredCapability: normalizeCapability(row.requiredCapability),
    excludedCapability: normalizeCapability(row.excludedCapability),
    reason: row.reason,
  };
}

function normalizePolicyDecision(value: string | null | undefined): PolicyDecision {
  return value === 'deny' ? 'deny' : value === 'ask' ? 'ask' : 'allow';
}

function normalizeGovernanceVerdict(value: string | null | undefined): PolicyGovernanceVerdict {
  switch (value) {
    case 'record':
    case 'advise':
    case 'warn':
    case 'confirm':
    case 'escalate':
    case 'block':
      return value;
    case 'flag':
      return 'warn';
    case 'pass':
    default:
      return 'pass';
  }
}

function legacyGovernanceVerdictForDecision(decision: string | null | undefined): PolicyGovernanceVerdict {
  if (decision === 'deny' || decision === 'block') return 'block';
  if (decision === 'ask') return 'confirm';
  return 'pass';
}

function legacyEnforcementModeForDecision(decision: string | null | undefined): PolicyEnforcementMode {
  if (decision === 'deny') return 'preventive';
  if (decision === 'ask') return 'approval';
  return 'detective';
}

function normalizeEnforcementMode(value: string | null | undefined): PolicyEnforcementMode {
  switch (value) {
    case 'advisory':
    case 'approval':
    case 'preventive':
    case 'disabled':
      return value;
    case 'enforced':
      return 'preventive';
    case 'detective':
    default:
      return 'detective';
  }
}

function normalizeCapability(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function compileException(row: {
  id: string;
  policyId: string;
  policyVersionId: string | null;
  ruleId: string | null;
  scopeType: string;
  scopeJson: string;
  decisionOverride: string;
  reason: string;
  startsAt: Date | null;
  expiresAt: Date | null;
}): CompiledException {
  let scope: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.scopeJson);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      scope = parsed as Record<string, unknown>;
    }
  } catch {
    scope = {};
  }
  return {
    id: row.id,
    policyId: row.policyId,
    policyVersionId: row.policyVersionId,
    ruleId: row.ruleId,
    scopeType: row.scopeType,
    scope,
    decisionOverride: row.decisionOverride === 'deny' ? 'deny' : row.decisionOverride === 'ask' ? 'ask' : 'allow',
    reason: row.reason,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
  };
}

function toolNameMatches(rule: CompiledRule, toolName: string): boolean {
  if (rule.matchToolName === '*') return true;
  if (rule.matchToolName === toolName) return true;
  if (!rule.matchToolName.includes('*')) return false;
  return picomatch(rule.matchToolName, { dot: false, nobrace: true })(toolName);
}

function extractPath(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of ['filePath', 'file_path', 'path']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

function extractCommand(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'shell_command', 'shellCommand']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

/**
 * First-match-wins rule evaluation. `rules` is assumed to be sorted
 * by priority ASC (the DB query does this; the cache preserves the
 * order). Returns the first rule whose axes all match, or `null` if
 * none apply (caller defaults to `allow`).
 */
export function evaluateRules(
  rules: ReadonlyArray<CompiledRule>,
  input: Pick<PolicyInput, 'phase' | 'toolName' | 'input' | 'activeCapabilities'>,
): CompiledRule | null {
  const eventType = PHASE_TO_EVENT_TYPE[input.phase];
  const path = extractPath(input.input);
  const command = extractCommand(input.input);
  const activeCapabilities = new Set(input.activeCapabilities ?? []);
  for (const rule of rules) {
    if (rule.enforcementMode === 'disabled') continue;
    if (rule.requiredCapability !== null && !activeCapabilities.has(rule.requiredCapability)) continue;
    if (rule.excludedCapability !== null && activeCapabilities.has(rule.excludedCapability)) continue;
    if (rule.matchEventType !== '*' && rule.matchEventType !== eventType) continue;
    if (!toolNameMatches(rule, input.toolName)) continue;
    if (rule.matchPath) {
      if (path.length === 0 || !rule.matchPath(path)) continue;
    }
    if (rule.matchCommand) {
      if (command.length === 0 || !rule.matchCommand(command)) continue;
    }
    if (rule.matchAgentType !== null && rule.matchAgentType !== '*') continue;
    return rule;
  }
  return null;
}

function effectiveDecisionForRule(rule: CompiledRule): PolicyDecision {
  if (rule.enforcementMode === 'detective' || rule.enforcementMode === 'advisory') return 'allow';
  if (rule.enforcementMode === 'approval') {
    if (rule.enforcementDecision === 'deny') return 'ask';
    return rule.enforcementDecision;
  }
  return rule.enforcementDecision;
}

function exceptionMatches(
  exception: CompiledException,
  rule: CompiledRule | null,
  input: Pick<PolicyInput, 'toolName' | 'input'>,
  now: Date,
): boolean {
  if (exception.startsAt !== null && exception.startsAt > now) return false;
  if (exception.expiresAt !== null && exception.expiresAt < now) return false;
  if (rule !== null) {
    if (exception.ruleId !== null && exception.ruleId !== rule.id) return false;
    if (exception.policyId !== rule.policyId) return false;
    if (exception.policyVersionId !== null && exception.policyVersionId !== rule.policyVersionId) return false;
  }

  const toolName = exception.scope.toolName;
  if (typeof toolName === 'string' && toolName.length > 0 && toolName !== input.toolName) return false;
  const agentType = exception.scope.agentType;
  if (typeof agentType === 'string' && agentType.length > 0) {
    // Agent type is intentionally not part of PolicyInput yet for legacy callers.
    // Keep the selector as metadata until all hook paths pass it through.
  }
  const pathGlob = exception.scope.pathGlob;
  if (typeof pathGlob === 'string' && pathGlob.length > 0) {
    const path = extractPath(input.input);
    if (path.length === 0 || !picomatch(pathGlob, { dot: false, nobrace: true })(path)) return false;
  }
  return true;
}

function applyException(
  exceptions: ReadonlyArray<CompiledException>,
  rule: CompiledRule | null,
  input: Pick<PolicyInput, 'toolName' | 'input'>,
  now: Date,
): CompiledException | null {
  for (const exception of exceptions) {
    if (rule !== null && exception.policyId !== rule.policyId) continue;
    if (exceptionMatches(exception, rule, input, now)) return exception;
  }
  return null;
}

interface LoadedPolicyState {
  readonly rules: ReadonlyArray<CompiledRule>;
  readonly exceptions: ReadonlyArray<CompiledException>;
}

async function loadPolicyState(db: DbHandle, projectId: string | null): Promise<LoadedPolicyState> {
  if (db.kind === 'sqlite') {
    const where =
      projectId === null
        ? eq(sqliteSchema.policies.isActive, true)
        : and(eq(sqliteSchema.policies.isActive, true), eq(sqliteSchema.policies.projectId, projectId));
    const rows = await db.db
      .select({
        id: sqliteSchema.policyRules.id,
        policyId: sqliteSchema.policyRules.policyId,
        policyVersionId: sqliteSchema.policyVersions.id,
        priority: sqliteSchema.policyRules.priority,
        policyEnforcementMode: sqliteSchema.policies.enforcementMode,
        policyDenyOnPolicyError: sqliteSchema.policies.denyOnPolicyError,
        matchEventType: sqliteSchema.policyRules.matchEventType,
        matchToolName: sqliteSchema.policyRules.matchToolName,
        matchPathGlob: sqliteSchema.policyRules.matchPathGlob,
        matchCommandPattern: sqliteSchema.policyRules.matchCommandPattern,
        matchAgentType: sqliteSchema.policyRules.matchAgentType,
        decision: sqliteSchema.policyRules.decision,
        enforcementDecision: sqliteSchema.policyRules.enforcementDecision,
        governanceVerdict: sqliteSchema.policyRules.governanceVerdict,
        ruleEnforcementMode: sqliteSchema.policyRules.enforcementMode,
        requiredCapability: sqliteSchema.policyRules.requiredCapability,
        excludedCapability: sqliteSchema.policyRules.excludedCapability,
        reason: sqliteSchema.policyRules.reason,
      })
      .from(sqliteSchema.policyRules)
      .innerJoin(sqliteSchema.policies, eq(sqliteSchema.policies.id, sqliteSchema.policyRules.policyId))
      .leftJoin(
        sqliteSchema.policyVersions,
        and(
          eq(sqliteSchema.policyVersions.policyId, sqliteSchema.policies.id),
          eq(sqliteSchema.policyVersions.status, 'active'),
        ),
      )
      .where(where)
      .orderBy(sqliteSchema.policyRules.priority);
    const exceptions = await db.db
      .select()
      .from(sqliteSchema.policyExceptions)
      .where(
        projectId === null
          ? eq(sqliteSchema.policyExceptions.status, 'active')
          : and(
              eq(sqliteSchema.policyExceptions.status, 'active'),
              eq(sqliteSchema.policyExceptions.projectId, projectId),
            ),
      )
      .orderBy(desc(sqliteSchema.policyExceptions.createdAt));
    return {
      rules: rows.map((row) => ({ ...compileRule(row), policyVersionId: row.policyVersionId })),
      exceptions: exceptions.map(compileException),
    };
  }
  const where =
    projectId === null
      ? eq(postgresSchema.policies.isActive, true)
      : and(eq(postgresSchema.policies.isActive, true), eq(postgresSchema.policies.projectId, projectId));
  const rows = await db.db
    .select({
    id: postgresSchema.policyRules.id,
    policyId: postgresSchema.policyRules.policyId,
    policyVersionId: postgresSchema.policyVersions.id,
    priority: postgresSchema.policyRules.priority,
    policyEnforcementMode: postgresSchema.policies.enforcementMode,
    policyDenyOnPolicyError: postgresSchema.policies.denyOnPolicyError,
    matchEventType: postgresSchema.policyRules.matchEventType,
    matchToolName: postgresSchema.policyRules.matchToolName,
    matchPathGlob: postgresSchema.policyRules.matchPathGlob,
    matchCommandPattern: postgresSchema.policyRules.matchCommandPattern,
    matchAgentType: postgresSchema.policyRules.matchAgentType,
    decision: postgresSchema.policyRules.decision,
    enforcementDecision: postgresSchema.policyRules.enforcementDecision,
    governanceVerdict: postgresSchema.policyRules.governanceVerdict,
    ruleEnforcementMode: postgresSchema.policyRules.enforcementMode,
    requiredCapability: postgresSchema.policyRules.requiredCapability,
    excludedCapability: postgresSchema.policyRules.excludedCapability,
    reason: postgresSchema.policyRules.reason,
  })
    .from(postgresSchema.policyRules)
    .innerJoin(postgresSchema.policies, eq(postgresSchema.policies.id, postgresSchema.policyRules.policyId))
    .leftJoin(
      postgresSchema.policyVersions,
      and(
        eq(postgresSchema.policyVersions.policyId, postgresSchema.policies.id),
        eq(postgresSchema.policyVersions.status, 'active'),
      ),
    )
    .where(where)
    .orderBy(postgresSchema.policyRules.priority);
  const exceptions = await db.db
    .select()
    .from(postgresSchema.policyExceptions)
    .where(
      projectId === null
        ? eq(postgresSchema.policyExceptions.status, 'active')
        : and(
            eq(postgresSchema.policyExceptions.status, 'active'),
            eq(postgresSchema.policyExceptions.projectId, projectId),
          ),
    )
    .orderBy(desc(postgresSchema.policyExceptions.createdAt));
  return {
    rules: rows.map((row) => ({ ...compileRule(row), policyVersionId: row.policyVersionId })),
    exceptions: exceptions.map(compileException),
  };
}

const FAIL_OPEN_RESULT: PolicyResult = Object.freeze({
  decision: 'allow',
  baseDecision: 'allow',
  governanceVerdict: 'pass',
  enforcementMode: 'detective',
  reason: 'policy_check_unavailable',
  matchedRuleId: null,
  matchedExceptionId: null,
  policyVersionId: null,
});

function isCockatielFailOpen(err: unknown): boolean {
  return err instanceof BrokenCircuitError || err instanceof IsolatedCircuitError || err instanceof TaskCancelledError;
}

/**
 * Real policy evaluator. Wraps a cache-first DB read in a
 * cockatiel timeout + breaker fuse, returns fail-open on every
 * error path. The frozen `PolicyClient` interface is the only
 * surface exposed to callers.
 */
export function createPolicyClient(options: CreatePolicyClientOptions): PolicyClient {
  if (!options || typeof options !== 'object') {
    throw new TypeError('createPolicyClient requires an options object');
  }
  if (!options.db || typeof options.db !== 'object' || !('kind' in options.db)) {
    throw new TypeError('createPolicyClient: options.db must be a DbHandle from @coodra/db');
  }

  const now = options.now ?? (() => Date.now());
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULTS.CACHE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.TIMEOUT_MS;
  const breakerThreshold = options.breakerThreshold ?? DEFAULTS.BREAKER_THRESHOLD;
  const breakerHalfOpenMs = options.breakerHalfOpenMs ?? DEFAULTS.BREAKER_HALF_OPEN_MS;

  const breaker = circuitBreaker(handleAll, {
    halfOpenAfter: breakerHalfOpenMs,
    breaker: new ConsecutiveBreaker(breakerThreshold),
  });
  const fuse = timeout(timeoutMs, TimeoutStrategy.Aggressive);
  const policy = wrap(fuse, breaker);

  const GLOBAL_CACHE_KEY = '__global__';
  const cache = new Map<string, CacheEntry>();

  policyLogger.info(
    {
      event: 'policy_engine_wired',
      mode: options.db.kind === 'sqlite' ? 'solo' : 'team',
      cacheTtlMs,
      timeoutMs,
      breakerThreshold,
      breakerHalfOpenMs,
    },
    'createPolicyClient: policy engine wired (cache-first + timeout + breaker + fail-open).',
  );

  async function getPolicyState(projectId: string | null): Promise<LoadedPolicyState> {
    const key = projectId ?? GLOBAL_CACHE_KEY;
    const cached = cache.get(key);
    if (cached && now() - cached.loadedAt < cacheTtlMs) {
      return { rules: cached.rules, exceptions: cached.exceptions };
    }
    const state = await policy.execute(() => loadPolicyState(options.db, projectId));
    cache.set(key, { ...state, loadedAt: now() });
    return state;
  }

  return {
    async evaluate(input) {
      const started = now();
      const projectId = input.projectId ?? null;
      let state: LoadedPolicyState;
      try {
        state = await getPolicyState(projectId);
      } catch (err) {
        const durationMs = now() - started;
        if (isCockatielFailOpen(err)) {
          policyLogger.warn(
            {
              event: 'policy_fail_open_breaker',
              tool: input.toolName,
              phase: input.phase,
              sessionId: input.sessionId,
              durationMs,
              reason: err instanceof Error ? err.name : 'unknown',
            },
            'policy fuse tripped (breaker open, isolated, or timeout); failing open',
          );
        } else {
          policyLogger.warn(
            {
              event: 'policy_fail_open_error',
              tool: input.toolName,
              phase: input.phase,
              sessionId: input.sessionId,
              durationMs,
              err: err instanceof Error ? err.message : String(err),
            },
            'policy DB read threw; failing open',
          );
        }
        return FAIL_OPEN_RESULT;
      }

      const matched = evaluateRules(state.rules, {
        phase: input.phase,
        toolName: input.toolName,
        input: input.input,
        ...(input.activeCapabilities !== undefined ? { activeCapabilities: input.activeCapabilities } : {}),
      });

      if (!matched) {
        const exception = applyException(state.exceptions, null, input, new Date(now()));
        if (exception !== null) {
          return {
            decision: exception.decisionOverride,
            baseDecision: 'allow',
            governanceVerdict: 'pass',
            enforcementMode: 'detective',
            reason: exception.reason,
            matchedRuleId: null,
            matchedExceptionId: exception.id,
            policyVersionId: exception.policyVersionId ?? null,
          };
        }
        return {
          decision: 'allow',
          baseDecision: 'allow',
          governanceVerdict: 'pass',
          enforcementMode: 'detective',
          reason: 'no_rule_matched',
          matchedRuleId: null,
          matchedExceptionId: null,
          policyVersionId: null,
        };
      }

      const exception = applyException(state.exceptions, matched, input, new Date(now()));
      const baseDecision = effectiveDecisionForRule(matched);
      if (exception !== null) {
        return {
          decision: exception.decisionOverride,
          baseDecision,
          governanceVerdict: matched.governanceVerdict,
          enforcementMode: matched.enforcementMode,
            reason: exception.reason,
            matchedRuleId: matched.id,
            matchedCapability: matched.requiredCapability,
            matchedExceptionId: exception.id,
            policyVersionId: exception.policyVersionId ?? matched.policyVersionId ?? null,
        };
      }

      return {
        decision: baseDecision,
        baseDecision,
        governanceVerdict: matched.governanceVerdict,
        enforcementMode: matched.enforcementMode,
        reason: matched.reason,
        matchedRuleId: matched.id,
        matchedCapability: matched.requiredCapability,
        matchedExceptionId: null,
        policyVersionId: matched.policyVersionId ?? null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Audit write helper.
// ---------------------------------------------------------------------------

export interface RecordPolicyDecisionArgs {
  readonly orgId?: string | null;
  /** NOT NULL FK to `projects.id`. Caller must supply. */
  readonly projectId: string;
  readonly sessionId: string;
  readonly agentType: string;
  readonly eventType: string;
  readonly toolName: string;
  /**
   * Agent's per-invocation turn id (Claude Code `tool_use_id`). Required for
   * audit-trail integrity — without it, distinct invocations of the
   * same tool within one session collide on the idempotency key.
   * Optional for backward compatibility; falls back to `'no-turn'`.
   */
  readonly toolUseId?: string;
  readonly permissionMode?: string | null;
  /** JSON string of the tool input — caller controls truncation. */
  readonly toolInputSnapshot: string;
  readonly permissionDecision: 'allow' | 'deny' | 'ask';
  readonly governanceVerdict?: PolicyGovernanceVerdict | null;
  readonly policyVersionId?: string | null;
  readonly reason: string;
  readonly matchedRuleId: string | null;
  readonly matchedExceptionId?: string | null;
  readonly baseDecision?: 'allow' | 'deny' | 'ask' | null;
  readonly effectiveDecision?: 'allow' | 'deny' | 'ask' | null;
  readonly askOutcome?: 'approved' | 'not_executed' | 'unresolved' | null;
  readonly askOutcomeAt?: Date | null;
  readonly correlatedRunEventId?: string | null;
  readonly evidenceJson?: string | null;
  readonly resultLabelsJson?: string | null;
  readonly activeCapabilitiesJson?: string | null;
  readonly matchedCapability?: string | null;
  /** Nullable FK — PreToolUse before a run exists writes NULL per §4.3. */
  readonly runId: string | null;
  /** UUID minter; defaults to `crypto.randomUUID()`. Exposed for tests. */
  readonly mintId?: () => string;
}

/**
 * Insert a row into `policy_decisions` using the locked idempotency
 * key `pd:{sessionId}:{toolUseId}:{toolName}:{eventType}` (§4.3, F14
 * closure 2026-04-27). ON CONFLICT DO NOTHING dedupes retries of the
 * same tool invocation; distinct invocations within a session land
 * distinct rows. Caller dispatches via `setImmediate(...)` per Q-02-2;
 * this function is synchronous-throwing so the caller's `.catch()`
 * sees the error.
 *
 * Returns `{ inserted }`:
 *   - `inserted: true` on first write.
 *   - `inserted: false` when the idempotency key already exists.
 */
export async function recordPolicyDecision(
  db: DbHandle,
  args: RecordPolicyDecisionArgs,
): Promise<{ readonly inserted: boolean }> {
  const id = (args.mintId ?? (() => globalThis.crypto.randomUUID()))();
  const idempotencyKey = buildPolicyDecisionIdempotencyKey({
    sessionId: args.sessionId,
    ...(args.toolUseId !== undefined ? { toolUseId: args.toolUseId } : {}),
    toolName: args.toolName,
    eventType: args.eventType,
    // F7: disambiguate no-turn callers by tool input (ignored when toolUseId present).
    toolInputSnapshot: args.toolInputSnapshot,
  });

  const row = {
    id,
    orgId: args.orgId ?? null,
    idempotencyKey,
    runId: args.runId,
    sessionId: args.sessionId,
    projectId: args.projectId,
    agentType: args.agentType,
    eventType: args.eventType,
    toolName: args.toolName,
    toolUseId: args.toolUseId ?? null,
    permissionMode: args.permissionMode ?? null,
    toolInputSnapshot: args.toolInputSnapshot,
    permissionDecision: args.permissionDecision,
    governanceVerdict: args.governanceVerdict ?? null,
    policyVersionId: args.policyVersionId ?? null,
    matchedRuleId: args.matchedRuleId,
    matchedExceptionId: args.matchedExceptionId ?? null,
    baseDecision: args.baseDecision ?? args.permissionDecision,
    effectiveDecision: args.effectiveDecision ?? args.permissionDecision,
    reason: args.reason,
    askOutcome: args.askOutcome ?? (args.permissionDecision === 'ask' ? 'unresolved' : null),
    askOutcomeAt: args.askOutcomeAt ?? null,
    correlatedRunEventId: args.correlatedRunEventId ?? null,
    evidenceJson: args.evidenceJson ?? null,
    resultLabelsJson: args.resultLabelsJson ?? null,
    activeCapabilitiesJson: args.activeCapabilitiesJson ?? null,
    matchedCapability: args.matchedCapability ?? null,
  };

  if (db.kind === 'sqlite') {
    const result = await db.db
      .insert(sqliteSchema.policyDecisions)
      .values(row)
      .onConflictDoNothing({ target: sqliteSchema.policyDecisions.idempotencyKey })
      .returning({ id: sqliteSchema.policyDecisions.id });
    return { inserted: result.length === 1 };
  }

  const result = await db.db
    .insert(postgresSchema.policyDecisions)
    .values(row)
    .onConflictDoNothing({ target: postgresSchema.policyDecisions.idempotencyKey })
    .returning({ id: postgresSchema.policyDecisions.id });
  return { inserted: result.length === 1 };
}

export interface ResolveAskOutcomeApprovedArgs {
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly correlatedRunEventId?: string | null;
  readonly now?: Date;
}

export async function resolveAskOutcomeApproved(
  db: DbHandle,
  args: ResolveAskOutcomeApprovedArgs,
): Promise<{ readonly updated: number }> {
  const now = args.now ?? new Date();
  if (db.kind === 'sqlite') {
    const t = sqliteSchema.policyDecisions;
    const result = await db.db
      .update(t)
      .set({
        askOutcome: 'approved',
        askOutcomeAt: now,
        correlatedRunEventId: args.correlatedRunEventId ?? null,
      })
      .where(
        and(
          eq(t.sessionId, args.sessionId),
          eq(t.toolUseId, args.toolUseId),
          eq(t.toolName, args.toolName),
          eq(t.permissionDecision, 'ask'),
          or(isNull(t.askOutcome), eq(t.askOutcome, 'unresolved')),
        ),
      );
    const updated = (result as { changes?: number } | undefined)?.changes ?? 0;
    return { updated };
  }

  const t = postgresSchema.policyDecisions;
  const rows = await db.db
    .update(t)
    .set({
      askOutcome: 'approved',
      askOutcomeAt: now,
      correlatedRunEventId: args.correlatedRunEventId ?? null,
    })
    .where(
      and(
        eq(t.sessionId, args.sessionId),
        eq(t.toolUseId, args.toolUseId),
        eq(t.toolName, args.toolName),
        eq(t.permissionDecision, 'ask'),
        or(isNull(t.askOutcome), eq(t.askOutcome, 'unresolved')),
      ),
    )
    .returning({ id: t.id });
  return { updated: rows.length };
}

export interface ResolveAskOutcomesNotExecutedArgs {
  readonly sessionId: string;
  readonly now?: Date;
}

export async function resolveAskOutcomesNotExecuted(
  db: DbHandle,
  args: ResolveAskOutcomesNotExecutedArgs,
): Promise<{ readonly updated: number }> {
  const now = args.now ?? new Date();
  if (db.kind === 'sqlite') {
    const t = sqliteSchema.policyDecisions;
    const result = await db.db
      .update(t)
      .set({
        askOutcome: 'not_executed',
        askOutcomeAt: now,
      })
      .where(
        and(
          eq(t.sessionId, args.sessionId),
          eq(t.permissionDecision, 'ask'),
          or(isNull(t.askOutcome), eq(t.askOutcome, 'unresolved')),
        ),
      );
    const updated = (result as { changes?: number } | undefined)?.changes ?? 0;
    return { updated };
  }

  const t = postgresSchema.policyDecisions;
  const rows = await db.db
    .update(t)
    .set({
      askOutcome: 'not_executed',
      askOutcomeAt: now,
    })
    .where(
      and(
        eq(t.sessionId, args.sessionId),
        eq(t.permissionDecision, 'ask'),
        or(isNull(t.askOutcome), eq(t.askOutcome, 'unresolved')),
      ),
    )
    .returning({ id: t.id });
  return { updated: rows.length };
}
