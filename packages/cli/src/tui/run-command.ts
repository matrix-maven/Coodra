/**
 * `src/tui/run-command.ts` — the in-process command runner that backs
 * the TUI's Terminal and Status views.
 *
 * Rather than spawning a subprocess, this builds a fresh `commander`
 * program with every command's IO swapped for a capturing buffer, so a
 * command's human output (and `--json`) is collected into a string
 * instead of hitting the real stdout. `io.exit(code)` is rerouted to
 * throw a {@link TuiExitSignal} the runner catches — the TUI process
 * itself never exits.
 *
 * Only the catalog's `runnable` commands are ever passed here (read-only,
 * argument-free). The runner does not enforce that — the Terminal view
 * gates it — but it is the reason this is safe: nothing here mutates
 * state behind a keypress.
 */

import { type Command, CommanderError } from 'commander';
import { buildProgram } from '../program.js';

/** Thrown by the capturing `io.exit` so the runner records the code without exiting the process. */
export class TuiExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`coodra exited ${code}`);
    this.name = 'TuiExitSignal';
  }
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** True when the command threw something other than a clean `io.exit` / commander exit. */
  readonly crashed: boolean;
}

/** Recursively reroute commander's own exit + output (help / version / parse errors) into our buffers. */
function applyCommanderOverrides(cmd: Command, writeOut: (s: string) => void, writeErr: (s: string) => void): void {
  cmd.exitOverride();
  cmd.configureOutput({ writeOut, writeErr });
  for (const sub of cmd.commands) {
    applyCommanderOverrides(sub, writeOut, writeErr);
  }
}

/**
 * Run `coodra <argv…>` in-process and capture its output. Never
 * throws for a command-level failure — a non-zero `exitCode` (or
 * `crashed: true`) is reported in the result instead.
 */
export async function runCommandInProcess(argv: readonly string[]): Promise<CommandResult> {
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  let crashed = false;

  const captureIo = {
    writeStdout: (chunk: string): void => {
      stdout += chunk;
    },
    writeStderr: (chunk: string): void => {
      stderr += chunk;
    },
    exit: (code: number): never => {
      throw new TuiExitSignal(code);
    },
  };

  // Every command's IO is the same `{ writeStdout, writeStderr, exit }`
  // shape, so one capturing object satisfies all of them.
  const program = buildProgram({
    writeStderr: (chunk) => {
      stderr += chunk;
    },
    doctorIO: captureIo,
    initIO: captureIo,
    startIO: captureIo,
    stopIO: captureIo,
    statusIO: captureIo,
    teamIO: captureIo,
    cloudMigrateIO: captureIo,
    pauseIO: captureIo,
    resumeIO: captureIo,
    loginIO: captureIo,
    logoutIO: captureIo,
    inviteIO: captureIo,
    orgIO: captureIo,
    teamJoinInviteIO: captureIo,
    logsIO: captureIo,
    dbMigrateIO: captureIo,
    dbBackupIO: captureIo,
    dbRestoreIO: captureIo,
    upgradeIO: captureIo,
    uninstallIO: captureIo,
    policyIO: captureIo,
    projectIO: captureIo,
    runIO: captureIo,
    exportIO: captureIo,
    packIO: captureIo,
    templateIO: captureIo,
    featureIO: captureIo,
  });

  applyCommanderOverrides(
    program,
    (s) => {
      stdout += s;
    },
    (s) => {
      stderr += s;
    },
  );

  try {
    await program.parseAsync(['node', 'coodra', ...argv]);
  } catch (err) {
    if (err instanceof TuiExitSignal) {
      exitCode = err.code;
    } else if (err instanceof CommanderError) {
      // Help / version / parse error — commander already wrote to our
      // buffers via configureOutput. helpDisplayed / version are exit 0.
      exitCode = err.exitCode;
    } else {
      crashed = true;
      exitCode = 1;
      const message = err instanceof Error ? err.message : String(err);
      stderr += `${stderr.length > 0 ? '\n' : ''}${message}\n`;
    }
  }

  return { stdout, stderr, exitCode, crashed };
}
