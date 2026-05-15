#!/usr/bin/env node
/**
 * Renames every reference to "contextos" → "coodra" across the repo.
 *
 * Usage:
 *   node scripts/rename-contextos-to-coodra.mjs --dry-run   # print plan
 *   node scripts/rename-contextos-to-coodra.mjs --apply     # mutate files
 *
 * Ordered substitution rules — order matters (most-specific first):
 *   1.  `@coodra/contextos-`             → `@coodra/`             (npm package refs)
 *   2.  `contextos__`                    → `coodra__`             (MCP tool names)
 *   3.  `CONTEXTOS_`                     → `COODRA_`              (env vars)
 *   4.  `.contextos.json`                → `.coodra.json`         (project marker)
 *   5.  `.contextos/`                    → `.coodra/`             (dir path with trailing slash)
 *   6.  `'.contextos'`, `".contextos"`,  → `'.coodra'`, `".coodra"`, "`.coodra`"
 *       "`.contextos`"
 *   7.  `contextos:start` / `:end`       → `coodra:start` / `:end` (instruction block markers)
 *   8.  `contextos_cli`                  → `coodra_cli`            (Clerk JWT template name)
 *   9.  `mcp_servers.contextos`          → `mcp_servers.coodra`   (Codex TOML)
 *   10. `mcpServers": { "contextos"`     → `mcpServers": { "coodra"` (json key)
 *   11. `"contextos":` JSON key (loose)  → `"coodra":` ONLY inside .mcp.json / template.json
 *   12. `ContextOS`                      → `Coodra`               (TitleCase prose)
 *   13. `CONTEXTOS` (whole-word)         → `COODRA`               (caps prose)
 *   14. `contextos` (whole-word)         → `coodra`               (catch-all lowercase)
 *
 * Filename renames:
 *   - any file path segment containing "contextos" gets renamed lowercase-safely
 *
 * Excludes:
 *   - .git/, node_modules/ (anywhere), dist/, .next/, .turbo/, .claude/worktrees/
 *   - pnpm-lock.yaml (regenerated after rename)
 *   - binary files (heuristic: skip if not in TEXT_EXTS)
 */

import { readFileSync, writeFileSync, statSync, readdirSync, renameSync } from 'node:fs';
import { join, relative, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..');

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const DRY = args.has('--dry-run') || !APPLY;

const EXCLUDE_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '.turbo', '.cache']);
const EXCLUDE_PATH_FRAGMENTS = ['.claude/worktrees/'];
const EXCLUDE_FILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']);

const TEXT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx',
  '.json', '.jsonc', '.json5',
  '.md', '.mdx', '.txt',
  '.yml', '.yaml',
  '.toml', '.ini', '.cfg', '.conf',
  '.sh', '.bash', '.zsh', '.fish',
  '.sql',
  '.py',
  '.html', '.css', '.scss',
  '.env.example',
]);

// Files-or-paths that should NEVER be substituted (preserve verbatim)
const SKIP_FILES = new Set([
  'scripts/rename-contextos-to-coodra.mjs', // this script itself
  'CHANGELOG.md', // if exists, don't rewrite history of name changes
]);

