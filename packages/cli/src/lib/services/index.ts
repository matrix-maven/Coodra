/**
 * `packages/cli/src/lib/services/index.ts` — library promotion of the
 * `coodra start / stop / status` commands for in-process consumption
 * by the web app's /settings/workspace page (M04 Phase 2 S12).
 *
 * Same wrapping pattern as `lib/init/index.ts` and `lib/pack/index.ts`:
 * capture stdout/stderr, translate `process.exit` into a discriminated-
 * union result via an ExitSentinel error.
 *
 * Why solo-mode only (enforced by the caller, not here): these commands
 * spawn/kill daemons on the host machine. In team mode the web app is
 * deployed remotely and has no business managing the operator's local
 * processes — the page that calls these helpers gates on
 * `COODRA_MODE === 'solo'` and refuses to render otherwise.
 */

import { runStartCommand, type StartIO, type StartOptions } from '../../commands/start.js';
import { runStatusCommand, type StatusIO, type StatusOptions } from '../../commands/status.js';
import { runStopCommand, type StopIO, type StopOptions } from '../../commands/stop.js';

class ExitSentinel extends Error {
  constructor(public readonly code: number) {
    super(`services exit ${code}`);
    this.name = 'ExitSentinel';
  }
}

interface CapturedIo<T> {
  readonly io: T;
  readonly stdout: string[];
  readonly stderr: string[];
}

function makeCaptureStartIo(): CapturedIo<StartIO> {
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

function makeCaptureStopIo(): CapturedIo<StopIO> {
  return makeCaptureStartIo() as unknown as CapturedIo<StopIO>;
}

function makeCaptureStatusIo(): CapturedIo<StatusIO> {
  return makeCaptureStartIo() as unknown as CapturedIo<StatusIO>;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// ---------------------------------------------------------------------------
// runStart
// ---------------------------------------------------------------------------

export interface RunStartInput {
  readonly mcp?: boolean;
  readonly hooks?: boolean;
  readonly sync?: boolean;
  readonly waitTimeoutMs?: number;
}

export interface RunStartOk {
  readonly ok: true;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunStartErr {
  readonly ok: false;
  readonly error: 'startup_failed' | 'unknown_failure';
  readonly howToFix: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunStartResult = RunStartOk | RunStartErr;

export async function runStart(input: RunStartInput = {}): Promise<RunStartResult> {
  const cap = makeCaptureStartIo();
  const options: StartOptions = {
    foreground: false,
    ...(input.mcp !== undefined ? { mcp: input.mcp } : {}),
    ...(input.hooks !== undefined ? { hooks: input.hooks } : {}),
    ...(input.sync !== undefined ? { sync: input.sync } : {}),
    ...(input.waitTimeoutMs !== undefined ? { waitTimeoutMs: input.waitTimeoutMs } : {}),
  };
  let exitCode = 0;
  try {
    await runStartCommand(options, cap.io);
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
  if (exitCode === 0) return { ok: true, stdout, stderr };
  return {
    ok: false,
    error: exitCode === 70 ? 'startup_failed' : 'unknown_failure',
    howToFix:
      stderr.split('\n').slice(0, 3).join(' ').slice(0, 240) || 'Service start failed; check ~/.coodra/logs/.',
    exitCode,
    stdout,
    stderr,
  };
}

// ---------------------------------------------------------------------------
// runStop
// ---------------------------------------------------------------------------

export interface RunStopInput {
  /** Stop a single service by name. Omit to stop all. */
  readonly service?: 'mcp-server' | 'hooks-bridge' | 'sync-daemon';
}

export interface RunStopResult {
  readonly ok: true;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runStop(input: RunStopInput = {}): Promise<RunStopResult | RunStartErr> {
  const cap = makeCaptureStopIo();
  const options: StopOptions = {
    ...(input.service !== undefined ? { service: input.service } : {}),
  };
  let exitCode = 0;
  try {
    await runStopCommand(options, cap.io);
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
  if (exitCode === 0) return { ok: true, stdout, stderr };
  return {
    ok: false,
    error: 'unknown_failure',
    howToFix:
      stderr.split('\n').slice(0, 3).join(' ').slice(0, 240) || 'Service stop failed; check ~/.coodra/logs/.',
    exitCode,
    stdout,
    stderr,
  };
}

// ---------------------------------------------------------------------------
// runStatus
// ---------------------------------------------------------------------------

export interface RunStatusServiceRow {
  readonly name: string;
  readonly status: string;
  readonly pid?: number;
  readonly port?: number;
  readonly health?: string;
  readonly raw: string;
}

export interface RunStatusOk {
  readonly ok: true;
  readonly services: ReadonlyArray<RunStatusServiceRow>;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface RunStatusErr {
  readonly ok: false;
  readonly error: 'status_failed';
  readonly howToFix: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type RunStatusResult = RunStatusOk | RunStatusErr;

export async function runStatus(): Promise<RunStatusResult> {
  const cap = makeCaptureStatusIo();
  const options: StatusOptions = { json: true };
  let exitCode = 0;
  try {
    await runStatusCommand(options, cap.io);
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

  // status emits JSON to stdout when called with --json — exitCode 0
  // (all healthy) or 1 (some unhealthy) both carry a usable payload.
  // Only treat exit ≥ 2 as a hard failure.
  if (exitCode <= 1) {
    let services: RunStatusServiceRow[] = [];
    try {
      const parsed = JSON.parse(stdout) as { services?: ReadonlyArray<unknown> };
      if (Array.isArray(parsed.services)) {
        services = parsed.services.map((s) => projectStatusRow(s));
      }
    } catch {
      // JSON parse failed — fall through with empty services list.
    }
    return { ok: true, services, stdout, stderr, exitCode };
  }
  return {
    ok: false,
    error: 'status_failed',
    howToFix:
      stderr.split('\n').slice(0, 3).join(' ').slice(0, 240) || 'Status check failed; check ~/.coodra/logs/.',
    stdout,
    stderr,
    exitCode,
  };
}

function projectStatusRow(row: unknown): RunStatusServiceRow {
  if (typeof row !== 'object' || row === null) {
    return { name: '?', status: 'unknown', raw: JSON.stringify(row) };
  }
  const r = row as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name : '?';
  const status = typeof r.status === 'string' ? r.status : 'unknown';
  const pid = typeof r.pid === 'number' ? r.pid : undefined;
  const port = typeof r.port === 'number' ? r.port : undefined;
  const health = typeof r.health === 'string' ? r.health : undefined;
  return {
    name,
    status,
    ...(pid !== undefined ? { pid } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(health !== undefined ? { health } : {}),
    raw: JSON.stringify(row),
  };
}
