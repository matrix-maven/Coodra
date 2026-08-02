import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const COODRA_POLICY_PROJECTION_BEGIN = '# BEGIN COODRA POLICY PROJECTION';
export const COODRA_POLICY_PROJECTION_END = '# END COODRA POLICY PROJECTION';
export const COODRA_CODEX_NATIVE_PERMISSIONS_BEGIN = '# BEGIN COODRA CODEX NATIVE PERMISSIONS';
export const COODRA_CODEX_NATIVE_PERMISSIONS_END = '# END COODRA CODEX NATIVE PERMISSIONS';
export const CODEX_NATIVE_PERMISSION_PROFILE_NAME = 'coodra-project';

export interface PolicyProjectionPolicy {
  readonly policyId: string;
  readonly name: string;
  readonly groupKey: string;
  readonly profile: string;
  readonly enforcementMode: string;
  readonly activeVersionId: string | null;
  readonly versionNumber: number | null;
  readonly snapshotHash: string | null;
  readonly ruleIds: readonly string[];
}

export interface ClaudeNativePermissionsProjection {
  readonly schemaVersion: 1;
  readonly allow: readonly string[];
  readonly ask: readonly string[];
  readonly deny: readonly string[];
  readonly translatedRuleIds: readonly string[];
  readonly untranslatedRuleIds: readonly string[];
  readonly settings: {
    readonly disableAutoMode: 'disable';
    readonly disableBypassPermissionsMode: 'disable';
  };
  readonly projectionHash: string;
}

export interface CodexNativeFilesystemRule {
  readonly path: string;
  readonly access: 'read' | 'write' | 'deny';
}

export interface CodexNativePermissionsProjection {
  readonly schemaVersion: 1;
  readonly profileName: typeof CODEX_NATIVE_PERMISSION_PROFILE_NAME;
  readonly defaultPermissions: typeof CODEX_NATIVE_PERMISSION_PROFILE_NAME;
  readonly description: string;
  readonly extends: ':workspace';
  readonly filesystemGlobScanMaxDepth: number | null;
  readonly filesystemWorkspaceRoots: readonly CodexNativeFilesystemRule[];
  readonly network: {
    readonly enabled: boolean;
  };
  readonly translatedRuleIds: readonly string[];
  readonly untranslatedRuleIds: readonly string[];
  readonly projectionHash: string;
}

export interface PolicyProjection {
  readonly schemaVersion: 1;
  readonly managedBy: 'coodra';
  readonly projectId: string;
  readonly projectSlug: string | null;
  readonly generatedAt: string;
  readonly policies: readonly PolicyProjectionPolicy[];
  readonly activeRuleIds: readonly string[];
  readonly activeExceptionIds: readonly string[];
  readonly policyVersionIds: readonly string[];
  readonly nativePermissions?: {
    readonly claude?: ClaudeNativePermissionsProjection;
    readonly codex?: CodexNativePermissionsProjection;
  };
  readonly projectionHash: string;
}

export interface PolicyProjectionReadResult {
  readonly path: string;
  readonly exists: boolean;
  readonly projection: PolicyProjection | null;
  readonly projectionHash: string | null;
  readonly projectionContentHash?: string | null;
  readonly permissionsHash?: string | null;
  readonly missingNativePermissions?: readonly string[];
  readonly warnings?: readonly string[];
  readonly error?: string;
}

export interface PolicyProjectionWriteResult {
  readonly codexPath?: string;
  readonly claudePath?: string;
  readonly agents: readonly PolicyProjectionAgent[];
}

export type PolicyProjectionAgent = 'codex' | 'claude';

export function policyProjectionPaths(projectRoot: string): {
  readonly codexPath: string;
  readonly claudePath: string;
} {
  return {
    codexPath: join(projectRoot, '.codex', 'config.toml'),
    claudePath: join(projectRoot, '.claude', 'settings.json'),
  };
}

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