// Rule = { name, pattern (RegExp), replacement, filter? }
// `filter` is an optional fn(relPath) => boolean — if set, rule only applies to matching paths
const RULES = [
  { name: 'r01-pkg-ref',       pattern: /@coodra\/contextos-/g,           replacement: '@coodra/' },
  { name: 'r02-mcp-tool',      pattern: /contextos__/g,                   replacement: 'coodra__' },
  { name: 'r03-env-var',       pattern: /CONTEXTOS_/g,                    replacement: 'COODRA_' },
  { name: 'r04-marker-file',   pattern: /\.contextos\.json/g,             replacement: '.coodra.json' },
  { name: 'r05-dir-slash',     pattern: /\.contextos\//g,                 replacement: '.coodra/' },
  { name: 'r06a-sq',           pattern: /'\.contextos'/g,                 replacement: "'.coodra'" },
  { name: 'r06b-dq',           pattern: /"\.contextos"/g,                 replacement: '".coodra"' },
  { name: 'r06c-bt',           pattern: /`\.contextos`/g,                 replacement: '`.coodra`' },
  { name: 'r06d-bare-tilde',   pattern: /~\/\.contextos\b/g,              replacement: '~/.coodra' },
  { name: 'r06e-dir-eos',      pattern: /\.contextos$/gm,                 replacement: '.coodra' },
  { name: 'r07a-block-start',  pattern: /contextos:start/g,               replacement: 'coodra:start' },
  { name: 'r07b-block-end',    pattern: /contextos:end/g,                 replacement: 'coodra:end' },
  { name: 'r08-clerk-tmpl',    pattern: /contextos_cli/g,                 replacement: 'coodra_cli' },
  { name: 'r09-codex-toml',    pattern: /mcp_servers\.contextos/g,        replacement: 'mcp_servers.coodra' },
  // JSON key "contextos" — narrow to .json files only, to avoid over-matching prose
  {
    name: 'r10-json-mcp-key',
    pattern: /"contextos":\s*\{/g,
    replacement: '"coodra": {',
    filter: (rel) => rel.endsWith('.json') || rel.endsWith('.jsonc'),
  },
  // TOML/code key forms
  { name: 'r10b-toml-key',     pattern: /\[mcp_servers\.coodra\]/g,       replacement: '[mcp_servers.coodra]' }, // no-op safety after r09
  // Match `ContextOS` (caps OS) with or without word boundary — catches both
  // "ContextOS" standalone and "ContextOS_functest" etc.
  { name: 'r11-titlecase-caps', pattern: /ContextOS/g,                    replacement: 'Coodra' },
  // TitleCase `Contextos<rest>` covers ContextosJsonSchema, ContextosMcpEntry, loadContextosHomeEnv, etc.
  { name: 'r11b-titlecase-id', pattern: /Contextos/g,                     replacement: 'Coodra' },
  { name: 'r12-upper',         pattern: /\bCONTEXTOS\b/g,                 replacement: 'COODRA' },
  // Catch-all lowercase — no word boundary so camelCase (contextosHome) +
  // snake_case (contextos_e2e) identifiers also rename. Earlier rules (r01..r12)
  // have already substituted every specific high-value pattern, so anything
  // remaining is safe to rewrite.
  { name: 'r13-lower-any',     pattern: /contextos/g,                     replacement: 'coodra' },
];

function shouldSkipDir(name) {
  return EXCLUDE_DIRS.has(name);
}

function shouldSkipPath(rel) {
  for (const frag of EXCLUDE_PATH_FRAGMENTS) {
    if (rel.includes(frag)) return true;
  }
  if (EXCLUDE_FILES.has(basename(rel))) return true;
  if (SKIP_FILES.has(rel)) return true;
  return false;
}

// Extensionless text files we know we want to process
const KNOWN_TEXT_BASENAMES = new Set([
  'Dockerfile', 'Makefile', 'LICENSE', 'README', 'AUTHORS', 'NOTICE',
  'pre-commit', 'pre-push', 'commit-msg', 'post-commit',
  'post-merge', 'post-checkout', 'prepare-commit-msg',
]);

function isTextFile(rel) {
  const b = basename(rel);
  // dotfiles like .gitignore — treat as text
  if (b.startsWith('.') && !b.includes('.', 1)) return true;
  // exact-name files
  if (KNOWN_TEXT_BASENAMES.has(b)) return true;
  // Dockerfile.<variant> (e.g. Dockerfile.cloud-migrate)
  if (b.startsWith('Dockerfile.')) return true;
  // by extension
  for (const ext of TEXT_EXTS) {
    if (b.endsWith(ext)) return true;
  }
  return false;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(REPO_ROOT, full);
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      if (shouldSkipPath(rel + '/')) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      if (shouldSkipPath(rel)) continue;
      yield { full, rel };
    }
  }
}

function applyRules(content, rel) {
  const hits = [];
  let result = content;
  for (const rule of RULES) {
    if (rule.filter && !rule.filter(rel)) continue;
    const before = result;
    let count = 0;
    result = result.replace(rule.pattern, (...m) => {
      count += 1;
      return rule.replacement;
    });
    if (count > 0) hits.push({ rule: rule.name, count });
  }
  return { result, hits, changed: result !== content };
}

const filesChanged = [];
const filesRenamed = [];
let totalSubs = 0;

for (const { full, rel } of walk(REPO_ROOT)) {
  if (!isTextFile(rel)) continue;
  let original;
  try {
    original = readFileSync(full, 'utf8');
  } catch {
    continue;
  }
  const { result, hits, changed } = applyRules(original, rel);
  if (changed) {
    filesChanged.push({ rel, hits });
    totalSubs += hits.reduce((s, h) => s + h.count, 0);
    if (APPLY) {
      writeFileSync(full, result, 'utf8');
    }
  }
}

// File renames — second pass after content rewrites. Case-insensitive scan,
// case-preserving substitution (CONTEXTOS_*, Contextos*, contextos* all handled).
for (const { full, rel } of walk(REPO_ROOT)) {
  if (!/contextos/i.test(basename(rel))) continue;
  const newRel = rel
    .replace(/CONTEXTOS/g, 'COODRA')
    .replace(/Contextos/g, 'Coodra')
    .replace(/contextos/g, 'coodra');
  const newFull = join(REPO_ROOT, newRel);
  filesRenamed.push({ from: rel, to: newRel });
  if (APPLY) {
    renameSync(full, newFull);
  }
}

console.log(`\n=== rename plan ===`);
console.log(`mode: ${APPLY ? 'APPLY (mutating)' : 'DRY-RUN (no writes)'}`);
console.log(`files with content changes: ${filesChanged.length}`);
console.log(`total substitutions: ${totalSubs}`);
console.log(`files to rename: ${filesRenamed.length}`);

console.log(`\n--- files to rename ---`);
for (const { from, to } of filesRenamed) {
  console.log(`  ${from}  →  ${to}`);
}

console.log(`\n--- top 30 most-touched files ---`);
const top = [...filesChanged]
  .map((f) => ({ ...f, total: f.hits.reduce((s, h) => s + h.count, 0) }))
  .sort((a, b) => b.total - a.total)
  .slice(0, 30);
for (const f of top) {
  console.log(`  [${f.total.toString().padStart(4)}] ${f.rel}`);
}

console.log(`\n--- rule frequency ---`);
const ruleAgg = new Map();
for (const f of filesChanged) {
  for (const h of f.hits) {
    ruleAgg.set(h.rule, (ruleAgg.get(h.rule) || 0) + h.count);
  }
}
const sortedRules = [...ruleAgg.entries()].sort((a, b) => b[1] - a[1]);
for (const [rule, n] of sortedRules) {
  console.log(`  ${rule.padEnd(20)} ${n}`);
}

if (DRY) {
  console.log(`\n(dry-run — pass --apply to mutate)`);
}
