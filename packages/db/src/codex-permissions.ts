import {
  CODEX_NATIVE_PERMISSION_PROFILE_NAME,
  type CodexNativeFilesystemRule,
  type CodexNativePermissionsProjection,
  hashCodexNativePermissionsSurface,
} from '@coodra/shared';

import type { PolicyWithRules } from './policies.js';

type CodexAccess = CodexNativeFilesystemRule['access'];

const CODEX_FILE_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const CODEX_FILE_READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

function uniqueSortedRules(rules: readonly CodexNativeFilesystemRule[]): CodexNativeFilesystemRule[] {
  const byKey = new Map<string, CodexNativeFilesystemRule>();
  for (const rule of rules) {
    byKey.set(`${rule.path}:${rule.access}`, rule);
  }
  return [...byKey.values()].sort((a, b) =>
    a.path === b.path ? a.access.localeCompare(b.access) : a.path.localeCompare(b.path),
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function isCodexScoped(ruleAgentType: string | null): boolean {
  return ruleAgentType === null || ruleAgentType === '*' || ruleAgentType === 'codex';
}

function normalizeCodexWorkspacePattern(pattern: string): string {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return trimmed;
  const relative = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed;
  return relative.startsWith('/') ? relative.slice(1) : relative;
}

function looksSensitive(pattern: string): boolean {
  const normalized = pattern.toLowerCase();
  return (
    normalized.includes('.env') ||
    normalized.includes('secret') ||
    normalized.includes('token') ||
    normalized.includes('credential') ||
    normalized.includes('private_key')
  );
}

function accessForRule(rule: PolicyWithRules['rules'][number], pathPattern: string): CodexAccess | null {
  if (rule.decision === 'allow' || rule.decision === 'ask') return null;
  if (CODEX_FILE_READ_TOOLS.has(rule.matchToolName)) return 'deny';
  if (CODEX_FILE_EDIT_TOOLS.has(rule.matchToolName)) return looksSensitive(pathPattern) ? 'deny' : 'read';
  return null;
}

function compileRule(rule: PolicyWithRules['rules'][number]): CodexNativeFilesystemRule | null {
  if (rule.matchEventType !== 'PreToolUse') return null;
  if (!isCodexScoped(rule.matchAgentType)) return null;
  if (rule.matchPathGlob === null || rule.matchPathGlob.trim().length === 0) return null;

  const path = normalizeCodexWorkspacePattern(rule.matchPathGlob);
  const access = accessForRule(rule, path);
  if (access === null || path.length === 0) return null;
  return { path, access };
}

export function buildCodexNativePermissionsProjection(
  policies: readonly PolicyWithRules[],
): CodexNativePermissionsProjection {
  const compiled: CodexNativeFilesystemRule[] = [
    { path: '.env', access: 'deny' },
    { path: '**/.env', access: 'deny' },
    { path: '.git/**', access: 'read' },
    { path: '**/.git/**', access: 'read' },
    { path: 'node_modules/**', access: 'read' },
    { path: '**/node_modules/**', access: 'read' },
  ];
  const translatedRuleIds: string[] = [];
  const untranslatedRuleIds: string[] = [];

  for (const policy of policies) {
    if (!policy.isActive) continue;
    for (const rule of policy.rules) {
      const compiledRule = compileRule(rule);
      if (compiledRule === null) {
        untranslatedRuleIds.push(rule.id);
      } else {
        compiled.push(compiledRule);
        translatedRuleIds.push(rule.id);
      }
    }
  }

  const payload = {
    schemaVersion: 1,
    profileName: CODEX_NATIVE_PERMISSION_PROFILE_NAME,
    defaultPermissions: CODEX_NATIVE_PERMISSION_PROFILE_NAME,
    description: 'Coodra-managed project policy projection. DB hooks remain authoritative for per-tool decisions.',
    extends: ':workspace',
    filesystemGlobScanMaxDepth: 3,
    filesystemWorkspaceRoots: uniqueSortedRules(compiled),
    network: {
      enabled: false,
    },
    translatedRuleIds: uniqueSorted(translatedRuleIds),
    untranslatedRuleIds: uniqueSorted(untranslatedRuleIds),
  } as const;

  return {
    ...payload,
    projectionHash: hashCodexNativePermissionsSurface(payload),
  };
}
