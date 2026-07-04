import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_GRAPHIFY_PYTHON } from './graphify-wire.js';

const pexec = promisify(execFile);

/**
 * `graphify-python.ts` — auto-detect a Python interpreter that can
 * actually serve Graphify's MCP, and verify it BEFORE the wiring writes
 * the entry.
 *
 * Why this exists: `coodra graphify enable` / `coodra init --graphify`
 * historically defaulted the interpreter to bare `python3`. On most
 * machines the system `python3` cannot `import graphify.serve, mcp`
 * (Graphify is installed in a uv tool or a venv, often without the
 * `[mcp]` extra), so the wired server crashed on spawn with
 * `ModuleNotFoundError: No module named 'graphify'` — surfaced by the
 * agent as a "failed" MCP server. Every freshly-wired project hit this.
 *
 * The fix: probe an ordered list of plausible interpreters (active
 * venv → project `.venv` → the interpreter behind the `graphify`
 * binary's shebang → the uv-tool install → `python3`/`python`), run
 * `<py> -c "import graphify.serve, mcp"` against each, and wire the
 * first that succeeds. If none verify, fall back to `python3` and flag
 * `verified: false` so the caller prints the install instructions
 * instead of silently writing a broken entry.
 *
 * Everything is injectable (`verify`, `candidates`, `runUvToolDir`) so
 * the resolver is unit-testable without spawning real processes.
 */

/** The exact probe Graphify's MCP server needs to satisfy at spawn time. */
export const GRAPHIFY_IMPORT_PROBE = 'import graphify.serve, mcp';

/** Platform-aware path of the python binary inside a venv dir. */
export function venvPythonPath(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python');
}

export type VerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'spawn_failed' | 'import_failed'; readonly detail: string };

/**
 * Run `<pythonPath> -c "import graphify.serve, mcp"`. Resolves `ok` when
 * the interpreter exists AND both modules import (exit 0). Distinguishes
 * a missing interpreter (`spawn_failed`) from an interpreter that runs
 * but can't import (`import_failed`) so callers can give the right hint.
 */
export async function verifyGraphifyPython(
  pythonPath: string,
  opts: { readonly timeoutMs?: number } = {},
): Promise<VerifyResult> {
  try {
    await pexec(pythonPath, ['-c', GRAPHIFY_IMPORT_PROBE], { timeout: opts.timeoutMs ?? 10_000 });
    return { ok: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string | Buffer };
    if (e.code === 'ENOENT') {
      return { ok: false, reason: 'spawn_failed', detail: `interpreter not found: ${pythonPath}` };
    }
    const stderrRaw = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? '');
    const lastLine =
      stderrRaw
        .trim()
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .pop() ?? e.message;
    return { ok: false, reason: 'import_failed', detail: lastLine.slice(0, 300) };
  }
}

export interface PythonCandidate {
  readonly path: string;
  /** Where the candidate came from — surfaced in CLI output for transparency. */
  readonly source: 'virtualenv' | 'venv' | 'graphify-shebang' | 'uv-tool' | 'python3' | 'python';
}