function jsonString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map((value) => jsonString(value)).join(', ')}]`;
}

export function renderCodexPolicyProjectionBlock(projection: PolicyProjection): string {
  return [
    COODRA_POLICY_PROJECTION_BEGIN,
    '[coodra.policy_projection]',
    'managed_by = "coodra"',
    'schema_version = 1',
    `project_id = ${jsonString(projection.projectId)}`,
    `project_slug = ${projection.projectSlug === null ? '""' : jsonString(projection.projectSlug)}`,
    `generated_at = ${jsonString(projection.generatedAt)}`,
    `projection_hash = ${jsonString(projection.projectionHash)}`,
    `active_rule_ids = ${tomlStringArray(projection.activeRuleIds)}`,
    `active_exception_ids = ${tomlStringArray(projection.activeExceptionIds)}`,
    `policy_version_ids = ${tomlStringArray(projection.policyVersionIds)}`,
    projection.nativePermissions?.claude !== undefined
      ? `claude_native_permissions_hash = ${jsonString(projection.nativePermissions.claude.projectionHash)}`
      : null,
    projection.nativePermissions?.codex !== undefined
      ? `codex_native_permissions_hash = ${jsonString(projection.nativePermissions.codex.projectionHash)}`
      : null,
    COODRA_POLICY_PROJECTION_END,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function policyProjectionSurface(projection: PolicyProjection) {
  return {
    schemaVersion: projection.schemaVersion,
    managedBy: projection.managedBy,
    projectId: projection.projectId,
    projectSlug: projection.projectSlug,
    policies: [...projection.policies].sort((a, b) => a.policyId.localeCompare(b.policyId)),
    activeRuleIds: [...projection.activeRuleIds].sort(),
    activeExceptionIds: [...projection.activeExceptionIds].sort(),
    policyVersionIds: [...projection.policyVersionIds].sort(),
    nativePermissions: projection.nativePermissions,
  } as const;
}

export function hashPolicyProjectionSurface(projection: PolicyProjection): string {
  return sha256(stableStringify(policyProjectionSurface(projection)));
}

function upsertManagedBlock(raw: string, block: string, begin: string, endMarker: string): string {
  const start = raw.indexOf(begin);
  const end = raw.indexOf(endMarker);
  if (start >= 0 && end >= start) {
    const afterEnd = end + endMarker.length;
    return `${raw.slice(0, start)}${block}${raw.slice(afterEnd)}`;
  }
  const trimmed = raw.trimEnd();
  return `${trimmed}${trimmed.length > 0 ? '\n\n' : ''}${block}\n`;
}

export function upsertManagedTextBlock(raw: string, block: string): string {
  return upsertManagedBlock(raw, block, COODRA_POLICY_PROJECTION_BEGIN, COODRA_POLICY_PROJECTION_END);
}

export function extractCodexPolicyProjectionHash(raw: string): string | null {
  const start = raw.indexOf(COODRA_POLICY_PROJECTION_BEGIN);
  const end = raw.indexOf(COODRA_POLICY_PROJECTION_END);
  if (start < 0 || end < start) return null;
  const block = raw.slice(start, end + COODRA_POLICY_PROJECTION_END.length);
  const match = /^\s*projection_hash\s*=\s*"([^"]+)"/m.exec(block);
  return match?.[1] ?? null;
}

function parseTomlString(block: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(block);
  return match?.[1] ?? null;
}

function parseTomlStringArray(block: string, key: string): string[] {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm').exec(block);
  if (match === null) return [];
  const values = match[1] ?? '';
  const out: string[] = [];
  const stringRegex = /"([^"]*)"/g;
  let item = stringRegex.exec(values);
  while (item !== null) {
    out.push(item[1] ?? '');
    item = stringRegex.exec(values);
  }
  return out.sort();
}

function codexProjectionBlockContentHash(raw: string): string | null {
  const block = extractManagedBlock(raw, COODRA_POLICY_PROJECTION_BEGIN, COODRA_POLICY_PROJECTION_END);
  if (block === null) return null;
  const surface = {
    managedBy: parseTomlString(block, 'managed_by'),
    schemaVersion: Number.parseInt(/^\s*schema_version\s*=\s*(\d+)/m.exec(block)?.[1] ?? '0', 10),
    projectId: parseTomlString(block, 'project_id'),
    projectSlug: parseTomlString(block, 'project_slug'),
    projectionHash: parseTomlString(block, 'projection_hash'),
    activeRuleIds: parseTomlStringArray(block, 'active_rule_ids'),
    activeExceptionIds: parseTomlStringArray(block, 'active_exception_ids'),
    policyVersionIds: parseTomlStringArray(block, 'policy_version_ids'),
    claudeNativePermissionsHash: parseTomlString(block, 'claude_native_permissions_hash'),
    codexNativePermissionsHash: parseTomlString(block, 'codex_native_permissions_hash'),
  };
  return sha256(stableStringify(surface));
}

export function expectedCodexProjectionBlockContentHash(projection: PolicyProjection): string {
  const block = renderCodexPolicyProjectionBlock(projection);
  return codexProjectionBlockContentHash(block) ?? sha256('');
}

function sortedCodexFilesystemRules(rules: readonly CodexNativeFilesystemRule[]): readonly CodexNativeFilesystemRule[] {
  return [...rules].sort((a, b) =>
    a.path === b.path ? a.access.localeCompare(b.access) : a.path.localeCompare(b.path),
  );
}

function codexNativePermissionsSurface(native: Omit<CodexNativePermissionsProjection, 'projectionHash'>) {
  return {
    schemaVersion: native.schemaVersion,
    profileName: native.profileName,
    defaultPermissions: native.defaultPermissions,
    extends: native.extends,
    filesystemGlobScanMaxDepth: native.filesystemGlobScanMaxDepth,
    filesystemWorkspaceRoots: sortedCodexFilesystemRules(native.filesystemWorkspaceRoots),
    network: native.network,
  } as const;
}

export function hashCodexNativePermissionsSurface(
  native: Omit<CodexNativePermissionsProjection, 'projectionHash'>,
): string {
  return sha256(stableStringify(codexNativePermissionsSurface(native)));
}

function renderCodexWorkspaceRootRules(rules: readonly CodexNativeFilesystemRule[]): string[] {
  return sortedCodexFilesystemRules(rules).map((rule) => `${jsonString(rule.path)} = ${jsonString(rule.access)}`);
}

export function renderCodexNativePermissionsBlock(native: CodexNativePermissionsProjection): string {
  return [
    COODRA_CODEX_NATIVE_PERMISSIONS_BEGIN,
    `[permissions.${native.profileName}]`,
    `description = ${jsonString(native.description)}`,
    `extends = ${jsonString(native.extends)}`,
    '',
    `[permissions.${native.profileName}.filesystem]`,
    native.filesystemGlobScanMaxDepth !== null ? `glob_scan_max_depth = ${native.filesystemGlobScanMaxDepth}` : null,
    '',
    `[permissions.${native.profileName}.filesystem.":workspace_roots"]`,
    ...renderCodexWorkspaceRootRules(native.filesystemWorkspaceRoots),
    '',
    `[permissions.${native.profileName}.network]`,
    `enabled = ${native.network.enabled ? 'true' : 'false'}`,
    COODRA_CODEX_NATIVE_PERMISSIONS_END,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function upsertTopLevelTomlString(raw: string, key: string, value: string): string {
  const assignment = `${key} = ${jsonString(value)}`;
  const lines = raw.split(/\r?\n/);
  let firstTableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  if (firstTableIndex < 0) firstTableIndex = lines.length;
  for (let index = 0; index < firstTableIndex; index += 1) {
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index] ?? '')) {
      lines[index] = assignment;
      return lines.join('\n');
    }
  }
  const firstManagedMarkerIndex = lines.findIndex((line) => line.trim() === COODRA_POLICY_PROJECTION_BEGIN);
  const insertIndex =
    firstManagedMarkerIndex >= 0 && firstManagedMarkerIndex < firstTableIndex
      ? firstManagedMarkerIndex
      : firstTableIndex;
  lines.splice(insertIndex, 0, assignment, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export async function writePolicyProjectionFiles(
  projectRoot: string,
  projection: PolicyProjection,
  options: { readonly agents?: readonly PolicyProjectionAgent[] } = {},
): Promise<PolicyProjectionWriteResult> {
  const { codexPath, claudePath } = policyProjectionPaths(projectRoot);
  const agents = options.agents ?? ['codex', 'claude'];
  const agentSet = new Set<PolicyProjectionAgent>(agents);
  let wroteCodexPath: string | undefined;
  let wroteClaudePath: string | undefined;

  if (agentSet.has('codex')) {
    await mkdir(dirname(codexPath), { recursive: true });
    let codexRaw = '';
    try {
      codexRaw = await readFile(codexPath, 'utf8');
    } catch {
      codexRaw = '';
    }
    let codexNext = upsertManagedTextBlock(codexRaw, renderCodexPolicyProjectionBlock(projection));
    if (projection.nativePermissions?.codex !== undefined) {
      codexNext = upsertTopLevelTomlString(codexNext, 'trust_level', 'trusted');
      codexNext = upsertTopLevelTomlString(
        codexNext,
        'default_permissions',
        projection.nativePermissions.codex.defaultPermissions,
      );
      codexNext = upsertManagedBlock(
        codexNext,
        renderCodexNativePermissionsBlock(projection.nativePermissions.codex),
        COODRA_CODEX_NATIVE_PERMISSIONS_BEGIN,
        COODRA_CODEX_NATIVE_PERMISSIONS_END,
      );
    }
    await writeFile(codexPath, codexNext, 'utf8');
    wroteCodexPath = codexPath;
  }

  if (agentSet.has('claude')) {
    await mkdir(dirname(claudePath), { recursive: true });
    let claudeSettings: Record<string, unknown> = {};
    try {
      const raw = await readFile(claudePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        claudeSettings = parsed as Record<string, unknown>;
      }
    } catch {
      claudeSettings = {};
    }
    const coodra =
      claudeSettings.coodra !== null &&
      typeof claudeSettings.coodra === 'object' &&
      !Array.isArray(claudeSettings.coodra)
        ? (claudeSettings.coodra as Record<string, unknown>)
        : {};
    const previousProjection = parseProjection(coodra.policyProjection);
    const permissions = mergeClaudePermissions(
      claudeSettings.permissions,
      projection.nativePermissions?.claude,
      previousProjection?.nativePermissions?.claude,
    );
    if (permissions !== null) {
      claudeSettings.permissions = permissions;
    }
    claudeSettings.coodra = { ...coodra, policyProjection: projection };
    await writeFile(claudePath, `${JSON.stringify(claudeSettings, null, 2)}\n`, 'utf8');
    wroteClaudePath = claudePath;
  }

  return {
    ...(wroteCodexPath !== undefined ? { codexPath: wroteCodexPath } : {}),
    ...(wroteClaudePath !== undefined ? { claudePath: wroteClaudePath } : {}),
    agents: [...agentSet].sort(),
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function removeGenerated(existing: readonly string[], previous: readonly string[]): string[] {
  const generated = new Set(previous);
  return existing.filter((entry) => !generated.has(entry));
}

function appendUnique(base: readonly string[], generated: readonly string[]): string[] {
  const out = [...base];
  const seen = new Set(out);
  for (const entry of generated) {
    if (seen.has(entry)) continue;
    out.push(entry);
    seen.add(entry);
  }
  return out;
}

function mergeClaudePermissions(
  rawPermissions: unknown,
  next: ClaudeNativePermissionsProjection | undefined,
  previous: ClaudeNativePermissionsProjection | undefined,
): Record<string, unknown> | null {
  if (next === undefined) return null;
  const current =
    rawPermissions !== null && typeof rawPermissions === 'object' && !Array.isArray(rawPermissions)
      ? (rawPermissions as Record<string, unknown>)
      : {};
  const previousAllow = previous?.allow ?? [];
  const previousAsk = previous?.ask ?? [];
  const previousDeny = previous?.deny ?? [];
  const allow = appendUnique(removeGenerated(asStringArray(current.allow), previousAllow), next.allow);
  const ask = appendUnique(removeGenerated(asStringArray(current.ask), previousAsk), next.ask);
  const deny = appendUnique(removeGenerated(asStringArray(current.deny), previousDeny), next.deny);
  return {
    ...current,
    allow,
    ask,
    deny,
    disableAutoMode: next.settings.disableAutoMode,
    disableBypassPermissionsMode: next.settings.disableBypassPermissionsMode,
  };
}

export function hashClaudePermissionsSurface(permissions: unknown): string {
  const obj =
    permissions !== null && typeof permissions === 'object' && !Array.isArray(permissions)
      ? (permissions as Record<string, unknown>)
      : {};
  return sha256(
    stableStringify({
      allow: asStringArray(obj.allow).sort(),
      ask: asStringArray(obj.ask).sort(),
      deny: asStringArray(obj.deny).sort(),
      defaultMode: typeof obj.defaultMode === 'string' ? obj.defaultMode : null,
      disableAutoMode: obj.disableAutoMode,
      disableBypassPermissionsMode: obj.disableBypassPermissionsMode,
    }),
  );
}

export async function readCodexPolicyProjection(projectRoot: string): Promise<PolicyProjectionReadResult> {
  const { codexPath } = policyProjectionPaths(projectRoot);
  try {
    const raw = await readFile(codexPath, 'utf8');
    const native = parseCodexNativePermissions(raw);
    const missingNativePermissions = missingCodexNativePermissions(raw, native);
    return {
      path: codexPath,
      exists: true,
      projection: null,
      projectionHash: extractCodexPolicyProjectionHash(raw),
      projectionContentHash: codexProjectionBlockContentHash(raw),
      permissionsHash: native?.projectionHash ?? null,
      missingNativePermissions,
      warnings: codexProjectionWarnings(raw),
    };
  } catch (err) {
    return {
      path: codexPath,
      exists: false,
      projection: null,
      projectionHash: null,
      projectionContentHash: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function extractManagedBlock(raw: string, begin: string, endMarker: string): string | null {
  const start = raw.indexOf(begin);
  const end = raw.indexOf(endMarker);
  if (start < 0 || end < start) return null;
  return raw.slice(start, end + endMarker.length);
}

function topLevelTomlString(raw: string, key: string): string | null {
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (/^\s*\[/.test(line)) return null;
    const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`).exec(line);
    if (match !== null) return match[1] ?? null;
  }
  return null;
}

