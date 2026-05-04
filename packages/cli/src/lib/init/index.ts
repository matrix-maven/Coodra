/**
 * `packages/cli/src/lib/init/index.ts` — library promotion of the
 * CLI's `init` command body for in-process consumption (M04 Phase 2
 * S3 / spec §10).
 *
 * The pre-existing `runInitCommand(options, io)` in
 * `packages/cli/src/commands/init.ts` is the CLI's path: it writes
 * progress + remediation strings to stdout/stderr and ultimately
 * calls `io.exit(EXIT_OK)` (or a non-zero exit code on failure).
 * That's the wrong contract for a Server Action call from the web
 * `/init` wizard — the web needs a structured outcome (success
 * boolean, slug, captured logs) rather than a process exit.
 *
 * `runInit(input)` here wraps `runInitCommand` with a captured IO
 * that:
 *   - buffers stdout / stderr into strings (ANSI-stripped so the web
 *     can render them in a `<pre>` without escape sequences leaking)
 *   - throws an `ExitSentinel` instead of calling `process.exit`,
 *     which we catch + translate into a structured result
 *
 * The CLI command's existing exit-code semantics map straight to the
 * result shape: EXIT_OK ⇒ `ok: true`, anything non-zero ⇒
 * `ok: false` with the captured stderr as the reason.
 *
 * No behaviour duplication — the CLI command remains the single
 * source of truth for what init does. The web wizard just gets a
 * non-process-exiting front door to it.
 */

import { type InitIO, type InitOptions, runInitCommand } from '../../commands/init.js';

class ExitSentinel extends Error {
  constructor(public readonly code: number) {
    super(`init exit ${code}`);
    this.name = 'ExitSentinel';
  }
}

export interface RunInitInput {
  readonly projectSlug?: string;
  readonly ide?: 'claude' | 'cursor' | 'windsurf' | 'all';
  readonly noGraphify?: boolean;
  readonly template?: string;
  readonly mode?: 'minimal' | 'default' | 'auto';
  readonly cwd?: string;
  readonly home?: string;
  readonly userHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

export interface RunInitSuccess {
  readonly ok: true;
  readonly projectSlug: string;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunInitFailure {
  readonly ok: false;
  /** Stable error code for the caller to branch on. */
  readonly error: 'no_project_root_marker' | 'slug_unsanitisable' | 'mcp_runtime_unavailable' | 'unknown_failure';
  /** Human-readable explanation derived from captured stderr. */
  readonly howToFix: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunInitResult = RunInitSuccess | RunInitFailure;

/**
 * Library entry — call this from a Server Action / test / programmatic
 * caller. Always resolves; errors are returned via the discriminated-
 * union result shape, never thrown.
 */
export async function runInit(input: RunInitInput): Promise<RunInitResult> {
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const captureIO: InitIO = {
    writeStdout: (chunk) => {
      stdoutBuf.push(chunk);
    },
    writeStderr: (chunk) => {
      stderrBuf.push(chunk);
    },
    // The CLI's runInitCommand declares `exit: (code) => never`, so we
    // throw a sentinel — the only legal way out of a `never` return.
    exit: (code) => {
      throw new ExitSentinel(code);
    },
  };

  const options: InitOptions = {
    ...(input.projectSlug !== undefined ? { projectSlug: input.projectSlug } : {}),
    ...(input.ide !== undefined ? { ide: input.ide } : {}),
    // CLI uses the inverted name `graphify` (boolean: true = run, false = skip).
    ...(input.noGraphify !== undefined ? { graphify: !input.noGraphify } : {}),
    ...(input.template !== undefined ? { template: input.template } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.home !== undefined ? { home: input.home } : {}),
    ...(input.userHome !== undefined ? { userHome: input.userHome } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.force !== undefined ? { force: input.force } : {}),
    ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
  };

  let exitCode = 0;
  try {
    await runInitCommand(options, captureIO);
    // runInitCommand always exits — control should never reach here.
    exitCode = 0;
  } catch (err) {
    if (err instanceof ExitSentinel) {
      exitCode = err.code;
    } else {
      // Unexpected throw (programming bug or library failure). Capture
      // it to stderr buffer so the web caller can surface something.
      stderrBuf.push((err as Error).message);
      exitCode = 1;
    }
  }

  const stdout = stripAnsi(stdoutBuf.join(''));
  const stderr = stripAnsi(stderrBuf.join(''));

  if (exitCode === 0) {
    // Success — derive the resolved slug from stdout. The CLI prints
    // a "registered project '<slug>'" line we can grep, OR we can
    // fall back to the input slug since the CLI's sanitiseSlug is
    // idempotent for already-valid slugs.
    const slugMatch = stdout.match(/registered project ['`"]([a-z0-9_-]+)['`"]/i);
    const projectSlug = slugMatch?.[1] ?? input.projectSlug ?? 'unknown';
    return { ok: true, projectSlug, stdout, stderr };
  }

  // Map the captured stderr to a stable error code + remediation.
  if (stderr.includes('no project root marker found')) {
    return {
      ok: false,
      error: 'no_project_root_marker',
      howToFix:
        'Run /init from inside a project directory that contains package.json, pyproject.toml, Cargo.toml, or .git.',
      exitCode,
      stdout,
      stderr,
    };
  }
  if (stderr.includes('could not derive a usable project slug')) {
    return {
      ok: false,
      error: 'slug_unsanitisable',
      howToFix:
        "The project root's basename has no usable characters after sanitisation. Pass an explicit project slug.",
      exitCode,
      stdout,
      stderr,
    };
  }
  if (stderr.includes('mcp-server') || stderr.includes('runtime')) {
    return {
      ok: false,
      error: 'mcp_runtime_unavailable',
      howToFix:
        'The bundled mcp-server runtime could not be resolved. Reinstall @coodra/contextos-cli or run `pnpm --filter @coodra/contextos-cli build`.',
      exitCode,
      stdout,
      stderr,
    };
  }
  return {
    ok: false,
    error: 'unknown_failure',
    howToFix: stderr.split('\n').slice(0, 3).join(' ').slice(0, 240),
    exitCode,
    stdout,
    stderr,
  };
}

/**
 * Strip ANSI escape sequences from picocolors output so the web can
 * render captured logs in a `<pre>` block without garbling.
 *
 * Match: ESC + `[` + any combination of digits / `;` + a final letter.
 * The CSI-end characters span 0x40-0x7e per ECMA-48, but for
 * picocolors output the relevant subset is `m` (SGR / colour),
 * `K` (erase line), `H` (cursor-home). We catch the lot.
 */
function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: required for ANSI escape-sequence detection
  return s.replace(/\[[0-9;]*[ -/]*[@-~]/g, '');
}
