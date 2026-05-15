/**
 * `packages/cli/src/lib/pack/index.ts` — library promotion of the
 * `coodra pack regenerate` and `coodra pack delete` commands
 * for in-process consumption (M04 Phase 2 S5 / spec §10).
 *
 * Same wrapping pattern as `lib/init/index.ts`: capture stdout/stderr,
 * translate `process.exit` into a discriminated-union result. The
 * underlying CLI command bodies stay the single source of truth — the
 * web Server Actions just consume them via this non-exiting front
 * door.
 *
 * OQ-7 lock (2026-05-04, S5 re-confirmed default): match real CLI
 * behaviour. `runPackDelete` removes the on-disk directory AND flips
 * `feature_packs.is_active=false` (preserves the row per ADR-007).
 * `runPackRegenerate` overwrites auto-managed sections in spec.md /
 * implementation.md / techstack.md while preserving user-edited
 * unmanaged sections — same semantics as the CLI.
 */

import {
  type PackDeleteOptions,
  type PackIO,
  type PackRegenerateOptions,
  runPackDeleteCommand,
  runPackRegenerateCommand,
} from '../../commands/pack.js';

class ExitSentinel extends Error {
  constructor(public readonly code: number) {
    super(`pack-cmd exit ${code}`);
    this.name = 'ExitSentinel';
  }
}

interface CapturedIo {
  readonly io: PackIO;
  readonly stdout: string[];
  readonly stderr: string[];
}

function makeCaptureIo(): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: PackIO = {
    writeStdout: (chunk) => {
      stdout.push(chunk);
    },
    writeStderr: (chunk) => {
      stderr.push(chunk);
    },
    exit: (code) => {
      throw new ExitSentinel(code);
    },
  };
  return { io, stdout, stderr };
}

// ---------------------------------------------------------------------------
// runPackRegenerate
// ---------------------------------------------------------------------------

export interface RunPackRegenerateInput {
  readonly slug: string;
  readonly cwd?: string;
  readonly mode?: 'minimal' | 'default' | 'auto';
  readonly force?: boolean;
}

export interface RunPackRegenerateOk {
  readonly ok: true;
  readonly slug: string;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunPackRegenerateErr {
  readonly ok: false;
  readonly error: 'slug_required' | 'pack_not_found' | 'unknown_failure';
  readonly howToFix: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunPackRegenerateResult = RunPackRegenerateOk | RunPackRegenerateErr;

export async function runPackRegenerate(input: RunPackRegenerateInput): Promise<RunPackRegenerateResult> {
  if (input.slug.trim().length === 0) {
    return {
      ok: false,
      error: 'slug_required',
      howToFix: 'Provide a non-empty pack slug.',
      exitCode: 64,
      stdout: '',
      stderr: '',
    };
  }
  const cap = makeCaptureIo();
  const options: PackRegenerateOptions = {
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.force !== undefined ? { force: input.force } : {}),
  };

  let exitCode = 0;
  try {
    await runPackRegenerateCommand(input.slug, options, cap.io);
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
    return { ok: true, slug: input.slug, stdout, stderr };
  }
  if (stderr.includes('no pack at') || stderr.includes('pack not found')) {
    return {
      ok: false,
      error: 'pack_not_found',
      howToFix: `No pack at docs/feature-packs/${input.slug}/. Verify the slug or scaffold one with \`coodra pack new ${input.slug}\`.`,
      exitCode,
      stdout,
      stderr,
    };
  }
  return {
    ok: false,
    error: 'unknown_failure',
    howToFix:
      stderr.split('\n').slice(0, 3).join(' ').slice(0, 240) || 'Pack regenerate failed; check ~/.coodra/logs/.',
    exitCode,
    stdout,
    stderr,
  };
}

// ---------------------------------------------------------------------------
// runPackDelete
// ---------------------------------------------------------------------------

export interface RunPackDeleteInput {
  readonly slug: string;
  readonly cwd?: string;
}

export interface RunPackDeleteOk {
  readonly ok: true;
  readonly slug: string;
  readonly dirRemoved: boolean;
  readonly dbRowDeactivated: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunPackDeleteErr {
  readonly ok: false;
  readonly error: 'slug_required' | 'pack_not_found' | 'unknown_failure';
  readonly howToFix: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunPackDeleteResult = RunPackDeleteOk | RunPackDeleteErr;

export async function runPackDelete(input: RunPackDeleteInput): Promise<RunPackDeleteResult> {
  if (input.slug.trim().length === 0) {
    return {
      ok: false,
      error: 'slug_required',
      howToFix: 'Provide a non-empty pack slug.',
      exitCode: 64,
      stdout: '',
      stderr: '',
    };
  }
  const cap = makeCaptureIo();
  // Always pass `force: true` — the web's typed-confirm dialog IS the
  // confirmation gate; the CLI's --force flag exists to defend against
  // a typo at the prompt, which doesn't apply here.
  const options: PackDeleteOptions = {
    force: true,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  };

  let exitCode = 0;
  try {
    await runPackDeleteCommand(input.slug, options, cap.io);
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
    return {
      ok: true,
      slug: input.slug,
      dirRemoved: stdout.includes('Deleted'),
      dbRowDeactivated: stdout.includes('flipped to false'),
      stdout,
      stderr,
    };
  }
  if (stderr.includes('no pack at')) {
    return {
      ok: false,
      error: 'pack_not_found',
      howToFix: `No pack at docs/feature-packs/${input.slug}/.`,
      exitCode,
      stdout,
      stderr,
    };
  }
  return {
    ok: false,
    error: 'unknown_failure',
    howToFix: stderr.split('\n').slice(0, 3).join(' ').slice(0, 240) || 'Pack delete failed; check ~/.coodra/logs/.',
    exitCode,
    stdout,
    stderr,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Same pattern as lib/init/index.ts — strip ANSI escape sequences so
// captured logs render cleanly in the web UI's <pre> blocks.
// biome-ignore lint/suspicious/noControlCharactersInRegex: required for ANSI escape-sequence detection
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}
