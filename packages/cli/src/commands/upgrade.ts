import semver from 'semver';
import { EXIT_OK, EXIT_USER_ACTION_REQUIRED, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { NpmViewError, npmViewVersion } from '../lib/npm-view.js';
import { pc } from '../ui/index.js';
import { VERSION } from '../version.js';

/**
 * `coodra upgrade` — version-aware orchestration that complements
 * the user's npm install command.
 *
 * Three states:
 *
 *   1. Already at the latest published version
 *      → run `db migrate` (idempotent) + cycle daemons (stop+start)
 *        unless --no-restart. Exit 0.
 *   2. Newer version published than what's installed
 *      → print the install command for the user to run
 *        (`npm i -g @coodra/cli@<v>`). Exit 2 (user action).
 *   3. `npm view` fails (network outage, registry 5xx)
 *      → print the failure + exit 1. The user can retry.
 *
 * The CLI does NOT self-update. Two reasons:
 *   - On Windows, npm cannot reliably overwrite a binary that's
 *     currently executing.
 *   - On Linux/macOS, the user's `node_modules/.bin/coodra`
 *     symlink points at a half-written file mid-update.
 * The user runs the npm command; the CLI orchestrates everything
 * else (db migrate, daemon restart) on next invocation.
 *
 * `--check-only` exits before any restart; useful for shell-script
 * authors who want to detect "newer available" without side effects.
 *
 * Network call: ONE outbound HTTPS GET to registry.npmjs.org per
 * invocation (npm view). No telemetry; this is the ONLY outbound
 * call M08b adds.
 */

export interface UpgradeOptions {
  readonly checkOnly?: boolean;
  readonly noRestart?: boolean;
  readonly json?: boolean;
}

export interface UpgradeIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
  /** Override the version-fetcher for tests. */
  readonly fetchPublishedVersion?: () => Promise<string>;
  /** Override the restart hook for tests. Default no-op (the real wiring
   *  in S7 is `runStop` + `runStart` from existing M08a commands). */
  readonly restartDaemons?: () => Promise<void>;
  /** Override the migrate hook for tests. Default no-op. */
  readonly runMigrate?: () => Promise<void>;
}

export const DEFAULT_UPGRADE_IO: UpgradeIO = {
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

interface UpgradeJson {
  readonly ok: boolean;
  readonly status: 'up_to_date' | 'newer_available' | 'check_failed';
  readonly installed: string;
  readonly published?: string;
  readonly installCommand?: string;
  readonly migrated?: boolean;
  readonly restarted?: boolean;
  readonly error?: string;
}

export async function runUpgradeCommand(options: UpgradeOptions, ioOverride?: UpgradeIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_UPGRADE_IO;
  const json = options.json === true;
  const checkOnly = options.checkOnly === true;
  const noRestart = options.noRestart === true;
  const installed = VERSION;

  let published: string;
  try {
    published = io.fetchPublishedVersion !== undefined ? await io.fetchPublishedVersion() : await npmViewVersion();
  } catch (err) {
    const message =
      err instanceof NpmViewError
        ? `npm view failed (${err.code}): ${err.message}`
        : `npm view failed: ${err instanceof Error ? err.message : String(err)}`;
    return surfaceCheckFailed(io, json, installed, message);
  }

  if (!semver.valid(installed)) {
    return surfaceCheckFailed(io, json, installed, `installed version "${installed}" is not a valid semver`);
  }
  if (!semver.valid(published)) {
    return surfaceCheckFailed(io, json, installed, `published version "${published}" is not a valid semver`);
  }

  if (semver.gt(published, installed)) {
    const installCommand = `npm i -g @coodra/cli@${published}`;
    if (json) {
      const payload: UpgradeJson = {
        ok: true,
        status: 'newer_available',
        installed,
        published,
        installCommand,
      };
      io.writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      io.writeStdout(
        `${pc.yellow('!')} Newer version available: ${installed} → ${published}.\n` +
          `  Run: ${pc.cyan(installCommand)}\n` +
          `  Then re-run \`coodra upgrade\` to apply migrations + restart daemons.\n`,
      );
    }
    io.exit(EXIT_USER_ACTION_REQUIRED);
    return;
  }

  // installed >= published → up to date.
  let migrated = false;
  let restarted = false;
  if (!checkOnly) {
    try {
      if (io.runMigrate !== undefined) {
        await io.runMigrate();
      }
      migrated = true;
    } catch (err) {
      return surfaceCheckFailed(
        io,
        json,
        installed,
        `db migrate failed during upgrade: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!noRestart && io.restartDaemons !== undefined) {
      try {
        await io.restartDaemons();
        restarted = true;
      } catch (err) {
        return surfaceCheckFailed(
          io,
          json,
          installed,
          `daemon restart failed during upgrade: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (json) {
    const payload: UpgradeJson = {
      ok: true,
      status: 'up_to_date',
      installed,
      published,
      migrated,
      restarted,
    };
    io.writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    io.writeStdout(
      `${pc.green('✓')} Up to date (${installed} === ${published}).` +
        (checkOnly
          ? '\n'
          : ` Migrations: ${migrated ? 'applied (idempotent)' : 'skipped'}. Restart: ${restarted ? 'cycled' : noRestart ? 'skipped (--no-restart)' : 'skipped (no daemons hook)'}.\n`),
    );
  }
  io.exit(EXIT_OK);
}

function surfaceCheckFailed(io: UpgradeIO, json: boolean, installed: string, message: string): void {
  if (json) {
    const payload: UpgradeJson = {
      ok: false,
      status: 'check_failed',
      installed,
      error: message,
    };
    io.writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    io.writeStderr(`${pc.red('error')}: ${message}\n`);
  }
  io.exit(EXIT_USER_RECOVERABLE);
}