/** Read the first shebang line of a (possibly large/binary) file, bounded to 256 bytes. */
function readShebang(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(256);
    const bytes = readSync(fd, buf, 0, 256, 0);
    const head = buf.subarray(0, bytes).toString('utf8');
    const firstLine = head.split('\n', 1)[0] ?? '';
    const m = firstLine.match(/^#!\s*(\S+)/);
    if (m?.[1] !== undefined && m[1] !== '/bin/sh' && m[1] !== '/usr/bin/env') return m[1];
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Resolve the interpreter behind the `graphify` binary on `PATH`. For a
 * uv-tool / pip install this is a small launcher script whose shebang
 * points straight at the Python that owns the `graphify` package — the
 * single most reliable candidate. Falls back to a sibling `python` in
 * the same bin dir when the shebang is unreadable (compiled launcher).
 */
function graphifyShebangPython(env: NodeJS.ProcessEnv): string | null {
  const pathDirs = (env.PATH ?? '').split(':').filter((d) => d.length > 0);
  for (const dir of pathDirs) {
    const bin = join(dir, 'graphify');
    if (!existsSync(bin)) continue;
    const shebang = readShebang(bin);
    if (shebang !== null && existsSync(shebang)) return shebang;
    const sibling = join(dir, 'python');
    if (existsSync(sibling)) return sibling;
  }
  return null;
}

/** Resolve uv's tool base dir (`uv tool dir`), with a well-known fallback. */
async function uvToolPythons(env: NodeJS.ProcessEnv, runUvToolDir?: () => Promise<string | null>): Promise<string[]> {
  let base: string | null = null;
  if (runUvToolDir !== undefined) {
    base = await runUvToolDir();
  } else {
    try {
      const r = await pexec('uv', ['tool', 'dir'], { timeout: 5_000 });
      base = r.stdout.trim();
    } catch {
      base = null;
    }
  }
  const home = env.HOME ?? homedir();
  const bases = [base, join(home, '.local', 'share', 'uv', 'tools')].filter(
    (b): b is string => b !== null && b.length > 0,
  );
  const out: string[] = [];
  for (const b of bases) {
    out.push(join(b, 'graphifyy', 'bin', 'python'));
    out.push(join(b, 'graphifyy', 'bin', 'python3'));
  }
  return out;
}

/**
 * Build the ordered candidate list. Verification gates every entry, so
 * order only decides ties (multiple interpreters that all import
 * Graphify) — most-specific-to-the-user first.
 */
export async function graphifyPythonCandidates(opts: {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly runUvToolDir?: () => Promise<string | null>;
}): Promise<PythonCandidate[]> {
  const { cwd, env } = opts;
  const list: PythonCandidate[] = [];

  if (env.VIRTUAL_ENV !== undefined && env.VIRTUAL_ENV.length > 0) {
    list.push({ path: venvPythonPath(env.VIRTUAL_ENV), source: 'virtualenv' });
  }
  list.push({ path: venvPythonPath(join(cwd, '.venv')), source: 'venv' });

  const shebang = graphifyShebangPython(env);
  if (shebang !== null) list.push({ path: shebang, source: 'graphify-shebang' });

  for (const p of await uvToolPythons(env, opts.runUvToolDir)) list.push({ path: p, source: 'uv-tool' });

  list.push({ path: DEFAULT_GRAPHIFY_PYTHON, source: 'python3' });
  list.push({ path: 'python', source: 'python' });

  // Dedup by path, preserving first-seen order.
  const seen = new Set<string>();
  return list.filter((c) => {
    if (seen.has(c.path)) return false;
    seen.add(c.path);
    return true;
  });
}

export interface GraphifyPythonResolution {
  /** The interpreter to wire into the `graphify` MCP entry. */
  readonly python: string;
  /** True when `<python> -c "import graphify.serve, mcp"` succeeded. */
  readonly verified: boolean;
  /** Provenance of the choice — flag / detected source / fallback. */
  readonly source: 'flag' | PythonCandidate['source'] | 'fallback';
  /** When unverified, the last import/spawn failure detail (for the hint). */
  readonly detail?: string;
}

export interface ResolveGraphifyPythonOptions {
  /** `--python` from the user. When set, it's honoured verbatim (verified only for messaging). */
  readonly explicit?: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Injectable verifier (tests). Defaults to the real subprocess probe. */
  readonly verify?: (pythonPath: string) => Promise<VerifyResult>;
  /** Injectable candidate list (tests). Defaults to {@link graphifyPythonCandidates}. */
  readonly candidates?: readonly PythonCandidate[];
  /** Injectable `uv tool dir` resolver (tests). */
  readonly runUvToolDir?: () => Promise<string | null>;
}

/**
 * Resolve the interpreter to wire.
 *
 * - An explicit `--python` is honoured verbatim — we verify it only to
 *   set `verified` for the caller's messaging, never to override the
 *   user's choice (pre-install wiring is legitimate).
 * - Otherwise probe candidates and return the first that verifies.
 * - If none verify, fall back to `python3` with `verified: false` so the
 *   caller writes the entry but prints the install instructions.
 */
export async function resolveGraphifyPython(opts: ResolveGraphifyPythonOptions): Promise<GraphifyPythonResolution> {
  const verify = opts.verify ?? ((p: string) => verifyGraphifyPython(p));

  if (opts.explicit !== undefined && opts.explicit.trim().length > 0) {
    const explicit = opts.explicit.trim();
    const v = await verify(explicit);
    return v.ok
      ? { python: explicit, verified: true, source: 'flag' }
      : { python: explicit, verified: false, source: 'flag', detail: v.detail };
  }

  const candidates =
    opts.candidates ??
    (await graphifyPythonCandidates({
      cwd: opts.cwd,
      env: opts.env,
      ...(opts.runUvToolDir !== undefined ? { runUvToolDir: opts.runUvToolDir } : {}),
    }));

  let lastDetail: string | undefined;
  for (const c of candidates) {
    const v = await verify(c.path);
    if (v.ok) return { python: c.path, verified: true, source: c.source };
    lastDetail = v.detail;
  }

  return {
    python: DEFAULT_GRAPHIFY_PYTHON,
    verified: false,
    source: 'fallback',
    ...(lastDetail !== undefined ? { detail: lastDetail } : {}),
  };
}

/** Resolver signature — exported so commands can accept an injectable override. */
export type GraphifyPythonResolver = (opts: ResolveGraphifyPythonOptions) => Promise<GraphifyPythonResolution>;