function codexProjectTrustLevel(raw: string): string | null {
  return topLevelTomlString(raw, 'trust_level');
}

function hasLegacyCodexSandboxSetting(raw: string): boolean {
  return /^\s*sandbox_mode\s*=/m.test(raw) || /^\s*\[sandbox_workspace_write\]/m.test(raw);
}

function parseCodexNativePermissions(raw: string): CodexNativePermissionsProjection | null {
  const block = extractManagedBlock(raw, COODRA_CODEX_NATIVE_PERMISSIONS_BEGIN, COODRA_CODEX_NATIVE_PERMISSIONS_END);
  if (block === null) return null;
  const profileName = CODEX_NATIVE_PERMISSION_PROFILE_NAME;
  const description =
    /^\s*description\s*=\s*"([^"]*)"/m.exec(block)?.[1] ?? 'Coodra-managed project policy projection.';
  const extendsValue = /^\s*extends\s*=\s*"([^"]*)"/m.exec(block)?.[1] ?? ':workspace';
  const depthMatch = /^\s*glob_scan_max_depth\s*=\s*(\d+)/m.exec(block);
  const networkMatch = /^\s*enabled\s*=\s*(true|false)/m.exec(
    block.slice(block.indexOf(`[permissions.${profileName}.network]`)),
  );
  const rootsSection = extractTomlSection(block, `[permissions.${profileName}.filesystem.":workspace_roots"]`);
  const filesystemWorkspaceRoots: CodexNativeFilesystemRule[] = [];
  if (rootsSection !== null) {
    for (const line of rootsSection.split(/\r?\n/)) {
      const match = /^\s*"([^"]+)"\s*=\s*"(read|write|deny)"\s*$/.exec(line);
      if (match !== null) {
        filesystemWorkspaceRoots.push({
          path: match[1] ?? '',
          access: match[2] as 'read' | 'write' | 'deny',
        });
      }
    }
  }
  const payload = {
    schemaVersion: 1,
    profileName,
    defaultPermissions: profileName,
    description,
    extends: extendsValue === ':workspace' ? ':workspace' : ':workspace',
    filesystemGlobScanMaxDepth: depthMatch === null ? null : Number.parseInt(depthMatch[1] ?? '0', 10),
    filesystemWorkspaceRoots,
    network: {
      enabled: networkMatch?.[1] === 'true',
    },
    translatedRuleIds: [],
    untranslatedRuleIds: [],
  } as const;
  return {
    ...payload,
    projectionHash: hashCodexNativePermissionsSurface(payload),
  };
}

