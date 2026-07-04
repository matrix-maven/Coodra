import { access, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { glob } from 'glob';
import { z } from 'zod';

/**
 * IDEs / agents we can wire `init` for. Order matters — preference for
 * output. `codex` added beta.95 (Scope A — Codex + Windsurf MCP-config
 * + instruction-file integration).
 */
export type IDE = 'claude' | 'cursor' | 'windsurf' | 'codex';

export type Language = 'typescript' | 'javascript' | 'python' | 'rust' | 'go' | 'java' | 'ruby';

export interface DetectionDeps {
  /** Override $HOME for test fixtures. */
  readonly homeDir?: string;
}

const PROJECT_ROOT_MARKERS = ['package.json', 'pyproject.toml', 'Cargo.toml', '.git'];

export interface DetectProjectRootResult {
  readonly root: string;
  readonly markers: string[];
  /**
   * Set when the walk-up hit a marker at `$HOME` (e.g. `~/.git` from
   * dotfiles), the home match was rejected, and `cwd` was used as the
   * project root instead. Callers (init) surface this to the user so the
   * "why isn't my project the project?" surprise has a clear explanation.
   */
  readonly skippedHomeMatch?: { homeDir: string; markers: readonly string[] };
}

/**
 * Walk up from `cwd` looking for a project root marker (`package.json`,
 * `pyproject.toml`, `Cargo.toml`, `.git`). Returns the deepest match —
 * useful when a tool is run from a subdirectory of the repo.
 *
 * **`$HOME` is never a valid project root.** Many users have `.git` in
 * their home directory (dotfiles repos) or `package.json` (npm globals);
 * treating home as a project root makes `coodra init` write
 * `CLAUDE.md`, `.mcp.json`, `docs/feature-packs/` etc. into the user's
 * home, with the project slug taken from the home dir's basename. We
 * skip any walk-up match that lands at exactly `$HOME`.
 *
 * Returns the original cwd as a fallback if no marker is found anywhere
 * up the tree (or only at `$HOME`), so callers always get a usable
 * path.
 */
export async function detectProjectRoot(
  cwd: string,
  options: { readonly homeDir?: string } = {},
): Promise<DetectProjectRootResult> {
  // Two views per path: `lexical` (what callers receive — preserves
  // pre-fix semantics) and `canonical` (realpath-normalized, used ONLY
  // for the $HOME equality check). This matters on macOS where /tmp
  // and /var lexically differ from /private/tmp and /private/var, and
  // anywhere else home is reached via a symlink or bind mount.
  const homeCanonical = await canonicalize(options.homeDir ?? homedir());
  let currentLex = resolve(cwd);
  const allMatches: { rootLex: string; rootCanonical: string; markers: string[] }[] = [];
  for (let depth = 0; depth < 12; depth++) {
    const found: string[] = [];
    for (const marker of PROJECT_ROOT_MARKERS) {
      try {
        await access(join(currentLex, marker));
        found.push(marker);
      } catch {
        // not present
      }
    }
    if (found.length > 0) {
      const rootCanonical = await canonicalize(currentLex);
      allMatches.push({ rootLex: currentLex, rootCanonical, markers: found });
    }
    const parent = dirname(currentLex);
    if (parent === currentLex) break;
    currentLex = parent;
  }
  // Drop any match whose CANONICAL path is $HOME — home is not a project.
  const filtered = allMatches.filter((m) => m.rootCanonical !== homeCanonical);
  const droppedHomeMatch = allMatches.find((m) => m.rootCanonical === homeCanonical);

  if (filtered.length === 0) {
    const fallback: DetectProjectRootResult = { root: resolve(cwd), markers: [] };
    if (droppedHomeMatch !== undefined) {
      return {
        ...fallback,
        skippedHomeMatch: { homeDir: droppedHomeMatch.rootLex, markers: droppedHomeMatch.markers },
      };
    }
    return fallback;
  }
  // The deepest match wins — that's the closest enclosing project root.
  // `allMatches` was appended in walk order (cwd first, ancestors next),
  // and `filtered` preserves that order — so `filtered[0]` is the closest.
  const winner = filtered[0] as (typeof filtered)[number];
  return { root: winner.rootLex, markers: winner.markers };
}

const LANGUAGE_PATTERNS: Array<{ language: Language; patterns: string[] }> = [
  { language: 'typescript', patterns: ['**/*.ts', '**/*.tsx'] },
  { language: 'javascript', patterns: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'] },
  { language: 'python', patterns: ['**/*.py'] },
  { language: 'rust', patterns: ['**/*.rs'] },
  { language: 'go', patterns: ['**/*.go'] },
  { language: 'java', patterns: ['**/*.java'] },
  { language: 'ruby', patterns: ['**/*.rb'] },
];

const LANGUAGE_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/target/**',
];

/**
 * Returns languages present in the project root, deduped + ordered by total
 * file count (descending). Hidden directories and conventional build/install
 * outputs are excluded so the result reflects user-authored code.
 */
export async function detectLanguages(root: string): Promise<Language[]> {
  const counts: Map<Language, number> = new Map();
  for (const { language, patterns } of LANGUAGE_PATTERNS) {
    let count = 0;
    for (const pattern of patterns) {
      const matches = await glob(pattern, { cwd: root, ignore: LANGUAGE_IGNORE, nodir: true, dot: false });
      count += matches.length;
    }
    if (count > 0) counts.set(language, count);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([lang]) => lang);
}

/**
 * Canonical IDE order. Used by `detectIDE` to keep the detected list
 * stable and by `resolveIdeSelection` to return its result in the same
 * order regardless of how the user typed the flag.
 */
export const IDE_ORDER: readonly IDE[] = ['claude', 'cursor', 'windsurf', 'codex'] as const;

/** Human-readable agent names, keyed by the IDE id. One map for every command surface. */
export const IDE_DISPLAY: Readonly<Record<IDE, string>> = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  codex: 'Codex',
};

/**
 * Resolve the final list of IDEs to wire from the `--ide` flag and the
 * `detectIDE` result.
 *
 * Semantics:
 *   - flag undefined         → autodetect (use `detected` as-is)
 *   - `--ide all`            → wire every known IDE regardless of detection
 *   - `--ide <name>`         → wire just that IDE, regardless of detection
 *   - `--ide <a>,<b>,<c>`    → wire that exact list, regardless of detection
 *   - unknown name in list   → return `{ ok: false, error }` — the caller
 *                              prints the message and exits non-zero
 *
 * "Regardless of detection" is the explicit-override semantics. The user
 * is telling Coodra to wire that IDE — perhaps they're setting up
 * before installing the IDE. The flag should not silently no-op.
 */
export interface ResolveIdeSelectionInput {
  readonly flag: string | undefined;
  readonly detected: readonly IDE[];
}

export type ResolveIdeSelectionResult =
  | { readonly ok: true; readonly ides: readonly IDE[] }
  | { readonly ok: false; readonly error: string };

export function resolveIdeSelection(input: ResolveIdeSelectionInput): ResolveIdeSelectionResult {
  if (input.flag === undefined) {
    return { ok: true, ides: [...input.detected] };
  }
  const tokens = input.flag
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return {
      ok: false,
      error: '--ide value is empty. Pass one of: claude, cursor, windsurf, codex, all (comma-separated for multiple).',
    };
  }
  if (tokens.includes('all')) {
    if (tokens.length > 1) {
      return { ok: false, error: '--ide all is exclusive — drop the other names or pick a specific list.' };
    }
    return { ok: true, ides: [...IDE_ORDER] };
  }
  const allowed = new Set<string>(IDE_ORDER);
  const seen = new Set<IDE>();
  for (const token of tokens) {
    if (!allowed.has(token)) {
      return {
        ok: false,
        error: `--ide: unknown agent '${token}'. Valid: claude, cursor, windsurf, codex, all.`,
      };
    }
    seen.add(token as IDE);
  }
  return { ok: true, ides: IDE_ORDER.filter((ide) => seen.has(ide)) };
}

