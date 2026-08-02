import { createHash } from 'node:crypto';

import type { ClaudeNativePermissionsProjection } from '@coodra/shared';

import type { PolicyWithRules } from './policies.js';

type PermissionDecision = 'allow' | 'ask' | 'deny';

interface CompiledPermission {
  readonly decision: PermissionDecision;
  readonly value: string;
  readonly ruleId: string;
}

const CLAUDE_FILE_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const CLAUDE_FILE_READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

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

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function isClaudeScoped(ruleAgentType: string | null): boolean {
  return (
    ruleAgentType === null || ruleAgentType === '*' || ruleAgentType === 'claude' || ruleAgentType === 'claude_code'
  );
}

function isSafeAllowToolGlob(toolName: string): boolean {
  if (!toolName.includes('*')) return true;
  return /^mcp__[^*_]+__/.test(toolName);
}

function normalizeClaudePathPattern(pattern: string): string {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return trimmed;
  if (trimmed.startsWith('//') || trimmed.startsWith('~/') || trimmed.startsWith('/')) return trimmed;
  const relative = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed;
  return `/${relative}`;
}

function normalizeClaudeCommandPattern(pattern: string): string {
  return pattern.trim();
}

function compileRule(rule: PolicyWithRules['rules'][number]): CompiledPermission | null {
  if (rule.matchEventType !== 'PreToolUse') return null;
  if (!isClaudeScoped(rule.matchAgentType)) return null;
  if (rule.decision === 'allow' && !isSafeAllowToolGlob(rule.matchToolName)) return null;
  if (rule.matchToolName === 'Bash') {
    const commandPattern = rule.matchCommandPattern?.trim();
    if (commandPattern === undefined || commandPattern.length === 0) return null;
    return {
      decision: rule.decision,
      value: `Bash(${normalizeClaudeCommandPattern(commandPattern)})`,
      ruleId: rule.id,
    };
  }

  const decision = rule.decision;
  if (rule.matchPathGlob !== null && rule.matchPathGlob.trim().length > 0) {
    const pattern = normalizeClaudePathPattern(rule.matchPathGlob);
    if (CLAUDE_FILE_EDIT_TOOLS.has(rule.matchToolName)) {
      return { decision, value: `Edit(${pattern})`, ruleId: rule.id };
    }
    if (CLAUDE_FILE_READ_TOOLS.has(rule.matchToolName)) {
      return { decision, value: `Read(${pattern})`, ruleId: rule.id };
    }
    return null;
  }

  return { decision, value: rule.matchToolName, ruleId: rule.id };
}

export function buildClaudeNativePermissionsProjection(
  policies: readonly PolicyWithRules[],
): ClaudeNativePermissionsProjection {
  const compiled: CompiledPermission[] = [];
  const untranslatedRuleIds: string[] = [];

  for (const policy of policies) {
    if (!policy.isActive) continue;
    for (const rule of policy.rules) {
      const permission = compileRule(rule);
      if (permission === null) {
        untranslatedRuleIds.push(rule.id);
      } else {
        compiled.push(permission);
      }
    }
  }

  const allow = uniqueSorted(compiled.filter((entry) => entry.decision === 'allow').map((entry) => entry.value));
  const ask = uniqueSorted(compiled.filter((entry) => entry.decision === 'ask').map((entry) => entry.value));
  const deny = uniqueSorted(compiled.filter((entry) => entry.decision === 'deny').map((entry) => entry.value));
  const translatedRuleIds = uniqueSorted(compiled.map((entry) => entry.ruleId));
  const settings = {
    disableAutoMode: 'disable',
    disableBypassPermissionsMode: 'disable',
  } as const;

  const payload = {
    schemaVersion: 1,
    allow,
    ask,
    deny,
    translatedRuleIds,
    untranslatedRuleIds: uniqueSorted(untranslatedRuleIds),
    settings,
  } as const;
  return {
    ...payload,
    projectionHash: sha256(stableStringify(payload)),
  };
}