function extractTomlSection(raw: string, sectionHeader: string): string | null {
  const start = raw.indexOf(sectionHeader);
  if (start < 0) return null;
  const afterHeader = start + sectionHeader.length;
  const rest = raw.slice(afterHeader);
  const nextSection = /\n\s*\[/.exec(rest);
  return nextSection === null ? rest : rest.slice(0, nextSection.index);
}

function missingCodexNativePermissions(raw: string, native: CodexNativePermissionsProjection | null): string[] {
  const missing: string[] = [];
  if (codexProjectTrustLevel(raw) !== 'trusted') {
    missing.push('trust_level:trusted');
  }
  if (topLevelTomlString(raw, 'default_permissions') !== CODEX_NATIVE_PERMISSION_PROFILE_NAME) {
    missing.push('default_permissions');
  }
  if (hasLegacyCodexSandboxSetting(raw)) {
    missing.push('legacy_sandbox_setting_conflict');
  }
  if (native === null) {
    missing.push('codex_native_permissions_block');
  }
  return missing;
}

function codexProjectionWarnings(raw: string): string[] {
  if (topLevelTomlString(raw, 'default_permissions') === CODEX_NATIVE_PERMISSION_PROFILE_NAME) {
    return [
      'codex_desktop_project_default_permissions_bug_open: project-local default_permissions may be ignored by Codex Desktop; CLI -c override still applies it.',
    ];
  }
  return [];
}

function parseProjection(value: unknown): PolicyProjection | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Partial<PolicyProjection>;
  if (obj.managedBy !== 'coodra' || obj.schemaVersion !== 1 || typeof obj.projectionHash !== 'string') return null;
  return obj as PolicyProjection;
}

