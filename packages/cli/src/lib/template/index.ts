/**
 * `packages/cli/src/lib/template/index.ts` — library promotion of the
 * `coodra template install` command for in-process consumption by
 * the M04 Phase 2 S13 web action.
 *
 * Same wrapping pattern as the other lib promotions: capture
 * stdout/stderr, translate `process.exit` into a discriminated-union
 * result. The CLI command body stays the single source of truth.
 *
 * Out of scope (matches the CLI's deferred items): git+https remote
 * sources, registry uploads. The web surface only accepts a local
 * absolute path today.
 */

import { runTemplateInstallCommand, type TemplateInstallOptions, type TemplateIO } from '../../commands/template.js';

class ExitSentinel extends Error {
  constructor(public readonly code: number) {
    super(`template-cmd exit ${code}`);
    this.name = 'ExitSentinel';
  }
}

interface CapturedIo {
  readonly io: TemplateIO;
  readonly stdout: string[];
  readonly stderr: string[];
}

function makeCaptureIo(): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      writeStdout: (c) => {
        stdout.push(c);
      },
      writeStderr: (c) => {
        stderr.push(c);
      },
      exit: (code) => {
        throw new ExitSentinel(code);
      },
    },
    stdout,
    stderr,
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape detection
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export interface RunTemplateInstallInput {
  /** Absolute path to a local template directory. */
  readonly source: string;
  /** Optional install-time name override (template.json#name is the default). */
  readonly name?: string;
  /** Overwrite an existing user template with the same name. */
  readonly force?: boolean;
}

export interface RunTemplateInstallOk {
  readonly ok: true;
  /** Installed name (post-override). */
  readonly installed: string;
  readonly source: string;
  readonly target: string;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunTemplateInstallErr {
  readonly ok: false;
  readonly error:
    | 'source_required'
    | 'source_missing'
    | 'source_not_directory'
    | 'template_invalid'
    | 'name_reserved'
    | 'already_exists'
    | 'unknown_failure';
  readonly howToFix: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunTemplateInstallResult = RunTemplateInstallOk | RunTemplateInstallErr;

export async function runTemplateInstall(input: RunTemplateInstallInput): Promise<RunTemplateInstallResult> {
  if (input.source.trim().length === 0) {
    return {
      ok: false,
      error: 'source_required',
      howToFix: 'Provide a non-empty absolute path to the template directory.',
      exitCode: 64,
      stdout: '',
      stderr: '',
    };
  }
  const cap = makeCaptureIo();
  const options: TemplateInstallOptions = {
    json: true,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.force !== undefined ? { force: input.force } : {}),
  };

  let exitCode = 0;
  try {
    await runTemplateInstallCommand(input.source.trim(), options, cap.io);
  } catch (err) {
    if (err instanceof ExitSentinel) {
      exitCode = err.code;
    } else {
      cap.stderr.push((err as Error).message);
      exitCode = 1;
    }
  }

  const stdout = stripAnsi(cap.stdout.join(''));
  const stderr = stripAnsi(cap.stderr.join(''));

  if (exitCode === 0) {
    let parsed: { installed?: string; source?: string; target?: string } = {};
    try {
      parsed = JSON.parse(stdout) as typeof parsed;
    } catch {
      // Fallback when --json output isn't well-formed (shouldn't
      // happen, but the fallback keeps the contract).
    }
    return {
      ok: true,
      installed: parsed.installed ?? input.name ?? '?',
      source: parsed.source ?? input.source.trim(),
      target: parsed.target ?? '?',
      stdout,
      stderr,
    };
  }

  // Map the CLI's free-form error message to a stable error code.
  const lower = stdout.toLowerCase();
  let code: RunTemplateInstallErr['error'] = 'unknown_failure';
  if (lower.includes('does not exist')) code = 'source_missing';
  else if (lower.includes('is not a directory')) code = 'source_not_directory';
  else if (lower.includes('reserved by a bundled template')) code = 'name_reserved';
  else if (lower.includes('already exists at')) code = 'already_exists';
  else if (lower.includes('template validation failed')) code = 'template_invalid';
  else if (lower.includes('missing required file')) code = 'template_invalid';
  return {
    ok: false,
    error: code,
    howToFix: extractMessage(stdout) || 'Template install failed; see stderr.',
    exitCode,
    stdout,
    stderr,
  };
}

function extractMessage(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as { error?: string };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // ignore
  }
  return stdout.split('\n')[0] ?? '';
}