/**
 * Look for IDE config dirs in $HOME. Each detected IDE gets one entry; the
 * order matches the candidate list (Claude, Cursor, Windsurf, Codex). An
 * empty array means no supported IDE is installed — `init` warns the user.
 *
 * Detection dirs:
 *   - claude   → ~/.claude
 *   - cursor   → ~/.cursor
 *   - windsurf → ~/.windsurf
 *   - codex    → ~/.codex   (Codex CLI's config home; beta.95)
 */
export async function detectIDE(deps: DetectionDeps = {}): Promise<IDE[]> {
  const home = deps.homeDir ?? homedir();
  const candidates: Array<{ ide: IDE; dir: string }> = [
    { ide: 'claude', dir: '.claude' },
    { ide: 'cursor', dir: '.cursor' },
    { ide: 'windsurf', dir: '.windsurf' },
    { ide: 'codex', dir: '.codex' },
  ];
  const found: IDE[] = [];
  for (const { ide, dir } of candidates) {
    try {
      await access(join(home, dir));
      found.push(ide);
    } catch {
      // not installed
    }
  }
  return found;
}

const mcpEntrySchema = z
  .object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const mcpConfigSchema = z
  .object({
    mcpServers: z.record(z.string(), mcpEntrySchema).optional(),
  })
  .passthrough();

export type MCPConfig = z.infer<typeof mcpConfigSchema>;

/**
 * Returns the parsed `.mcp.json` if the file exists and is valid; null when
 * the file is absent. Throws when the file exists but cannot be parsed —
 * `init` should treat that as an error condition the user must resolve.
 */
export async function detectExistingMCPConfig(root: string): Promise<MCPConfig | null> {
  const path = join(root, '.mcp.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
  return mcpConfigSchema.parse(JSON.parse(raw));
}

/**
 * Best-effort `realpath` — resolves symlinks so `/tmp/foo` and
 * `/private/tmp/foo` (macOS) or `/home/x` and a bind-mount alias
 * compare equal. Falls back to the lexical `resolve` result when the
 * path doesn't exist on disk (the walk-up climbs through parents that
 * sometimes don't exist, and `realpath` would otherwise throw).
 */
async function canonicalize(path: string): Promise<string> {
  const lex = resolve(path);
  try {
    return await realpath(lex);
  } catch {
    return lex;
  }
}