export async function readClaudePolicyProjection(projectRoot: string): Promise<PolicyProjectionReadResult> {
  const { claudePath } = policyProjectionPaths(projectRoot);
  try {
    const raw = await readFile(claudePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const projection =
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).coodra !== null &&
      typeof (parsed as Record<string, unknown>).coodra === 'object'
        ? parseProjection(((parsed as Record<string, unknown>).coodra as Record<string, unknown>).policyProjection)
        : null;
    const permissions =
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).permissions !== null &&
      typeof (parsed as Record<string, unknown>).permissions === 'object'
        ? ((parsed as Record<string, unknown>).permissions as Record<string, unknown>)
        : {};
    const missingNativePermissions =
      projection?.nativePermissions?.claude !== undefined
        ? missingClaudeNativePermissions(permissions, projection.nativePermissions.claude)
        : [];
    return {
      path: claudePath,
      exists: true,
      projection,
      projectionHash: projection?.projectionHash ?? null,
      projectionContentHash: projection !== null ? hashPolicyProjectionSurface(projection) : null,
      permissionsHash: hashClaudePermissionsSurface(permissions),
      missingNativePermissions,
    };
  } catch (err) {
    return {
      path: claudePath,
      exists: false,
      projection: null,
      projectionHash: null,
      projectionContentHash: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function missingClaudeNativePermissions(
  permissions: Record<string, unknown>,
  native: ClaudeNativePermissionsProjection,
): string[] {
  const missing: string[] = [];
  const allow = new Set(asStringArray(permissions.allow));
  const ask = new Set(asStringArray(permissions.ask));
  const deny = new Set(asStringArray(permissions.deny));
  for (const entry of native.allow) if (!allow.has(entry)) missing.push(`allow:${entry}`);
  for (const entry of native.ask) if (!ask.has(entry)) missing.push(`ask:${entry}`);
  for (const entry of native.deny) if (!deny.has(entry)) missing.push(`deny:${entry}`);
  if (permissions.disableAutoMode !== native.settings.disableAutoMode) missing.push('disableAutoMode');
  if (permissions.disableBypassPermissionsMode !== native.settings.disableBypassPermissionsMode) {
    missing.push('disableBypassPermissionsMode');
  }
  if (permissions.defaultMode === 'bypassPermissions') {
    missing.push('defaultMode:bypassPermissions');
  }
  return missing;
}
