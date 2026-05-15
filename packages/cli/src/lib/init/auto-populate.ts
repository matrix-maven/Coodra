import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * `lib/init/auto-populate` — generate `<!-- @auto:* -->` section
 * content from a project's actual shape. Module 08b S15.
 *
 * Each generator is a pure function from `(projectRoot, sectionName)`
 * to a string. Empty/no-data results return a single-line italic
 * "no X detected" placeholder rather than an empty string — so the
 * section stays explicitly populated and the operator can spot the
 * gap.
 *
 * Generator registry maps `sectionName` → `(projectRoot) => content`.
 * Unknown section names get a placeholder so the section isn't left
 * empty after `pack regenerate`.
 */

export type AutoSectionGenerator = (projectRoot: string) => string;

export interface PopulateOptions {
  /** Override the recursion depth for `directory-structure`. Default 3. */
  readonly directoryDepth?: number;
}

const NO_DATA_PLACEHOLDERS: Readonly<Record<string, string>> = {
  dependencies:
    '_No dependencies detected (no package.json / pyproject.toml / Cargo.toml / go.mod found at the project root)._',
  'directory-structure': '_Project root is empty._',
  scripts: '_No scripts detected (no package.json / Makefile / pyproject.toml [project.scripts] found)._',
  'entry-points': '_No entry points detected._',
  services: '_No Coodra services running on this machine._',
  overview: '_(write a short overview of what this project does)_',
};

export const AUTO_SECTION_GENERATORS: Readonly<Record<string, AutoSectionGenerator>> = {
  dependencies: generateDependencies,
  'directory-structure': generateDirectoryStructure,
  scripts: generateScripts,
  'entry-points': generateEntryPoints,
  services: generateServices,
  overview: () => NO_DATA_PLACEHOLDERS.overview ?? '',
};

/**
 * Returns a populated content map for the given section names. Sections
 * not in the generator registry get the no-data placeholder so the
 * operator can fill them in manually without leaving the section blank.
 */
export function populateAutoSections(
  projectRoot: string,
  sectionNames: ReadonlyArray<string>,
  _options: PopulateOptions = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of sectionNames) {
    const gen = AUTO_SECTION_GENERATORS[name];
    if (gen !== undefined) {
      const result = gen(projectRoot).trim();
      out[name] = result.length === 0 ? (NO_DATA_PLACEHOLDERS[name] ?? `_(no data for ${name})_`) : result;
    } else {
      out[name] = NO_DATA_PLACEHOLDERS[name] ?? `_(no generator registered for "${name}" — populate manually)_`;
    }
  }
  return out;
}

// ============================================================================
// Generators
// ============================================================================

function generateDependencies(projectRoot: string): string {
  const lines: string[] = [];
  const pkgJson = readJsonIfExists(join(projectRoot, 'package.json'));
  if (pkgJson !== null) {
    const deps = { ...((pkgJson.dependencies as Record<string, string>) ?? {}) };
    const devDeps = { ...((pkgJson.devDependencies as Record<string, string>) ?? {}) };
    if (Object.keys(deps).length > 0 || Object.keys(devDeps).length > 0) {
      lines.push('| Library | Version | Kind |');
      lines.push('|---|---|---|');
      for (const [name, ver] of Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`| \`${name}\` | \`${ver}\` | dependency |`);
      }
      for (const [name, ver] of Object.entries(devDeps).sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`| \`${name}\` | \`${ver}\` | devDependency |`);
      }
    }
  }
  const pyproject = readTextIfExists(join(projectRoot, 'pyproject.toml'));
  if (pyproject !== null) {
    if (lines.length === 0) {
      lines.push('| Library | Version | Source |');
      lines.push('|---|---|---|');
    } else {
      lines.push('');
      lines.push('### Python (`pyproject.toml`):');
      lines.push('| Library | Version | Source |');
      lines.push('|---|---|---|');
    }
    const matches = [...pyproject.matchAll(/^"?([a-zA-Z0-9_.-]+)"?\s*=\s*"([^"]+)"/gm)];
    for (const m of matches) {
      lines.push(`| \`${m[1]}\` | \`${m[2]}\` | pyproject.toml |`);
    }
  }
  const cargo = readTextIfExists(join(projectRoot, 'Cargo.toml'));
  if (cargo !== null) {
    if (lines.length === 0) {
      lines.push('| Crate | Version | Source |');
      lines.push('|---|---|---|');
    } else {
      lines.push('');
      lines.push('### Rust (`Cargo.toml`):');
      lines.push('| Crate | Version | Source |');
      lines.push('|---|---|---|');
    }
    const inDeps = cargo.match(/\[dependencies\]([\s\S]*?)(?=\n\[|$)/);
    if (inDeps !== null && inDeps[1] !== undefined) {
      const matches = [...inDeps[1].matchAll(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/gm)];
      for (const m of matches) {
        lines.push(`| \`${m[1]}\` | \`${m[2]}\` | Cargo.toml |`);
      }
    }
  }
  const goMod = readTextIfExists(join(projectRoot, 'go.mod'));
  if (goMod !== null) {
    if (lines.length === 0) {
      lines.push('| Module | Version | Source |');
      lines.push('|---|---|---|');
    } else {
      lines.push('');
      lines.push('### Go (`go.mod`):');
      lines.push('| Module | Version | Source |');
      lines.push('|---|---|---|');
    }
    const reqBlock = goMod.match(/require\s*\(\s*([\s\S]*?)\s*\)/);
    const entries =
      reqBlock !== null && reqBlock[1] !== undefined
        ? reqBlock[1]
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith('//'))
        : [...goMod.matchAll(/^require\s+(\S+)\s+(\S+)/gm)].map((m) => `${m[1]} ${m[2]}`);
    for (const entry of entries) {
      const parts = entry.split(/\s+/);
      if (parts.length >= 2) {
        lines.push(`| \`${parts[0]}\` | \`${parts[1]}\` | go.mod |`);
      }
    }
  }
  return lines.length === 0 ? '' : lines.join('\n');
}

