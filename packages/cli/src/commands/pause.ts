import {
  insertKillSwitch,
  KILL_SWITCH_MODES,
  KILL_SWITCH_SCOPES,
  type KillSwitchMode,
  type KillSwitchRecord,
  type KillSwitchScope,
  listActiveKillSwitches,
  lookupProjectBySlug,
} from '@coodra/contextos-db';
import pc from 'picocolors';

import { EXIT_KILL_SWITCH_REFUSAL, EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { resolveContextosDataDb, resolveContextosHome } from '../lib/contextos-home.js';
import { DurationParseError, parseDuration } from '../lib/duration.js';
import { openLocalDb } from '../lib/open-local-db.js';

/**
 * `contextos pause` — insert a row into `kill_switches` so the bridge's
 * pre-tool-use evaluator (M08b S2) short-circuits matching events.
 *
 * Per OQ-1 lock (2026-05-03) the default mode is `hard` (deny on match).
 * Per OQ-2 lock the schema is polymorphic `(scope, target)`. Per OQ-8
 * the row is local-only — never enqueued for cloud sync.
 *
 * Idempotency posture: each `pause` call inserts a fresh row even when
 * an active row already exists at the same `(scope, target)`. The CLI
 * detects the duplicate-active case BEFORE inserting and exits with
 * `EXIT_KILL_SWITCH_REFUSAL` (5) — the existing row's id is printed so
 * shell scripts can branch on "no-op" vs "newly-paused" without parsing
 * stdout.
 *
 * Examples:
 *
 *   contextos pause                                 # global hard pause, no expiry
 *   contextos pause --mode soft --reason "demo"     # observability-only
 *   contextos pause --scope tool --target Bash --reason "no shell"
 *   contextos pause --scope project --target my-app --expires-in 1h
 */

export interface PauseOptions {
  readonly scope?: string;
  readonly target?: string;
  readonly mode?: string;
  readonly reason?: string;
  readonly expiresIn?: string;
  readonly json?: boolean;
}

export interface PauseIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
  /** Override the contextos home for tests. */
  readonly contextosHome?: string;
}

export const DEFAULT_PAUSE_IO: PauseIO = {
  writeStdout: (chunk) => {
    process.stdout.write(chunk);
  },
  writeStderr: (chunk) => {
    process.stderr.write(chunk);
  },
  exit: (code) => {
    process.exit(code);
  },
};

interface PauseSuccessJson {
  readonly ok: true;
  readonly status: 'paused';
  readonly id: string;
  readonly scope: KillSwitchScope;
  readonly target: string | null;
  readonly mode: KillSwitchMode;
  readonly reason: string;
  readonly pausedAt: string;
  readonly expiresAt: string | null;
}

interface PauseAlreadyPausedJson {
  readonly ok: true;
  readonly status: 'already_paused';
  readonly existingId: string;
  readonly scope: KillSwitchScope;
  readonly target: string | null;
}

interface PauseErrorJson {
  readonly ok: false;
  readonly error: string;
}

export async function runPauseCommand(options: PauseOptions, ioOverride?: PauseIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_PAUSE_IO;
  const json = options.json === true;

  const scope = parseScope(options.scope);
  if (scope instanceof CommandError) {
    return surfaceError(io, scope, json);
  }

  const mode = parseMode(options.mode);
  if (mode instanceof CommandError) {
    return surfaceError(io, mode, json);
  }

  const reason = (options.reason ?? '').trim() || defaultReasonForScope(scope);
  if (reason.length === 0) {
    return surfaceError(io, new CommandError(EXIT_USER_RECOVERABLE, '--reason cannot be empty'), json);
  }

  let expiresAt: Date | null = null;
  if (options.expiresIn !== undefined && options.expiresIn.length > 0) {
    try {
      const parsed = parseDuration(options.expiresIn);
      expiresAt = new Date(Date.now() + parsed.ms);
    } catch (err) {
      const message =
        err instanceof DurationParseError
          ? err.message
          : `--expires-in parse failed: ${err instanceof Error ? err.message : String(err)}`;
      return surfaceError(io, new CommandError(EXIT_USER_RECOVERABLE, message), json);
    }
  }

  const homePath = io.contextosHome ?? resolveContextosHome();
  const dbPath = resolveContextosDataDb(homePath);
  const handle = await openLocalDb(dbPath);
  try {
    // Resolve target. For scope='global' the target stays null. For
    // scope='project' translate the slug to the canonical projectId.
    // For tool/agent_type the target is passed verbatim — these are
    // string identifiers that don't need DB resolution.
    let target: string | null;
    if (scope === 'global') {
      if (options.target !== undefined && options.target.length > 0) {
        return surfaceError(
          io,
          new CommandError(
            EXIT_USER_RECOVERABLE,
            `--target is not allowed when --scope=global (got "${options.target}")`,
          ),
          json,
        );
      }
      target = null;
    } else {
      if (options.target === undefined || options.target.trim().length === 0) {
        return surfaceError(
          io,
          new CommandError(EXIT_USER_RECOVERABLE, `--scope=${scope} requires --target <value>`),
          json,
        );
      }
      if (scope === 'project') {
        const project = await lookupProjectBySlug(handle, options.target.trim());
        if (project === null) {
          return surfaceError(
            io,
            new CommandError(
              EXIT_USER_RECOVERABLE,
              `project slug "${options.target}" does not exist in this contextos store. Run \`contextos init --project-slug <slug>\` in the project root first.`,
            ),
            json,
          );
        }
        target = project.id;
      } else {
        target = options.target.trim();
      }
    }

    // Idempotency check: if an active switch already matches (scope, target),
    // refuse with exit 5 and print the existing id. Active = resumed_at IS NULL
    // AND (expires_at IS NULL OR expires_at > now()).
    const active = await listActiveKillSwitches(handle, scope === 'project' ? target : null);
    const duplicate = active.find(
      (s) => s.scope === scope && (target === null ? s.target === null : s.target === target),
    );
    if (duplicate !== undefined) {
      writePauseAlreadyPaused(io, json, duplicate);
      io.exit(EXIT_KILL_SWITCH_REFUSAL);
      return;
    }

    const inserted = await insertKillSwitch(handle, {
      scope,
      target,
      mode,
      reason,
      expiresAt,
    });
    writePauseSuccess(io, json, inserted);
    io.exit(EXIT_OK);
  } finally {
    handle.close();
  }
}

