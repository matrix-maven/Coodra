import { Command } from 'commander';
import { type CloudMigrateIO, type CloudMigrateOptions, runCloudMigrateCommand } from './commands/cloud-migrate.js';
import { type DbBackupIO, type DbBackupOptions, runDbBackupCommand } from './commands/db-backup.js';
import { type DbMigrateIO, type DbMigrateOptions, runDbMigrateCommand } from './commands/db-migrate.js';
import { type DbRestoreIO, type DbRestoreOptions, runDbRestoreCommand } from './commands/db-restore.js';
import { type DoctorIO, type DoctorOptions, runDoctorCommand } from './commands/doctor.js';
import { type InitIO, type InitOptions, runInitCommand } from './commands/init.js';
import { type LogsIO, type LogsOptions, runLogsCommand } from './commands/logs.js';
import { type PauseIO, type PauseOptions, runPauseCommand } from './commands/pause.js';
import { type ResumeIO, type ResumeOptions, runResumeCommand } from './commands/resume.js';
import { runStartCommand, type StartIO, type StartOptions } from './commands/start.js';
import { runStatusCommand, type StatusIO, type StatusOptions } from './commands/status.js';
import { runStopCommand, type StopIO, type StopOptions } from './commands/stop.js';
import {
  runTeamLoginCommand,
  runTeamLogoutCommand,
  type TeamCommandIO,
  type TeamLoginOptions,
} from './commands/team.js';
import { runUninstallCommand, type UninstallIO, type UninstallOptions } from './commands/uninstall.js';
import { runUpgradeCommand, type UpgradeIO, type UpgradeOptions } from './commands/upgrade.js';
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
  readonly pauseIO?: PauseIO;
  readonly runPause?: (options: PauseOptions, io?: PauseIO) => Promise<unknown>;
  readonly resumeIO?: ResumeIO;
  readonly runResume?: (options: ResumeOptions, io?: ResumeIO) => Promise<unknown>;
  readonly logsIO?: LogsIO;
  readonly runLogs?: (service: string, options: LogsOptions, io?: LogsIO) => Promise<unknown>;
  readonly dbMigrateIO?: DbMigrateIO;
  readonly runDbMigrate?: (options: DbMigrateOptions, io?: DbMigrateIO) => Promise<unknown>;
  readonly dbBackupIO?: DbBackupIO;
  readonly runDbBackup?: (options: DbBackupOptions, io?: DbBackupIO) => Promise<unknown>;
  readonly dbRestoreIO?: DbRestoreIO;
  readonly runDbRestore?: (source: string, options: DbRestoreOptions, io?: DbRestoreIO) => Promise<unknown>;
  readonly upgradeIO?: UpgradeIO;
  readonly runUpgrade?: (options: UpgradeOptions, io?: UpgradeIO) => Promise<unknown>;
  readonly uninstallIO?: UninstallIO;
  readonly runUninstall?: (options: UninstallOptions, io?: UninstallIO) => Promise<unknown>;
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

  // Module 08b S5 + S6 — `db {migrate,backup,restore}`.
  const db = program
    .command('db')
    .description('Database administration: migrate / backup / restore the local SQLite primary store.');
  const dbMigrateRunner = options.runDbMigrate ?? runDbMigrateCommand;
  db.command('migrate')
    .description(
      'Apply pending Drizzle migrations to ~/.contextos/data.db. Idempotent. Refuses if any daemon is alive (use --with-daemons-running to override).',
    )
    .option('--dry-run', 'Report pending count without applying.')
    .option(
      '--with-daemons-running',
      'Skip the alive-daemon refusal (advanced; data corruption risk if daemons hold open writers).',
    )
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: DbMigrateOptions) => {
      await dbMigrateRunner(opts, options.dbMigrateIO);
    });

  const dbBackupRunner = options.runDbBackup ?? runDbBackupCommand;
  db.command('backup')
    .description(
      'Backup ~/.contextos/data.db. Default = single-file VACUUM INTO snapshot. --include-logs switches to a tarball with logs + config.',
    )
    .option('--out <path>', 'Destination path (default: ~/.contextos/backups/data.db.bak.<ISO>.sqlite).')
    .option('--include-logs', 'Produce a .tar.gz containing data.db.bak + logs/*.log + config.json.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: DbBackupOptions) => {
      await dbBackupRunner(opts, options.dbBackupIO);
    });

  const dbRestoreRunner = options.runDbRestore ?? runDbRestoreCommand;
  db.command('restore <source>')
    .description(
      'Restore ~/.contextos/data.db from <source> (a SQLite file). Atomic replace + auto-backup of current DB. Refuses if any daemon is alive — no override.',
    )
    .option('--no-auto-backup', 'Skip the safety snapshot of the current DB before replacing it.')
    .option('--force', 'Skip the interactive confirmation prompt (reserved for future TTY-aware prompting).')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (source: string, opts: DbRestoreOptions) => {
      await dbRestoreRunner(source, opts, options.dbRestoreIO);
    });

  // Module 08b S8 — reverse `init` writes.
  const uninstallRunner = options.runUninstall ?? runUninstallCommand;
  program
    .command('uninstall')
    .description(
      'Reverse `contextos init`: remove `__contextos__` matchers from ~/.claude/settings.json + `contextos` server from .mcp.json. Default-safe (preserves data + config + feature/context packs); --purge removes ~/.contextos/.',
    )
    .option('--purge', 'Remove ~/.contextos/ as well (data + config + logs + pids).')
    .option('--dry-run', 'Print what would change without touching disk.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: UninstallOptions) => {
      await uninstallRunner(opts, options.uninstallIO);
    });

  // Module 08b S7 — version-aware orchestration around npm install.
  const upgradeRunner = options.runUpgrade ?? runUpgradeCommand;
  program
    .command('upgrade')
    .description(
      'Check for a newer @coodra/contextos-cli on npm. Does NOT self-update — prints the install command. After install, re-run to apply migrations + restart daemons.',
    )
    .option('--check-only', 'Print the version comparison and exit; never restart or migrate.')
    .option('--no-restart', 'Skip the daemon restart after a same-version no-op upgrade.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: UpgradeOptions) => {
      await upgradeRunner(opts, options.upgradeIO);
    });

  // Module 08b S4 — log tail/read.
  const logsRunner = options.runLogs ?? runLogsCommand;
  program
    .command('logs <service>')
    .description(
      'Tail or print recent lines from ~/.contextos/logs/<service>.log. Pure file-read; no DB. Service ∈ {mcp-server, hooks-bridge, sync-daemon}.',
    )
    .option('--follow', 'Keep streaming new lines as they arrive (Ctrl-C to exit).')
    .option('--lines <N>', 'Print the last N lines (default 100; max 1,000,000).')
    .option('--since <input>', 'ISO-8601 timestamp OR relative duration (e.g. "5m", "1h", "7d").')
    .action(async (service: string, opts: LogsOptions) => {
      await logsRunner(service, opts, options.logsIO);
    });

  // Module 08b S3 — operator pause/resume backed by `kill_switches`.
  const pauseRunner = options.runPause ?? runPauseCommand;
  program
    .command('pause')
    .description(
      'Pause ContextOS enforcement on the local machine via a row in `kill_switches`. Hard mode (default) denies; soft mode allows + audits. Local-only (M08b OQ-8); cross-developer sync is M04.',
    )
    .option('--scope <scope>', 'global | project | tool | agent_type (default: global)')
    .option('--target <value>', 'projectSlug | toolName | agentType (required when --scope != global)')
    .option('--mode <mode>', 'hard | soft (default: hard, per OQ-1)')
    .option('--reason <reason>', 'Operator audit context (recommended; auto-generated if omitted)')
    .option('--expires-in <duration>', 'Auto-resume after duration (e.g. 5m, 1h, 24h, 7d, 1d6h)')
    .option('--json', 'Emit structured JSON instead of human-readable text.')
    .action(async (opts: PauseOptions) => {
      await pauseRunner(opts, options.pauseIO);
    });

  const resumeRunner = options.runResume ?? runResumeCommand;
  program
    .command('resume')
    .description('Resume one or more active kill switches. Use --id, --all, or --scope[/--target].')
    .option('--id <id>', 'Resume the named switch (ks_…).')
    .option('--all', 'Resume every currently-active switch.')
    .option(
      '--scope <scope>',
      'Filter by scope (global | project | tool | agent_type) — resumes every matching active row.',
    )
    .option('--target <value>', 'Used with --scope to filter further (projectSlug | toolName | agentType).')
    .option('--json', 'Emit structured JSON instead of human-readable text.')
    .action(async (opts: ResumeOptions) => {
      await resumeRunner(opts, options.resumeIO);
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
