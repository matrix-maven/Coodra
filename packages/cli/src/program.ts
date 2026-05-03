import { Command } from 'commander';
import { type CloudMigrateIO, type CloudMigrateOptions, runCloudMigrateCommand } from './commands/cloud-migrate.js';
import { type DoctorIO, type DoctorOptions, runDoctorCommand } from './commands/doctor.js';
import { type InitIO, type InitOptions, runInitCommand } from './commands/init.js';
import { runStartCommand, type StartIO, type StartOptions } from './commands/start.js';
import { runStatusCommand, type StatusIO, type StatusOptions } from './commands/status.js';
import { runStopCommand, type StopIO, type StopOptions } from './commands/stop.js';
import {
  runTeamLoginCommand,
  runTeamLogoutCommand,
  type TeamCommandIO,
  type TeamLoginOptions,
} from './commands/team.js';
import { VERSION } from './version.js';

interface BuildProgramOptions {
  /** Override stderr writer for tests; defaults to `process.stderr.write`. */
  readonly writeStderr?: (chunk: string) => void;
  /** Override doctor IO for tests; defaults to writing to process.stdout/stderr and process.exit. */
  readonly doctorIO?: DoctorIO;
  /** Replace the doctor handler entirely (used by unit tests to assert wiring). */
  readonly runDoctor?: (options: DoctorOptions, io?: DoctorIO) => Promise<unknown>;
  /** Override init IO for tests. */
  readonly initIO?: InitIO;
  /** Replace the init handler for unit tests. */
  readonly runInit?: (options: InitOptions, io?: InitIO) => Promise<unknown>;
  readonly startIO?: StartIO;
  readonly runStart?: (options: StartOptions, io?: StartIO) => Promise<unknown>;
  readonly stopIO?: StopIO;
  readonly runStop?: (options: StopOptions, io?: StopIO) => Promise<unknown>;
  readonly statusIO?: StatusIO;
  readonly runStatus?: (options: StatusOptions, io?: StatusIO) => Promise<unknown>;
  readonly teamIO?: TeamCommandIO;
  readonly runTeamLogin?: (options: TeamLoginOptions, io?: TeamCommandIO) => Promise<unknown>;
  readonly runTeamLogout?: (io?: TeamCommandIO) => Promise<unknown>;
  readonly cloudMigrateIO?: CloudMigrateIO;
  readonly runCloudMigrate?: (options: CloudMigrateOptions, io?: CloudMigrateIO) => Promise<unknown>;
}

/**
 * Builds the top-level commander surface. Each subcommand is wired in this
 * file — bodies are stubbed to exit 99 in S1 and replaced slice-by-slice
 * (`init` in S5, `doctor` in S3, `start`/`stop` in S7, `status` + team
 * `login`/`logout` in S8). The slice each stub names matches
 * `docs/feature-packs/08a-cli/implementation.md`.
 */