class CommandError extends Error {
  readonly exitCode: number;
  constructor(exitCode: number, message: string) {
    super(message);
    this.name = 'CommandError';
    this.exitCode = exitCode;
  }
}

function parseScope(raw: string | undefined): KillSwitchScope | CommandError {
  const value = (raw ?? 'global').trim().toLowerCase();
  if (!KILL_SWITCH_SCOPES.includes(value as KillSwitchScope)) {
    return new CommandError(
      EXIT_USER_RECOVERABLE,
      `--scope must be one of ${KILL_SWITCH_SCOPES.join(', ')} (got "${raw}")`,
    );
  }
  return value as KillSwitchScope;
}

function parseMode(raw: string | undefined): KillSwitchMode | CommandError {
  const value = (raw ?? 'hard').trim().toLowerCase();
  if (!KILL_SWITCH_MODES.includes(value as KillSwitchMode)) {
    return new CommandError(
      EXIT_USER_RECOVERABLE,
      `--mode must be one of ${KILL_SWITCH_MODES.join(', ')} (got "${raw}")`,
    );
  }
  return value as KillSwitchMode;
}

function defaultReasonForScope(scope: KillSwitchScope): string {
  switch (scope) {
    case 'global':
      return 'CLI-initiated global pause (no --reason supplied)';
    case 'project':
      return 'CLI-initiated project pause (no --reason supplied)';
    case 'tool':
      return 'CLI-initiated tool pause (no --reason supplied)';
    case 'agent_type':
      return 'CLI-initiated agent pause (no --reason supplied)';
  }
}

function surfaceError(io: PauseIO, err: CommandError, json: boolean): void {
  if (json) {
    const payload: PauseErrorJson = { ok: false, error: err.message };
    io.writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    io.writeStderr(`${pc.red('error')}: ${err.message}\n`);
  }
  io.exit(err.exitCode);
}

function writePauseSuccess(io: PauseIO, json: boolean, row: KillSwitchRecord): void {
  if (json) {
    const payload: PauseSuccessJson = {
      ok: true,
      status: 'paused',
      id: row.id,
      scope: row.scope,
      target: row.target,
      mode: row.mode,
      reason: row.reason,
      pausedAt: row.pausedAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
    };
    io.writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const scopeDescription = row.scope === 'global' ? 'global' : `${row.scope}=${row.target ?? '?'}`;
  const expiresDescription = row.expiresAt === null ? 'until manually resumed' : `until ${row.expiresAt.toISOString()}`;
  io.writeStdout(
    `${pc.green('✓')} Paused ${scopeDescription} (${row.mode}-mode, ${expiresDescription}; id: ${row.id}).\n`,
  );
  io.writeStdout(`  Resume: ${pc.cyan(`contextos resume --id ${row.id}`)}\n`);
}

function writePauseAlreadyPaused(io: PauseIO, json: boolean, existing: KillSwitchRecord): void {
  if (json) {
    const payload: PauseAlreadyPausedJson = {
      ok: true,
      status: 'already_paused',
      existingId: existing.id,
      scope: existing.scope,
      target: existing.target,
    };
    io.writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const scopeDescription = existing.scope === 'global' ? 'global' : `${existing.scope}=${existing.target ?? '?'}`;
  io.writeStderr(
    `${pc.yellow('!')} Already paused (${scopeDescription}, ${existing.mode}-mode, id: ${existing.id}). No new switch inserted.\n`,
  );
  io.writeStderr(`  Resume: ${pc.cyan(`contextos resume --id ${existing.id}`)}\n`);
}
