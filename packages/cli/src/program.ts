import { Command } from 'commander';
import { type CloudMigrateIO, type CloudMigrateOptions, runCloudMigrateCommand } from './commands/cloud-migrate.js';
import { type DbBackupIO, type DbBackupOptions, runDbBackupCommand } from './commands/db-backup.js';
import { type DbMigrateIO, type DbMigrateOptions, runDbMigrateCommand } from './commands/db-migrate.js';
import { type DbRestoreIO, type DbRestoreOptions, runDbRestoreCommand } from './commands/db-restore.js';
import { type DoctorIO, type DoctorOptions, runDoctorCommand } from './commands/doctor.js';
import { type ExportIO, type ExportOptions, runExportCommand } from './commands/export.js';
import { type InitIO, type InitOptions, runInitCommand } from './commands/init.js';
import { type LogsIO, type LogsOptions, runLogsCommand } from './commands/logs.js';
import {
  type PackDeleteOptions,
  type PackIO,
  type PackListOptions,
  type PackNewOptions,
  type PackRegenerateOptions,
  type PackShowOptions,
  runPackDeleteCommand,
  runPackListCommand,
  runPackNewCommand,
  runPackRegenerateCommand,
  runPackShowCommand,
} from './commands/pack.js';
import { type PauseIO, type PauseOptions, runPauseCommand } from './commands/pause.js';
import {
  type PolicyAddOptions,
  type PolicyEnableDisableOptions,
  type PolicyIO,
  type PolicyListOptions,
  type PolicyShowOptions,
  runPolicyAddCommand,
  runPolicyDisableCommand,
  runPolicyEnableCommand,
  runPolicyListCommand,
  runPolicyShowCommand,
} from './commands/policy.js';
import {
  type ProjectIO,
  type ProjectListOptions,
  type ProjectResetOptions,
  type ProjectShowOptions,
  runProjectListCommand,
  runProjectResetCommand,
  runProjectShowCommand,
} from './commands/project.js';
import { type ResumeIO, type ResumeOptions, runResumeCommand } from './commands/resume.js';
import {
  type RunCancelOptions,
  type RunIO,
  type RunListOptions,
  type RunShowOptions,
  runRunCancelCommand,
  runRunListCommand,
  runRunShowCommand,
} from './commands/run.js';
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
  readonly policyIO?: PolicyIO;
  readonly runPolicyList?: (options: PolicyListOptions, io?: PolicyIO) => Promise<unknown>;
  readonly runPolicyShow?: (identifier: string, options: PolicyShowOptions, io?: PolicyIO) => Promise<unknown>;
  readonly runPolicyAdd?: (options: PolicyAddOptions, io?: PolicyIO) => Promise<unknown>;
  readonly runPolicyEnable?: (
    identifier: string,
    options: PolicyEnableDisableOptions,
    io?: PolicyIO,
  ) => Promise<unknown>;
  readonly runPolicyDisable?: (
    identifier: string,
    options: PolicyEnableDisableOptions,
    io?: PolicyIO,
  ) => Promise<unknown>;
  readonly projectIO?: ProjectIO;
  readonly runProjectList?: (options: ProjectListOptions, io?: ProjectIO) => Promise<unknown>;
  readonly runProjectShow?: (identifier: string, options: ProjectShowOptions, io?: ProjectIO) => Promise<unknown>;
  readonly runProjectReset?: (identifier: string, options: ProjectResetOptions, io?: ProjectIO) => Promise<unknown>;
  readonly runIO?: RunIO;
  readonly runRunList?: (options: RunListOptions, io?: RunIO) => Promise<unknown>;
  readonly runRunShow?: (runId: string, options: RunShowOptions, io?: RunIO) => Promise<unknown>;
  readonly runRunCancel?: (runId: string, options: RunCancelOptions, io?: RunIO) => Promise<unknown>;
  readonly exportIO?: ExportIO;
  readonly runExport?: (runId: string, options: ExportOptions, io?: ExportIO) => Promise<unknown>;
  readonly packIO?: PackIO;
  readonly runPackNew?: (slug: string, options: PackNewOptions, io?: PackIO) => Promise<unknown>;
  readonly runPackList?: (options: PackListOptions, io?: PackIO) => Promise<unknown>;
  readonly runPackShow?: (slug: string, options: PackShowOptions, io?: PackIO) => Promise<unknown>;
  readonly runPackRegenerate?: (slug: string, options: PackRegenerateOptions, io?: PackIO) => Promise<unknown>;
  readonly runPackDelete?: (slug: string, options: PackDeleteOptions, io?: PackIO) => Promise<unknown>;
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
    .option(
      '--template <name|path>',
      'Module 08b S13: feature-pack template selector. Bundled options: generic, nextjs-saas, python-fastapi, python-ml, node-monorepo, rust-cli, go-service. Pass a path (./local-dir or absolute) to load from disk.',
    )
    .option(
      '--mode <mode>',
      'minimal (default; legacy skeleton) | default (template-driven) | auto (detect a template from project shape).',
    )
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

  // Module 08b S9 — policy admin (list, show, add, enable, disable).
  const policy = program.command('policy').description('Manage policies + policy_rules in the local SQLite store.');
  const policyListRunner = options.runPolicyList ?? runPolicyListCommand;
  policy
    .command('list')
    .description('Print every policy (with attached rules) for one project or all projects.')
    .option('--project <slug>', 'Limit to a single project slug.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: PolicyListOptions) => {
      await policyListRunner(opts, options.policyIO);
    });
  const policyShowRunner = options.runPolicyShow ?? runPolicyShowCommand;
  policy
    .command('show <identifier>')
    .description('Print one policy by id or name (project-scoped via --project when names collide).')
    .option('--project <slug>', 'Restrict the lookup to a single project.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (identifier: string, opts: PolicyShowOptions) => {
      await policyShowRunner(identifier, opts, options.policyIO);
    });
  const policyAddRunner = options.runPolicyAdd ?? runPolicyAddCommand;
  policy
    .command('add')
    .description(
      "Add a rule to the project's __default__ policy (auto-created if absent). Rule lands at priority 100+ to stay below the seeded defaults.",
    )
    .requiredOption('--project <slug>', 'Project slug (must already exist; run `contextos init` first).')
    .requiredOption('--tool <name>', 'Tool name to match (e.g. Write, Edit, Bash).')
    .requiredOption('--decision <decision>', 'allow | deny | ask')
    .requiredOption('--reason <text>', 'Operator audit context (required).')
    .option('--event-type <type>', 'PreToolUse | PostToolUse (default: PreToolUse).')
    .option('--path-glob <glob>', 'File-path glob to match (e.g. ".env", "**/.env", "node_modules/**").')
    .option('--agent-type <type>', 'Agent type to match: claude_code | cursor | windsurf | * (default: *).')
    .option('--priority <n>', 'Numeric priority (default: max(existing) + 10 or 100).')
    .option('--policy-name <name>', 'Target policy name (default: __default__).')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: PolicyAddOptions) => {
      await policyAddRunner(opts, options.policyIO);
    });
  const policyEnableRunner = options.runPolicyEnable ?? runPolicyEnableCommand;
  policy
    .command('enable <identifier>')
    .description('Enable a policy (sets is_active=true). Idempotent.')
    .option('--project <slug>', 'Restrict the lookup to a single project (use when names collide).')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (identifier: string, opts: PolicyEnableDisableOptions) => {
      await policyEnableRunner(identifier, opts, options.policyIO);
    });
  const policyDisableRunner = options.runPolicyDisable ?? runPolicyDisableCommand;
  policy
    .command('disable <identifier>')
    .description('Disable a policy (sets is_active=false). Idempotent. Bridge stops applying its rules within ~60s.')
    .option('--project <slug>', 'Restrict the lookup to a single project (use when names collide).')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (identifier: string, opts: PolicyEnableDisableOptions) => {
      await policyDisableRunner(identifier, opts, options.policyIO);
    });

  // Module 08b S10 — project admin (list, show, reset).
  const project = program.command('project').description('Manage project rows in the local SQLite store.');
  const projectListRunner = options.runProjectList ?? runProjectListCommand;
  project
    .command('list')
    .description('List every registered project (with run counts + last-run timestamps).')
    .option('--include-global', 'Also show the __global__ sentinel project (audit-fallback row).')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: ProjectListOptions) => {
      await projectListRunner(opts, options.projectIO);
    });
  const projectShowRunner = options.runProjectShow ?? runProjectShowCommand;
  project
    .command('show <identifier>')
    .description('Print one project (slug or id) with run-count, status breakdown, and last 5 runs.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (identifier: string, opts: ProjectShowOptions) => {
      await projectShowRunner(identifier, opts, options.projectIO);
    });
  const projectResetRunner = options.runProjectReset ?? runProjectResetCommand;
  project
    .command('reset <identifier>')
    .description(
      'DESTRUCTIVE: delete every per-run audit row (runs, run_events, policy_decisions, decisions, context_packs) for the project. Refuses without --force; refuses against the __global__ sentinel.',
    )
    .option('--force', 'Confirm the destructive delete (required).')
    .option('--keep-policies', 'Preserve policies + policy_rules + project-scoped kill_switches (default: true).', true)
    .option('--no-keep-policies', 'Also delete policies + policy_rules + project-scoped kill_switches.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (identifier: string, opts: ProjectResetOptions) => {
      await projectResetRunner(identifier, opts, options.projectIO);
    });

  // Module 08b S12 — read-only export <runId> --format markdown|json|html|slack.
  const exportRunner = options.runExport ?? runExportCommand;
  program
    .command('export <runId>')
    .description(
      'Render one run as markdown / json / html / slack. Read-only. Per OQ-7, non-JSON formats exclude the policy_decisions audit trail by default; --include-audit opts in. JSON always includes the audit.',
    )
    .requiredOption('--format <format>', 'markdown | json | html | slack')
    .option('--out <path>', 'Write output to <path> instead of stdout.')
    .option(
      '--include-audit',
      'Include policy_decisions in markdown/html/slack output (no effect on json — always included).',
    )
    .option(
      '--webhook <url>',
      'Slack format only: POST `{ "text": <body> }` to the URL. Falls back to stdout on failure.',
    )
    .action(async (runId: string, opts: ExportOptions) => {
      await exportRunner(runId, opts, options.exportIO);
    });

  // Module 08b S16 — pack admin (new, list, show, regenerate, delete).
  const pack = program.command('pack').description('Manage docs/feature-packs/<slug>/ directories.');
  const packNewRunner = options.runPackNew ?? runPackNewCommand;
  pack
    .command('new <slug>')
    .description('Create a new feature pack folder + 4-file scaffold from a template.')
    .option('--template <name|path>', 'Bundled template name OR a path to a local template dir.')
    .option('--parent <slug>', 'parentSlug for inheritance (recorded in meta.json#parentSlug).')
    .option('--mode <mode>', 'minimal | default | auto (auto detects template + populates @auto sections).')
    .option('--force', 'Overwrite an existing pack at this slug.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (slug: string, opts: PackNewOptions) => {
      await packNewRunner(slug, opts, options.packIO);
    });
  const packListRunner = options.runPackList ?? runPackListCommand;
  pack
    .command('list')
    .description(
      'List every feature pack under docs/feature-packs/, with isActive + parentSlug + missing-file warnings.',
    )
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: PackListOptions) => {
      await packListRunner(opts, options.packIO);
    });
  const packShowRunner = options.runPackShow ?? runPackShowCommand;
  pack
    .command('show <slug>')
    .description('Print one pack: meta.json + first 2KB excerpt of each markdown file + missing-file flags.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (slug: string, opts: PackShowOptions) => {
      await packShowRunner(slug, opts, options.packIO);
    });
  const packRegenerateRunner = options.runPackRegenerate ?? runPackRegenerateCommand;
  pack
    .command('regenerate <slug>')
    .description(
      'Refresh @auto sections in spec/implementation/techstack from project shape. Preserves all user-edited content outside markers.',
    )
    .option(
      '--mode <mode>',
      'auto (default) | minimal — auto repopulates from project shape; minimal leaves placeholders.',
    )
    .option('--dry-run', 'Print which files would change without writing.')
    .option('--force', 'Reserved for future use (currently has no effect).')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (slug: string, opts: PackRegenerateOptions) => {
      await packRegenerateRunner(slug, opts, options.packIO);
    });
  const packDeleteRunner = options.runPackDelete ?? runPackDeleteCommand;
  pack
    .command('delete <slug>')
    .description(
      'Remove docs/feature-packs/<slug>/ from disk + flip feature_packs.is_active to false (row preserved per ADR-007). Refuses without --force.',
    )
    .option('--force', 'Confirm the destructive delete (required).')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (slug: string, opts: PackDeleteOptions) => {
      await packDeleteRunner(slug, opts, options.packIO);
    });

  // Module 08b S11 — run admin (list, show, cancel).
  const run = program.command('run').description('Inspect + cancel rows in the `runs` table.');
  const runListRunner = options.runRunList ?? runRunListCommand;
  run
    .command('list')
    .description('List recent runs, optionally filtered by project / status / limit.')
    .option('--project <slug>', 'Filter to one project slug.')
    .option('--status <status>', 'Filter to one status (in_progress | completed | failed | abandoned | cancelled).')
    .option('--limit <n>', 'Max rows to return (default 20; max 1000).')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: RunListOptions) => {
      await runListRunner(opts, options.runIO);
    });
  const runShowRunner = options.runRunShow ?? runRunShowCommand;
  run
    .command('show <runId>')
    .description('Print one run + every related row (events, policy_decisions, decisions, context pack).')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (runId: string, opts: RunShowOptions) => {
      await runShowRunner(runId, opts, options.runIO);
    });
  const runCancelRunner = options.runRunCancel ?? runRunCancelCommand;
  run
    .command('cancel <runId>')
    .description(
      'Mark a run as cancelled (status=cancelled, ended_at=now). Informational only — bridge keeps recording any post-cancel events. Refuses on already-terminal runs.',
    )
    .option('--force', 'Reserved for future use; currently has no effect.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (runId: string, opts: RunCancelOptions) => {
      await runCancelRunner(runId, opts, options.runIO);
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
