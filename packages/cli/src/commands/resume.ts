import {
  KILL_SWITCH_SCOPES,
  type KillSwitchRecord,
  type KillSwitchScope,
  listActiveKillSwitches,
  lookupProjectBySlug,
  softResumeAllKillSwitches,
  softResumeKillSwitch,
} from '@coodra/db';
import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { resolveCoodraDataDb, resolveCoodraHome } from '../lib/coodra-home.js';
import { openLocalDb } from '../lib/open-local-db.js';
import { pc } from '../ui/index.js';

/**
 * `coodra resume` — soft-resume one or more active kill switches.
 *
 * Three mutually-exclusive modes:
 *
 *   --id <id>                  resume a single switch by id
 *   --all                      resume every currently-active switch
 *   --scope X [--target Y]     resume every active switch matching the filter
 *
 * Soft-resume only: the row stays in the table with `resumed_at` set
 * (audit history, parallels ADR-007). Re-resuming an already-resumed
 * row is a no-op; the CLI exits 1 with "no matching active switch"
 * if nothing was resumed.
 */

export interface ResumeOptions {
  readonly id?: string;
  readonly all?: boolean;
  readonly scope?: string;
  readonly target?: string;
  readonly json?: boolean;
}

export interface ResumeIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
  readonly coodraHome?: string;
}

export const DEFAULT_RESUME_IO: ResumeIO = {
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

interface ResumeJson {
  readonly ok: true;
  readonly resumed: ReadonlyArray<{
    readonly id: string;
    readonly scope: string;
    readonly target: string | null;
    readonly resumedAt: string;
  }>;
}

interface ResumeErrorJson {
  readonly ok: false;
  readonly error: string;
}

export async function runResumeCommand(options: ResumeOptions, ioOverride?: ResumeIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_RESUME_IO;
  const json = options.json === true;

  const modeCount =
    (options.id !== undefined ? 1 : 0) + (options.all === true ? 1 : 0) + (options.scope !== undefined ? 1 : 0);
  if (modeCount === 0) {
    return surfaceError(
      io,
      new CommandError(
        EXIT_USER_RECOVERABLE,
        'coodra resume requires one of --id <id>, --all, or --scope <scope> [--target <target>]',
      ),
      json,
    );
  }
  if (modeCount > 1) {
    return surfaceError(
      io,
      new CommandError(EXIT_USER_RECOVERABLE, '--id, --all, and --scope are mutually exclusive'),
      json,
    );
  }

  let scope: KillSwitchScope | undefined;
  if (options.scope !== undefined) {
    const value = options.scope.trim().toLowerCase();
    if (!KILL_SWITCH_SCOPES.includes(value as KillSwitchScope)) {
      return surfaceError(
        io,
        new CommandError(
          EXIT_USER_RECOVERABLE,
          `--scope must be one of ${KILL_SWITCH_SCOPES.join(', ')} (got "${options.scope}")`,
        ),
        json,
      );
    }
    scope = value as KillSwitchScope;
  }

  const homePath = io.coodraHome ?? resolveCoodraHome();
  const dbPath = resolveCoodraDataDb(homePath);
  const handle = await openLocalDb(dbPath);
  try {
    let resumed: KillSwitchRecord[] = [];

    if (options.id !== undefined) {
      const row = await softResumeKillSwitch(handle, { id: options.id });
      if (row === null) {
        return surfaceError(
          io,
          new CommandError(EXIT_USER_RECOVERABLE, `no active kill switch with id "${options.id}"`),
          json,
        );
      }
      resumed = [row];
    } else if (options.all === true) {
      resumed = await softResumeAllKillSwitches(handle);
      if (resumed.length === 0) {
        return surfaceError(io, new CommandError(EXIT_USER_RECOVERABLE, 'no active kill switches to resume'), json);
      }
    } else if (scope !== undefined) {
      // Resolve target if scope='project' (slug → projectId).
      let resolvedTarget: string | undefined;
      if (options.target !== undefined && options.target.length > 0) {
        if (scope === 'project') {
          const project = await lookupProjectBySlug(handle, options.target.trim());
          if (project === null) {
            return surfaceError(
              io,
              new CommandError(EXIT_USER_RECOVERABLE, `project slug "${options.target}" does not exist`),
              json,
            );
          }
          resolvedTarget = project.id;
        } else {
          resolvedTarget = options.target.trim();
        }
      }

      // For UX: if the user passed --scope but no --target, surface the active
      // switches matching the scope before bulk-resuming. Use a list-then-resume
      // path for clarity in the human output.
      const _preview = await listActiveKillSwitches(handle, scope === 'project' ? (resolvedTarget ?? null) : null);
      void _preview;

      resumed = await softResumeAllKillSwitches(handle, {
        scope,
        ...(resolvedTarget !== undefined ? { target: resolvedTarget } : {}),
      });
      if (resumed.length === 0) {
        return surfaceError(
          io,
          new CommandError(
            EXIT_USER_RECOVERABLE,
            resolvedTarget !== undefined
              ? `no active kill switches matching --scope ${scope} --target ${options.target}`
              : `no active kill switches matching --scope ${scope}`,
          ),
          json,
        );
      }
    }

    writeResumeOutput(io, json, resumed);
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

function surfaceError(io: ResumeIO, err: CommandError, json: boolean): void {
  if (json) {
    const payload: ResumeErrorJson = { ok: false, error: err.message };
    io.writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    io.writeStderr(`${pc.red('error')}: ${err.message}\n`);
  }
  io.exit(err.exitCode);
}

function writeResumeOutput(io: ResumeIO, json: boolean, resumed: KillSwitchRecord[]): void {
  if (json) {
    const payload: ResumeJson = {
      ok: true,
      resumed: resumed.map((r) => ({
        id: r.id,
        scope: r.scope,
        target: r.target,
        resumedAt: r.resumedAt?.toISOString() ?? new Date().toISOString(),
      })),
    };
    io.writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  io.writeStdout(`${pc.green('✓')} Resumed ${resumed.length} active switch${resumed.length === 1 ? '' : 'es'}.\n`);
  for (const r of resumed) {
    const scopeDescription = r.scope === 'global' ? 'global' : `${r.scope}=${r.target ?? '?'}`;
    io.writeStdout(`  • ${r.id} (${scopeDescription}, ${r.mode}-mode)\n`);
  }
}