function generateDirectoryStructure(projectRoot: string): string {
  const lines: string[] = [];
  walkDirShallow(projectRoot, '', 3, lines);
  if (lines.length === 0) return '';
  return ['```', ...lines, '```'].join('\n');
}

function walkDirShallow(absRoot: string, relPath: string, depth: number, out: string[]): void {
  if (depth < 0) return;
  const abs = relPath === '' ? absRoot : join(absRoot, relPath);
  let entries: string[] = [];
  try {
    entries = readdirSync(abs);
  } catch {
    return;
  }
  // Filter out noise.
  const skip = new Set([
    'node_modules',
    '.git',
    '.coodra',
    'dist',
    'build',
    '.next',
    '.cache',
    '__pycache__',
    'target',
    '.venv',
    'venv',
    '.turbo',
  ]);
  for (const name of entries.sort()) {
    if (name.startsWith('.') && name !== '.coodra.json' && name !== '.mcp.json') continue;
    if (skip.has(name)) continue;
    const subRel = relPath === '' ? name : `${relPath}/${name}`;
    let isDir = false;
    try {
      isDir = statSync(join(absRoot, subRel)).isDirectory();
    } catch {
      continue;
    }
    out.push(`${relPath === '' ? '' : '  '.repeat(relPath.split('/').length)}${name}${isDir ? '/' : ''}`);
    if (isDir && depth > 0) {
      walkDirShallow(absRoot, subRel, depth - 1, out);
    }
    // Cap output to keep the section readable.
    if (out.length > 200) {
      out.push('… (output truncated at 200 entries)');
      return;
    }
  }
}

function generateScripts(projectRoot: string): string {
  const lines: string[] = [];
  const pkgJson = readJsonIfExists(join(projectRoot, 'package.json'));
  if (pkgJson !== null && pkgJson.scripts !== undefined) {
    const scripts = pkgJson.scripts as Record<string, string>;
    if (Object.keys(scripts).length > 0) {
      lines.push('### npm scripts (`package.json#scripts`):');
      lines.push('');
      lines.push('| Script | Command |');
      lines.push('|---|---|');
      for (const [name, cmd] of Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`| \`pnpm run ${name}\` | \`${cmd.replaceAll('|', '\\|')}\` |`);
      }
    }
  }
  const makefile = readTextIfExists(join(projectRoot, 'Makefile'));
  if (makefile !== null) {
    if (lines.length > 0) lines.push('');
    lines.push('### Makefile targets:');
    lines.push('');
    const targets = [...makefile.matchAll(/^([a-zA-Z0-9_.-]+):/gm)].map((m) => m[1]);
    for (const t of targets) lines.push(`- \`make ${t}\``);
  }
  return lines.length === 0 ? '' : lines.join('\n');
}

function generateEntryPoints(projectRoot: string): string {
  const candidates = [
    'src/index.ts',
    'src/index.js',
    'src/main.ts',
    'src/main.js',
    'index.ts',
    'index.js',
    'main.py',
    'app/main.py',
    'src/main.py',
    'src/__init__.py',
    'cmd/server/main.go',
    'cmd/main.go',
    'main.go',
    'src/main.rs',
    'src/lib.rs',
    'app/layout.tsx',
    'app/page.tsx',
  ];
  const found: string[] = [];
  for (const c of candidates) {
    if (existsSync(join(projectRoot, c))) {
      found.push(c);
    }
  }
  if (found.length === 0) return '';
  return found.map((f) => `- \`${f}\``).join('\n');
}

function generateServices(_projectRoot: string): string {
  // Reads ~/.coodra/pids/*.pid via pid-status.ts in a future refresh
  // pass. For S15, return a static informational note pointing operators
  // at `coodra status` for live data — populating this section
  // requires reaching outside projectRoot which complicates the pure
  // contract. Documented as a deferred enhancement.
  return '_Run `coodra status` for live service health (this section will populate from pid-status in a future refresh)._';
}

function readJsonIfExists(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readTextIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

void relative; // reserved for future relative-path display