export function buildProgram(options: BuildProgramOptions = {}): Command {
  // writeStderr is reserved for future stub commands. Currently every
  // subcommand has a real handler; reference the option to keep the
  // surface stable for follow-up modules.
  void options.writeStderr;

  const program = new Command();
  program
    .name('contextos')
    .description('ContextOS CLI — install, configure, run, and diagnose ContextOS on your machine.')
    .version(VERSION, '-v, --version', 'Print the @coodra/contextos-cli version and exit.')
    .helpOption('-h, --help', 'Show help for a command.')
    .showHelpAfterError(false);

  const initRunner = options.runInit ?? runInitCommand;
  program
    .command('init')
    .description(
      'Initialise ContextOS in the current project (writes ~/.contextos/, .mcp.json, .contextos.json, .env).',
    )
    .option('--project-slug <slug>', 'Project slug; derives from path.basename(cwd) when omitted.')
    .option('--ide <ide>', 'IDE to wire ("claude", "cursor", "windsurf", or "all").')
    .option('--no-graphify', 'Skip the Graphify scan during Feature Pack seeding.')
    .option('--dry-run', 'Print what init would write without touching disk.')
    .option('--force', 'Overwrite existing files with the baseline (destructive — see spec §11 Decision 3).')
    .action(async (opts: InitOptions) => {
      await initRunner(opts, options.initIO);
    });

  const startRunner = options.runStart ?? runStartCommand;
  program
    .command('start')
    .description('Start MCP Server + Hooks Bridge (+ Sync Daemon in team mode) as background daemons.')
    .option('--no-mcp', 'Do not start the MCP server.')
    .option('--no-hooks', 'Do not start the Hooks Bridge.')
    .option('--no-sync', 'Do not start the Sync Daemon (team-mode only; ignored in solo mode).')
    .option('--foreground', 'Run attached for debugging (does not register the daemon manager unit).')
    .action(async (opts: StartOptions) => {
      await startRunner(opts, options.startIO);
    });

  const stopRunner = options.runStop ?? runStopCommand;
  program
    .command('stop')
    .description('Stop ContextOS daemons. Idempotent.')
    .option('--service <name>', 'Stop only the named service.')
    .option('--uninstall', 'Also uninstall the daemon-manager units.')
    .action(async (opts: StopOptions) => {
      await stopRunner(opts, options.stopIO);
    });

  const statusRunner = options.runStatus ?? runStatusCommand;
  program
    .command('status')
    .description('Print unified project + service state for the current cwd.')
    .option('--json', 'Emit structured JSON instead of human-readable text.')
    .action(async (opts: StatusOptions) => {
      await statusRunner(opts, options.statusIO);
    });

  const doctorRunner = options.runDoctor ?? runDoctorCommand;
  program
    .command('doctor')
    .description(
      'Run health checks (read-only). Defaults to the 11 essential checks for the Claude Code + solo-mode path; ' +
        'use --full for the complete 30-check registry (debug invariants, team-mode probes, outbox observability, lifecycle invariants).',
    )
    .option('--json', 'Emit structured JSON instead of human-readable text.')
    .option('--timeout-ms <ms>', 'Per-check timeout in milliseconds (default 2000).')
    .option('--full', 'Run every check in the registry, not just the essentials (dec_83ba10c1, 2026-05-02).')
    .action(async (opts: DoctorOptions) => {
      await doctorRunner(opts, options.doctorIO);
    });

  const cloudMigrateRunner = options.runCloudMigrate ?? runCloudMigrateCommand;
  program
    .command('cloud-migrate')
    .description(
      'Apply Drizzle Postgres migrations to the cloud DATABASE_URL (team-mode self-host). Idempotent. Refuses ' +
        'to run if unknown tables contain data — see Module 04a OQ4.',
    )
    .option('--database-url <url>', 'Override the DATABASE_URL env var.')
    .option('--dry-run', 'Run pre-flight checks only; do not apply migrations.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: CloudMigrateOptions) => {
      await cloudMigrateRunner(opts, options.cloudMigrateIO);
    });

  const team = program
    .command('team')
    .description('Team-mode commands. Bodies land when team mode is reachable end-to-end (post-Module 04).');

  const loginRunner = options.runTeamLogin ?? runTeamLoginCommand;
  team
    .command('login')
    .argument('[token]', 'Invite token from the team admin.')
    .option('--server <url>', 'Override the team-mode server URL.')
    .description('Log in to a team (writes ~/.contextos/config.json with LOCAL_HOOK_SECRET). Stub in 08a.')
    .action(async (token: string | undefined, opts: { server?: string }) => {
      const merged: TeamLoginOptions = {
        ...(token !== undefined ? { token } : {}),
        ...(opts.server !== undefined ? { server: opts.server } : {}),
      };
      await loginRunner(merged, options.teamIO);
    });

  const logoutRunner = options.runTeamLogout ?? runTeamLogoutCommand;
  team
    .command('logout')
    .description(
      'Log out of the current team (rotates the local secret and clears ~/.contextos/config.json). Stub in 08a.',
    )
    .action(async () => {
      await logoutRunner(options.teamIO);
    });

  return program;
}
