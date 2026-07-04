import { Command } from 'commander';
import { type AgentsIO, type AgentsOptions, runAgentsCommand } from './commands/agents.js';
import { type CloudMigrateIO, type CloudMigrateOptions, runCloudMigrateCommand } from './commands/cloud-migrate.js';
import { type DbBackupIO, type DbBackupOptions, runDbBackupCommand } from './commands/db-backup.js';
import { type DbMigrateIO, type DbMigrateOptions, runDbMigrateCommand } from './commands/db-migrate.js';
import { type DbRestoreIO, type DbRestoreOptions, runDbRestoreCommand } from './commands/db-restore.js';
import { type DoctorIO, type DoctorOptions, runDoctorCommand } from './commands/doctor.js';
import { type ExportIO, type ExportOptions, runExportCommand } from './commands/export.js';
import {
  type FeatureAddOptions,
  type FeatureBaseOptions,
  type FeatureIO,
  type FeatureRemoveOptions,
  runFeatureAddCommand,
  runFeatureEditCommand,
  runFeatureIndexCommand,
  runFeatureListCommand,
  runFeatureRemoveCommand,
  runFeatureShowCommand,
} from './commands/feature.js';
import {
  type GraphifyDisableOptions,
  type GraphifyEnableOptions,
  type GraphifyIO,
  type GraphifyStatusOptions,
  runGraphifyDisableCommand,
  runGraphifyEnableCommand,
  runGraphifyStatusCommand,
} from './commands/graphify.js';
import { type InitIO, type InitOptions, runInitCommand } from './commands/init.js';
import { type InviteIO, type InviteOptions, runInviteCommand } from './commands/invite.js';
import {
  type JiraDisableOptions,
  type JiraEnableOptions,
  type JiraIO,
  type JiraStatusOptions,
  runJiraDisableCommand,
  runJiraEnableCommand,
  runJiraStatusCommand,
} from './commands/jira.js';
import { type LoginIO, type LoginOptions, runLoginCommand } from './commands/login.js';
import { type LogoutIO, type LogoutOptions, runLogoutCommand } from './commands/logout.js';
import { type LogsIO, type LogsOptions, runLogsCommand } from './commands/logs.js';
import { type MetricsIO, type MetricsOptions, runMetricsCommand } from './commands/metrics.js';
import {
  type OrgIO,
  type OrgStatusOptions,
  type OrgSwitchOptions,
  runOrgStatusCommand,
  runOrgSwitchCommand,
} from './commands/org.js';
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
  type ProjectDemoteOptions,
  type ProjectIO,
  type ProjectListOptions,
  type ProjectPromoteOptions,
  type ProjectResetOptions,
  type ProjectShowOptions,
  runProjectDemoteCommand,
  runProjectListCommand,
  runProjectPromoteCommand,
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
import type { TeamCommandIO, TeamLoginOptions } from './commands/team.js';
import { runTeamInitCommand, type TeamInitOptions } from './commands/team-init.js';
import { runTeamInstallCommand, type TeamInstallOptions } from './commands/team-install.js';
import { runTeamJoinInviteCommand, type TeamJoinInviteIO, type TeamJoinInviteOptions } from './commands/team-join.js';
import {
  runTeamJoinCommand,
  runTeamLeaveCommand,
  runTeamMigrateCommand,
  type TeamJoinOptions,
  type TeamLeaveOptions,
  type TeamMigrateOptions,
} from './commands/team-migrate-cmd.js';
import { runTeamSetupCommand, type TeamSetupOptions } from './commands/team-setup-cmd.js';
import {
  runTemplateInstallCommand,
  runTemplateListCommand,
  type TemplateInstallOptions,
  type TemplateIO,
  type TemplateListOptions,
} from './commands/template.js';
import { runUninstallCommand, type UninstallIO, type UninstallOptions } from './commands/uninstall.js';
import { runUpgradeCommand, type UpgradeIO, type UpgradeOptions } from './commands/upgrade.js';
import {
  runWikiCleanCommand,
  runWikiGenerateCommand,
  runWikiListCommand,
  runWikiOpenCommand,
  runWikiStatusCommand,
  type WikiCleanOptions,
  type WikiGenerateOptions,
  type WikiIO,
  type WikiListOptions,
  type WikiOpenOptions,
  type WikiStatusOptions,
} from './commands/wiki.js';
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
  readonly metricsIO?: MetricsIO;
  readonly runMetrics?: (options: MetricsOptions, io?: MetricsIO) => Promise<unknown>;
  readonly agentsIO?: AgentsIO;
  readonly runAgents?: (options: AgentsOptions, io?: AgentsIO) => Promise<unknown>;
  readonly graphifyIO?: GraphifyIO;
  readonly runGraphifyEnable?: (options: GraphifyEnableOptions, io?: GraphifyIO) => Promise<unknown>;
  readonly runGraphifyDisable?: (options: GraphifyDisableOptions, io?: GraphifyIO) => Promise<unknown>;
  readonly runGraphifyStatus?: (options: GraphifyStatusOptions, io?: GraphifyIO) => Promise<unknown>;
  readonly jiraIO?: JiraIO;
  readonly runJiraEnable?: (options: JiraEnableOptions, io?: JiraIO) => Promise<unknown>;
  readonly runJiraDisable?: (options: JiraDisableOptions, io?: JiraIO) => Promise<unknown>;
  readonly runJiraStatus?: (options: JiraStatusOptions, io?: JiraIO) => Promise<unknown>;
  readonly wikiIO?: WikiIO;
  readonly runWikiGenerate?: (options: WikiGenerateOptions, io?: WikiIO) => Promise<unknown>;
  readonly runWikiStatus?: (options: WikiStatusOptions, io?: WikiIO) => Promise<unknown>;
  readonly runWikiList?: (options: WikiListOptions, io?: WikiIO) => Promise<unknown>;
  readonly runWikiOpen?: (options: WikiOpenOptions, io?: WikiIO) => Promise<unknown>;
  readonly runWikiClean?: (slug: string, options: WikiCleanOptions, io?: WikiIO) => Promise<unknown>;
  readonly teamIO?: TeamCommandIO;
  readonly runTeamLogin?: (options: TeamLoginOptions, io?: TeamCommandIO) => Promise<unknown>;
  readonly runTeamLogout?: (io?: TeamCommandIO) => Promise<unknown>;
  readonly runTeamMigrate?: (options: TeamMigrateOptions, io?: TeamCommandIO) => Promise<unknown>;
  readonly runTeamJoin?: (options: TeamJoinOptions, io?: TeamCommandIO) => Promise<unknown>;
  readonly runTeamLeave?: (options: TeamLeaveOptions, io?: TeamCommandIO) => Promise<unknown>;
  readonly runTeamSetup?: (options: TeamSetupOptions, io?: TeamCommandIO) => Promise<unknown>;
  readonly runTeamInstall?: (options: TeamInstallOptions, io?: TeamCommandIO) => Promise<unknown>;
  readonly runTeamInit?: (options: TeamInitOptions, io?: TeamCommandIO) => Promise<unknown>;
  readonly cloudMigrateIO?: CloudMigrateIO;
  readonly runCloudMigrate?: (options: CloudMigrateOptions, io?: CloudMigrateIO) => Promise<unknown>;
  readonly pauseIO?: PauseIO;
  readonly runPause?: (options: PauseOptions, io?: PauseIO) => Promise<unknown>;
  readonly resumeIO?: ResumeIO;
  readonly runResume?: (options: ResumeOptions, io?: ResumeIO) => Promise<unknown>;
  readonly loginIO?: LoginIO;
  readonly runLogin?: (options: LoginOptions, io?: LoginIO) => Promise<unknown>;
  readonly logoutIO?: LogoutIO;
  readonly runLogout?: (options: LogoutOptions, io?: LogoutIO) => Promise<unknown>;
  readonly inviteIO?: InviteIO;
  readonly runInvite?: (email: string, options: InviteOptions, io?: InviteIO) => Promise<unknown>;
  readonly orgIO?: OrgIO;
  readonly runOrgStatus?: (options: OrgStatusOptions, io?: OrgIO) => Promise<unknown>;
  readonly runOrgSwitch?: (options: OrgSwitchOptions, io?: OrgIO) => Promise<unknown>;
  readonly teamJoinInviteIO?: TeamJoinInviteIO;
  readonly runTeamJoinInvite?: (options: TeamJoinInviteOptions, io?: TeamJoinInviteIO) => Promise<unknown>;
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
  readonly runProjectPromote?: (
    identifier: string | undefined,
    options: ProjectPromoteOptions,
    io?: ProjectIO,
  ) => Promise<unknown>;
  readonly runProjectDemote?: (
    identifier: string | undefined,
    options: ProjectDemoteOptions,
    io?: ProjectIO,
  ) => Promise<unknown>;
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
  readonly templateIO?: TemplateIO;
  readonly runTemplateList?: (options: TemplateListOptions, io?: TemplateIO) => Promise<unknown>;
  readonly runTemplateInstall?: (source: string, options: TemplateInstallOptions, io?: TemplateIO) => Promise<unknown>;
  readonly featureIO?: FeatureIO;
  readonly runFeatureAdd?: (slug: string, options: FeatureAddOptions, io?: FeatureIO) => Promise<unknown>;
  readonly runFeatureList?: (options: FeatureBaseOptions, io?: FeatureIO) => Promise<unknown>;
  readonly runFeatureShow?: (slug: string, options: FeatureBaseOptions, io?: FeatureIO) => Promise<unknown>;
  readonly runFeatureEdit?: (slug: string, options: FeatureBaseOptions, io?: FeatureIO) => Promise<unknown>;
  readonly runFeatureIndex?: (options: FeatureBaseOptions, io?: FeatureIO) => Promise<unknown>;
  readonly runFeatureRemove?: (slug: string, options: FeatureRemoveOptions, io?: FeatureIO) => Promise<unknown>;
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
    .name('coodra')
    .description('Coodra CLI — install, configure, run, and diagnose Coodra on your machine.')
    .version(VERSION, '-v, --version', 'Print the @coodra/cli version and exit.')
    .helpOption('-h, --help', 'Show help for a command.')
    .showHelpAfterError(false);

  const initRunner = options.runInit ?? runInitCommand;
  program
    .command('init')
    .description('Initialise Coodra in the current project (writes ~/.coodra/, .mcp.json, .coodra.json, .env).')
    .option('--project-slug <slug>', 'Project slug; derives from path.basename(cwd) when omitted.')
    .option('--ide <ide>', 'IDE to wire ("claude", "cursor", "windsurf", "codex", or "all").')
    .option(
      '--team',
      'On a team-mode machine: register this project under the team org (syncs to cloud). Default on a team machine; skips the interactive prompt.',
    )
    .option(
      '--solo',
      'On a team-mode machine: register this project as local-only (never synced to the team), even though the machine is in team mode.',
    )
    .option(
      '--graphify',
      "Module 09: wire Graphify's codebase-graph MCP server (structural-query tool) into the agent config(s). Skips the interactive prompt.",
    )
    .option('--no-graphify', "Module 09: don't wire Graphify; skip the interactive prompt.")
    .option(
      '--jira',
      "Module 09: wire Atlassian's Jira (Rovo) remote MCP server into the agent config(s). Skips the interactive prompt.",
    )
    .option('--no-jira', "Module 09: don't wire Jira; skip the interactive prompt.")
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
    .option(
      '--feature-pack <mode>',
      'How to seed docs/feature-packs/<slug>/. "template" (default) renders the 4-file template; ' +
        '"empty" creates the folder + .gitkeep only (populate via web upload or your own .md files); ' +
        '"skip" leaves the disk untouched. Use "empty" when you plan to upload via the web app to avoid ' +
        'having to tick "force overwrite" on every upload.',
    )
    .option('--no-feature-pack', "Shorthand for --feature-pack=skip. Don't create docs/feature-packs/<slug>/ at all.")
    .action(async (opts: InitOptions) => {
      await initRunner(opts, options.initIO);
    });

  const startRunner = options.runStart ?? runStartCommand;
  program
    .command('start')
    .description('Start MCP Server + Hooks Bridge + Web Dashboard (+ Sync Daemon in team mode) as background daemons.')
    .option('--no-mcp', 'Do not start the MCP server.')
    .option('--no-hooks', 'Do not start the Hooks Bridge.')
    .option('--no-sync', 'Do not start the Sync Daemon (team-mode only; ignored in solo mode).')
    .option('--no-web', 'Do not start the Web Dashboard (Next.js standalone on :3001).')
    .option(
      '--tunnel',
      'Spawn a Cloudflare quick-tunnel so the web is reachable cross-machine (requires `cloudflared` on PATH).',
    )
    .option('--foreground', 'Run attached for debugging (does not register the daemon manager unit).')
    .action(async (opts: StartOptions) => {
      await startRunner(opts, options.startIO);
    });

  const stopRunner = options.runStop ?? runStopCommand;
  program
    .command('stop')
    .description('Stop Coodra daemons. Idempotent.')
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

  const metricsRunner = options.runMetrics ?? runMetricsCommand;
  program
    .command('metrics')
    .alias('roi')
    .description(
      'Print Coodra ROI / value KPIs (knowledge captured, reuse, governance, modeled net value) for this machine.',
    )
    .option('--json', 'Emit structured JSON instead of human-readable text.')
    .option('--project <slug>', 'Limit the per-project breakdown to a single project slug.')
    .action(async (opts: MetricsOptions) => {
      await metricsRunner(opts, options.metricsIO);
    });

  const agentsRunner = options.runAgents ?? runAgentsCommand;
  program
    .command('agents')
    .description(
      'Show per-agent wiring status (Claude Code, Cursor, Windsurf, Codex). Read-only — use `coodra init` to wire and `coodra uninstall` to strip.',
    )
    .option('--json', 'Emit structured JSON instead of human-readable text.')
    .action(async (opts: AgentsOptions) => {
      await agentsRunner(opts, options.agentsIO);
    });

  // Module 09 Track 9B (ADR-010, Option C) — `coodra graphify
  // {enable,disable,status}` wires Graphify's own stdio MCP server into
  // the agent config(s). Coodra consumes Graphify by configuration, not
  // by code: the entry runs `python -m graphify.serve graphify-out/graph.json`.
  const graphifyEnableRunner = options.runGraphifyEnable ?? runGraphifyEnableCommand;
  const graphifyDisableRunner = options.runGraphifyDisable ?? runGraphifyDisableCommand;
  const graphifyStatusRunner = options.runGraphifyStatus ?? runGraphifyStatusCommand;
  const graphify = program
    .command('graphify')
    .description(
      "Wire Graphify's codebase-graph MCP server (a structural-query tool) into your agent config " +
        '(Claude Code / Cursor / Windsurf / Codex). Option C per ADR-010 / ADR-015 — Coodra consumes Graphify ' +
        'by configuration, not code, and mints no Feature Packs from it.',
    );
  graphify
    .command('enable')
    .description(
      'Add the `graphify` MCP server entry to each detected agent config so the agent can run structural queries. Idempotent; preserves the `coodra` entry and your edits.',
    )
    .option('--ide <ide>', 'IDE(s) to wire ("claude", "cursor", "windsurf", "codex", or "all"; comma-separated).')
    .option(
      '--python <path>',
      'Python interpreter for `-m graphify.serve`. Omit to auto-detect a verified graphifyy[mcp] interpreter (active venv → ./.venv → the `graphify` install → uv tool → python3); pass a path to pin one explicitly.',
    )
    .option('--graph <path>', 'Path to the Graphify graph JSON (default: graphify-out/graph.json).')
    .option('--force', 'Overwrite an existing drifted `graphify` entry with the baseline.')
    .option(
      '--install',
      'If no verified graphifyy[mcp] interpreter is found, install it into ./.venv without asking (creates the venv when absent).',
    )
    .option('--no-install', 'Never offer to install graphifyy[mcp]; wire the entry and print the manual steps.')
    .option('--dry-run', 'Report what would change without touching disk.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: GraphifyEnableOptions) => {
      await graphifyEnableRunner(opts, options.graphifyIO);
    });
  graphify
    .command('disable')
    .description(
      'Remove the `graphify` MCP server entry from each agent config. Idempotent. Leaves every other entry untouched.',
    )
    .option('--ide <ide>', 'IDE(s) to unwire ("claude", "cursor", "windsurf", "codex", or "all"; comma-separated).')
    .option('--dry-run', 'Report what would change without touching disk.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: GraphifyDisableOptions) => {
      await graphifyDisableRunner(opts, options.graphifyIO);
    });
  graphify
    .command('status')
    .description(
      'Show whether the `graphify` MCP entry is present in each agent config (Claude Code / Cursor / Windsurf / Codex). Read-only.',
    )
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: GraphifyStatusOptions) => {
      await graphifyStatusRunner(opts, options.graphifyIO);
    });

  // Module 10 (Deep Wiki) — `coodra wiki {generate,status,list,open,clean}`.
  // Coodra runs no LLM: `generate` writes a grounding snapshot + an authoring
  // recipe the user's coding agent runs against the wiki_* MCP tools; the
  // result lands in the local store and renders in the web app at /wiki.
  const wikiGenerateRunner = options.runWikiGenerate ?? runWikiGenerateCommand;
  const wikiStatusRunner = options.runWikiStatus ?? runWikiStatusCommand;
  const wikiListRunner = options.runWikiList ?? runWikiListCommand;
  const wikiOpenRunner = options.runWikiOpen ?? runWikiOpenCommand;
  const wikiCleanRunner = options.runWikiClean ?? runWikiCleanCommand;
  const wiki = program
    .command('wiki')
    .description(
      'Generate a DeepWiki-style, hierarchical/mind-map explanation of this codebase. Your coding agent (Claude ' +
        'Code / Codex / Cursor) is the model; Coodra ships the grounding, the MCP persistence tools, and the web render.',
    );
  wiki
    .command('generate')
    .description(
      'Write the codebase grounding snapshot + authoring recipe (.coodra/wiki-job.md) and scaffold the ' +
        'deep-wiki-author Feature, then tell your agent to build the wiki. Re-using the slug re-plans the wiki.',
    )
    .option('--slug <slug>', 'Wiki slug within the project (kebab-case; default: the project slug).')
    .option(
      '--mode <mode>',
      'Wiki shape: "comprehensive" (sections + pages) or "concise" (flat). Default comprehensive.',
    )
    .option('--force', 'Overwrite the deep-wiki-author Feature recipe if it already exists.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: WikiGenerateOptions) => {
      await wikiGenerateRunner(opts, options.wikiIO);
    });
  wiki
    .command('status')
    .description('Show Deep Wiki generation progress (pages authored vs pending) for this project. Read-only.')
    .option('--slug <slug>', 'Which wiki to report on (default: the project slug).')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: WikiStatusOptions) => {
      await wikiStatusRunner(opts, options.wikiIO);
    });
  wiki
    .command('list')
    .description('List the Deep Wikis for this project with their page counts. Read-only.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: WikiListOptions) => {
      await wikiListRunner(opts, options.wikiIO);
    });
  wiki
    .command('open')
    .description('Open the Deep Wiki view in the Coodra web app (must be running — `coodra start`).')
    .option('--web-url <url>', 'Base URL of the Coodra web app (default: $COODRA_WEB_URL or http://localhost:3001).')
    .option('--json', 'Print the URL as JSON instead of opening a browser.')
    .action(async (opts: WikiOpenOptions) => {
      await wikiOpenRunner(opts, options.wikiIO);
    });
  wiki
    .command('clean')
    .argument('<slug>', 'Wiki slug to delete (kebab-case).')
    .description('Delete a Deep Wiki and its pages from the local store. Irreversible.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (slug: string, opts: WikiCleanOptions) => {
      await wikiCleanRunner(slug, opts, options.wikiIO);
    });

  // Module 09 Track 9A (Jira = Direct, ADR-016) — `coodra jira
  // {enable,disable,status}` wires Atlassian's own remote MCP server
  // ("Rovo") into the agent config(s). Coodra consumes Jira by
  // configuration, not by code: the entry points the agent at
  // https://mcp.atlassian.com/v1/mcp/authv2 and the agent calls
  // Atlassian's own Jira tools. Native remote entry only — no mcp-remote
  // shim (decision 2026-05-31).
  const jiraEnableRunner = options.runJiraEnable ?? runJiraEnableCommand;
  const jiraDisableRunner = options.runJiraDisable ?? runJiraDisableCommand;
  const jiraStatusRunner = options.runJiraStatus ?? runJiraStatusCommand;
  const jira = program
    .command('jira')
    .description(
      "Wire Atlassian's Jira (Rovo) remote MCP server into your agent config " +
        '(Claude Code / Cursor / Windsurf / Codex). Direct per ADR-016 — Coodra consumes Jira ' +
        'by configuration, not code, and builds no Jira client, OAuth, or jira_* tools.',
    );
  jira
    .command('enable')
    .description(
      "Add the `atlassian` (Rovo) remote MCP server entry to each detected agent config so the agent can call Atlassian's Jira tools. Idempotent; preserves the `coodra` entry and your edits.",
    )
    .option('--ide <ide>', 'IDE(s) to wire ("claude", "cursor", "windsurf", "codex", or "all"; comma-separated).')
    .option('--force', 'Overwrite an existing drifted `atlassian` entry with the baseline.')
    .option('--dry-run', 'Report what would change without touching disk.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: JiraEnableOptions) => {
      await jiraEnableRunner(opts, options.jiraIO);
    });
  jira
    .command('disable')
    .description(
      'Remove the `atlassian` MCP server entry from each agent config. Idempotent. Leaves every other entry untouched.',
    )
    .option('--ide <ide>', 'IDE(s) to unwire ("claude", "cursor", "windsurf", "codex", or "all"; comma-separated).')
    .option('--dry-run', 'Report what would change without touching disk.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: JiraDisableOptions) => {
      await jiraDisableRunner(opts, options.jiraIO);
    });
  jira
    .command('status')
    .description(
      'Show whether the `atlassian` MCP entry is present in each agent config (Claude Code / Cursor / Windsurf / Codex). Read-only.',
    )
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: JiraStatusOptions) => {
      await jiraStatusRunner(opts, options.jiraIO);
    });

  // Phase G slice G.3 — top-level `coodra login` for browser-handoff auth.
  // The `team login` subcommand is kept as a backward-compat alias.
  const loginRunnerPhaseG = options.runLogin ?? runLoginCommand;
  program
    .command('login')
    .description('Browser-handoff Clerk login. Writes ~/.coodra/clerk-token.json and switches mode to team.')
    .option('--web-url <url>', 'Override the team-mode web URL (defaults to COODRA_WEB_URL or http://localhost:3001).')
    .option('--no-open', 'Print the sign-in URL instead of opening a browser (useful in headless shells).')
    .option('--timeout-ms <ms>', 'Override the browser-handoff timeout (default 300000 = 5 minutes).', (v) =>
      Number.parseInt(v, 10),
    )
    .action(async (opts: { webUrl?: string; open?: boolean; timeoutMs?: number }) => {
      const merged: LoginOptions = {
        ...(opts.webUrl !== undefined ? { webUrl: opts.webUrl } : {}),
        // Commander negates `--no-open` to `open: false`. We invert to noOpen.
        ...(opts.open === false ? { noOpen: true } : {}),
        ...(opts.timeoutMs !== undefined && Number.isInteger(opts.timeoutMs) ? { timeoutMs: opts.timeoutMs } : {}),
      };
      await loginRunnerPhaseG(merged, options.loginIO);
    });

  // Phase G slice G.10 — `coodra org` parent + status/switch.
  const orgStatusRunner = options.runOrgStatus ?? runOrgStatusCommand;
  const orgSwitchRunner = options.runOrgSwitch ?? runOrgSwitchCommand;
  const orgCmd = program
    .command('org')
    .description('Multi-org user commands. Status + switch the active Clerk org bound to this laptop.');
  orgCmd
    .command('status')
    .description('Print the active org (from clerk-token.json).')
    .action(async () => {
      await orgStatusRunner({}, options.orgIO);
    });
  orgCmd
    .command('switch')
    .argument('<orgSlug>', 'Slug of the target org. v1: informational; org picker opens in the browser.')
    .description('Switch the active org by re-running the browser login flow.')
    .option('--no-open', 'Print the sign-in URL instead of opening a browser.')
    .option('--timeout-ms <ms>', 'Override the browser-handoff timeout (default 300000).', (v) =>
      Number.parseInt(v, 10),
    )
    .action(async (orgSlug: string, opts: { open?: boolean; timeoutMs?: number }) => {
      const merged: OrgSwitchOptions = {
        targetOrgSlug: orgSlug,
        ...(opts.open === false ? { noOpen: true } : {}),
        ...(opts.timeoutMs !== undefined && Number.isInteger(opts.timeoutMs) ? { timeoutMs: opts.timeoutMs } : {}),
      };
      await orgSwitchRunner(merged, options.orgIO);
    });

  // Phase G slice G.4 — top-level `coodra logout`.
  const logoutRunnerPhaseG = options.runLogout ?? runLogoutCommand;
  program
    .command('logout')
    .description('Log out of team mode. Deletes clerk-token.json, demotes config to solo, strips team env keys.')
    .option('--force', 'Currently a no-op flag (logout is already idempotent).')
    .action(async (opts: { force?: boolean }) => {
      const merged: LogoutOptions = {
        ...(opts.force === true ? { force: true } : {}),
      };
      await logoutRunnerPhaseG(merged, options.logoutIO);
    });

  // Phase H.5 — top-level `coodra invite <email>`. Mints a team
  // invite from the CLI side, signed with COODRA_INVITE_HMAC_SECRET.
  // Prints a single shareable URL — the teammate doesn't need a separate
  // Clerk org-invitation email (Phase H.6 changes `/api/install` to
  // auto-add them to the org at redeem time).
  const inviteRunner = options.runInvite ?? runInviteCommand;
  program
    .command('invite')
    .description('Mint a team invite from the CLI. Prints a single shareable /install/<token> URL.')
    .argument('<email>', "Teammate's email address.")
    .option('--role <role>', 'admin | member | viewer (default: member)')
    .option('--expires-in-days <n>', '1-30 (default: 7)', (v) => Number.parseInt(v, 10))
    .option(
      '--web-url <url>',
      'Override the deployment URL the invite points at (default: $COODRA_PUBLIC_URL or http://localhost:3001).',
    )
    .action(async (email: string, opts: { role?: string; expiresInDays?: number; webUrl?: string }) => {
      const merged: InviteOptions = {
        ...(typeof opts.role === 'string' ? { role: opts.role } : {}),
        ...(typeof opts.expiresInDays === 'number' && Number.isInteger(opts.expiresInDays)
          ? { expiresInDays: opts.expiresInDays }
          : {}),
        ...(typeof opts.webUrl === 'string' ? { webUrl: opts.webUrl } : {}),
      };
      await inviteRunner(email, merged, options.inviteIO);
    });

  const doctorRunner = options.runDoctor ?? runDoctorCommand;
  program
    .command('doctor')
    .description(
      'Run health checks (read-only). Defaults to the 11 essential checks for the Claude Code + solo-mode path; ' +
        'use --full for the complete 35-check registry (debug invariants, team-mode probes, outbox observability, lifecycle invariants, M08b operational visibility).',
    )
    .option('--json', 'Emit structured JSON instead of human-readable text.')
    .option('--timeout-ms <ms>', 'Per-check timeout in milliseconds (default 2000).')
    .option('--full', 'Run every check in the registry, not just the essentials (dec_83ba10c1, 2026-05-02).')
    .option(
      '--fix',
      'After running checks, repair safe drift conditions: strip stale COODRA_MODE lines ' +
        "from every registered project's `.env` file (Phase A, clarity-pass-plan 2026-05-11). Idempotent.",
    )
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
      'Apply pending Drizzle migrations to ~/.coodra/data.db. Idempotent. Refuses if any daemon is alive (use --with-daemons-running to override).',
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
      'Backup ~/.coodra/data.db. Default = single-file VACUUM INTO snapshot. --include-logs switches to a tarball with logs + config.',
    )
    .option('--out <path>', 'Destination path (default: ~/.coodra/backups/data.db.bak.<ISO>.sqlite).')
    .option('--include-logs', 'Produce a .tar.gz containing data.db.bak + logs/*.log + config.json.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: DbBackupOptions) => {
      await dbBackupRunner(opts, options.dbBackupIO);
    });

  const dbRestoreRunner = options.runDbRestore ?? runDbRestoreCommand;
  db.command('restore <source>')
    .description(
      'Restore ~/.coodra/data.db from <source> (a SQLite file). Atomic replace + auto-backup of current DB. Refuses if any daemon is alive — no override.',
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
    .requiredOption('--project <slug>', 'Project slug (must already exist; run `coodra init` first).')
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
  // W5 / beta.5 — promote a solo project to the caller's verified Clerk org.
  const projectPromoteRunner = options.runProjectPromote ?? runProjectPromoteCommand;
  project
    .command('promote [identifier]')
    .description(
      'Promote a project from solo (__solo__) to your verified Clerk org so it syncs to cloud. Resolves [identifier] (slug or id), or <cwd>/.coodra.json when omitted. Use this when `coodra init` ran before `coodra team init` + `coodra login`.',
    )
    .option('--json', 'Emit a structured JSON report.')
    .action(async (identifier: string | undefined, opts: ProjectPromoteOptions) => {
      await projectPromoteRunner(identifier, opts, options.projectIO);
    });
  // W6 / beta.6 — demote a team project back to solo, but ONLY when it
  // has not yet synced (cloud-gated, refuses otherwise — see handler).
  const projectDemoteRunner = options.runProjectDemote ?? runProjectDemoteCommand;
  project
    .command('demote [identifier]')
    .description(
      'Demote a project from your team org back to solo (local-only). SAFE-ONLY: refuses if the project has already synced to cloud (split-brain risk) — it only works in the window before any data left this machine. Resolves [identifier] (slug or id) or <cwd>/.coodra.json.',
    )
    .option('--json', 'Emit a structured JSON report.')
    .action(async (identifier: string | undefined, opts: ProjectDemoteOptions) => {
      await projectDemoteRunner(identifier, opts, options.projectIO);
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

  // Module 08b S17 — template admin (list, install).
  const tmpl = program.command('template').description('Manage feature-pack templates (bundled + user-installed).');
  const templateListRunner = options.runTemplateList ?? runTemplateListCommand;
  tmpl
    .command('list')
    .description(
      'List every available template (bundled + user-installed). User templates with the same name shadow bundled.',
    )
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: TemplateListOptions) => {
      await templateListRunner(opts, options.templateIO);
    });
  const templateInstallRunner = options.runTemplateInstall ?? runTemplateInstallCommand;
  tmpl
    .command('install <source>')
    .description('Copy a local template directory into ~/.coodra/templates/<name>/ for re-use across projects.')
    .option('--name <override>', 'Install under a different name than the source template.json#name.')
    .option('--force', 'Overwrite an existing user template at this name.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (source: string, opts: TemplateInstallOptions) => {
      await templateInstallRunner(source, opts, options.templateIO);
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

  // 2026-05-08 — features admin (skill-style knowledge units under
  // docs/features/<slug>/). The mutating subcommands always re-index
  // on success; consumers (bridge, MCP, web) read INDEX.json so users
  // never have to remember to run `feature index` after a normal
  // add/remove/edit.
  const feature = program
    .command('feature')
    .description('Manage docs/features/<slug>/ — skill-style knowledge units the agent loads on demand.');

  const featureAddRunner = options.runFeatureAdd ?? runFeatureAddCommand;
  feature
    .command('add <slug>')
    .description(
      'Scaffold a new feature at docs/features/<slug>/feature.md with frontmatter + body template. Auto-runs `feature index` on success.',
    )
    .option(
      '--description <text>',
      'Trigger description for the new feature (the "Use this when..." sentence the agent reads).',
    )
    .option('--maturity <level>', 'Initial maturity tag: draft (default) | beta | stable | deprecated.')
    .option('--force', 'Overwrite an existing feature.md.')
    .option('--cwd <dir>', 'Override the project root (defaults to process.cwd()).')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (slug: string, opts: FeatureAddOptions) => {
      await featureAddRunner(slug, opts, options.featureIO);
    });

  const featureListRunner = options.runFeatureList ?? runFeatureListCommand;
  feature
    .command('list')
    .description('List every feature under docs/features/, with description + file count + warnings.')
    .option('--cwd <dir>', 'Override the project root.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: FeatureBaseOptions) => {
      await featureListRunner(opts, options.featureIO);
    });

  const featureShowRunner = options.runFeatureShow ?? runFeatureShowCommand;
  feature
    .command('show <slug>')
    .description('Print one feature — frontmatter, body, supporting file tree, validation warnings.')
    .option('--cwd <dir>', 'Override the project root.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (slug: string, opts: FeatureBaseOptions) => {
      await featureShowRunner(slug, opts, options.featureIO);
    });

  const featureEditRunner = options.runFeatureEdit ?? runFeatureEditCommand;
  feature
    .command('edit <slug>')
    .description('Open feature.md in $VISUAL / $EDITOR. Re-validates + regenerates the index after the editor exits.')
    .option('--cwd <dir>', 'Override the project root.')
    .action(async (slug: string, opts: FeatureBaseOptions) => {
      await featureEditRunner(slug, opts, options.featureIO);
    });

  const featureIndexRunner = options.runFeatureIndex ?? runFeatureIndexCommand;
  feature
    .command('index')
    .description(
      'Regenerate INDEX.md + INDEX.json from disk. Idempotent; safe to run repeatedly. Use after editing files outside the CLI / web (git pull, sibling tools, hand edits).',
    )
    .option('--cwd <dir>', 'Override the project root.')
    .option('--json', 'Emit a structured JSON report.')
    .action(async (opts: FeatureBaseOptions) => {
      await featureIndexRunner(opts, options.featureIO);
    });

  const featureRemoveRunner = options.runFeatureRemove ?? runFeatureRemoveCommand;
  feature
    .command('remove <slug>')
    .description('Delete docs/features/<slug>/ from disk. Auto-regenerates the index. Refuses without --force.')
    .option('--force', 'Confirm the destructive delete (required).')
    .option('--cwd <dir>', 'Override the project root.')
    .action(async (slug: string, opts: FeatureRemoveOptions) => {
      await featureRemoveRunner(slug, opts, options.featureIO);
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
      'Reverse `coodra init`: remove `__coodra__` matchers from ~/.claude/settings.json + `coodra` server from .mcp.json. Default-safe (preserves data + config + feature/context packs); --purge removes ~/.coodra/.',
    )
    .option('--purge', 'Remove ~/.coodra/ as well (data + config + logs + pids).')
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
      'Check for a newer @coodra/cli on npm. Does NOT self-update — prints the install command. After install, re-run to apply migrations + restart daemons.',
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
      'Tail or print recent lines from ~/.coodra/logs/<service>.log. Pure file-read; no DB. Service ∈ {mcp-server, hooks-bridge, sync-daemon, web}.',
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
      'Pause Coodra enforcement on the local machine via a row in `kill_switches`. Hard mode (default) denies; soft mode allows + audits. Local-only (M08b OQ-8); cross-developer sync is M04.',
    )
    .option('--scope <scope>', 'global | project | tool | agent_type (default: global)')
    .option('--target <value>', 'projectSlug | toolName | agentType (required when --scope != global)')
    .option('--mode <mode>', 'hard | soft (default: hard, per OQ-1)')
    .option('--reason <reason>', 'Operator audit context (recommended; auto-generated if omitted)')
    .option('--expires-in <duration>', 'Auto-resume after duration (e.g. 5m, 1h, 24h, 7d, 1d6h)')
    .option(
      '--no-sync',
      'M04 S8a: skip the paired sync_to_cloud enqueue. Local-only kill switch — does not propagate to other developers via sync-daemon. (Solo mode is local-only regardless.)',
    )
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

  // Phase G — `team login` is a backward-compat alias for `coodra login`.
  // The legacy `[token]` argument and `--server` flag are accepted but
  // ignored; the new flow captures the token via browser handoff.
  team
    .command('login')
    .argument('[token]', '[deprecated] ignored — Phase G captures the token via browser handoff.')
    .option('--server <url>', '[deprecated] use --web-url on `coodra login` instead.')
    .description('[alias for `coodra login`] Browser-handoff Clerk login.')
    .action(async (_token: string | undefined, opts: { server?: string }) => {
      const merged: LoginOptions = {
        ...(opts.server !== undefined ? { webUrl: opts.server } : {}),
      };
      await loginRunnerPhaseG(merged, options.loginIO);
    });

  // Phase G — `team logout` is a backward-compat alias for `coodra logout`.
  team
    .command('logout')
    .description('[alias for `coodra logout`] Log out of team mode.')
    .action(async () => {
      await logoutRunnerPhaseG({}, options.logoutIO);
    });

  // Module 04 Phase 4 — three new team commands.
  const migrateRunner = options.runTeamMigrate ?? runTeamMigrateCommand;
  team
    .command('migrate')
    .description('Move local solo-mode data into the team cloud (idempotent + resumable).')
    .option('--user-id <id>', 'Clerk user id (or env COODRA_TEAM_USER_ID).')
    .option('--org-id <id>', 'Clerk org id (or env COODRA_TEAM_ORG_ID).')
    .option('--secret <hex>', 'Local hook secret (or env COODRA_TEAM_HOOK_SECRET).')
    .option('--database-url <url>', 'Cloud Postgres URL (or env DATABASE_URL).')
    .option('--yes', 'Skip the dry-run prompt and execute the migration.')
    .option('--resume', 'Resume an in-flight migration from the last successfully-completed phase.')
    .option('--rollback', 'Roll back the most-recent in-flight migration and restore the local snapshot.')
    .action(async (opts: TeamMigrateOptions) => {
      await migrateRunner(opts, options.teamIO);
    });

  // Phase G slice G.5 — `team join <invite-url>` is the canonical
  // teammate onboarding command. Replaces the legacy flag-driven flow.
  // The legacy flag-driven flow lives at `team join-migrate` for users
  // who already have credentials from a prior `team setup`.
  const teamJoinInviteRunner = options.runTeamJoinInvite ?? runTeamJoinInviteCommand;
  const legacyJoinRunner = options.runTeamJoin ?? runTeamJoinCommand;
  team
    .command('join')
    .argument('[invite-url]', 'Phase G — invite URL from /settings/team. Browser-handoff flow.')
    .description(
      'Join an existing team via an invite URL. Performs browser-based Clerk sign-in, ' +
        'verifies email matches the invite, fetches install bundle, and writes ~/.coodra/{config.json,.env,clerk-token.json}.',
    )
    // Legacy flag-driven flow (pre-Phase-G). Mutually exclusive with <invite-url>.
    .option('--user-id <id>', '[legacy] Clerk user id (or env COODRA_TEAM_USER_ID).')
    .option('--org-id <id>', '[legacy] Clerk org id (or env COODRA_TEAM_ORG_ID).')
    .option('--org-slug <slug>', '[legacy] Optional Clerk org slug for display.')
    .option('--secret <hex>', '[legacy] Local hook secret (or env COODRA_TEAM_HOOK_SECRET).')
    .option('--database-url <url>', '[legacy] Cloud Postgres URL (or env DATABASE_URL).')
    .option('--no-open', 'Print the sign-in URL instead of opening a browser (Phase G mode).')
    .option('--timeout-ms <ms>', 'Override the browser-handoff timeout (default 300000).', (v) =>
      Number.parseInt(v, 10),
    )
    .action(async (inviteUrl: string | undefined, opts: TeamJoinOptions & { open?: boolean; timeoutMs?: number }) => {
      const hasInvite = inviteUrl !== undefined && inviteUrl.length > 0;
      const hasLegacyFlags =
        opts.userId !== undefined ||
        opts.orgId !== undefined ||
        opts.databaseUrl !== undefined ||
        opts.secret !== undefined;
      if (hasInvite) {
        // Phase G — invite-URL flow
        const merged: TeamJoinInviteOptions = {
          inviteUrl,
          ...(opts.open === false ? { noOpen: true } : {}),
          ...(opts.timeoutMs !== undefined && Number.isInteger(opts.timeoutMs) ? { timeoutMs: opts.timeoutMs } : {}),
        };
        await teamJoinInviteRunner(merged, options.teamJoinInviteIO);
      } else if (hasLegacyFlags) {
        // Legacy flag-driven flow
        await legacyJoinRunner(opts, options.teamIO);
      } else {
        // Neither — Phase G is the default. Surface the Phase G usage
        // hint rather than the legacy flag-error.
        await teamJoinInviteRunner({}, options.teamJoinInviteIO);
      }
    });

  const leaveRunner = options.runTeamLeave ?? runTeamLeaveCommand;
  team
    .command('leave')
    .description(
      'Demote the local config back to solo mode (cloud data untouched). Prompts for ' +
        'a typed confirmation (`leave <orgname>`) unless --yes is passed.',
    )
    .option('--yes', 'Skip the typed-confirmation prompt (for CI / automation).')
    .action(async (opts: TeamLeaveOptions) => {
      await leaveRunner(opts, options.teamIO);
    });

  // Phase B (clarity-pass-plan, 2026-05-11) — guided admin onboarding
  // wizard. Replaces `team setup`'s six-flag interface with a three-
  // step interactive flow (Postgres → Clerk → Local). The legacy
  // `team setup` remains for CI / automation.
  const teamInitRunner = options.runTeamInit ?? runTeamInitCommand;
  team
    .command('init')
    .description(
      'Guided team-mode bootstrap. Walks you through Postgres + Clerk + local config in three interactive ' +
        'steps. Recommended starting point for first-time admin setup; prefer over `team setup` (which uses six ' +
        'flags and is intended for CI).',
    )
    .option('--database-url <url>', 'Pre-fill DATABASE_URL (skips the Postgres prompt).')
    .option('--clerk-secret-key <key>', 'Pre-fill Clerk Secret Key (skips the Clerk prompt).')
    .option(
      '--clerk-publishable-key <key>',
      'Pre-fill Clerk Publishable Key (Phase H — required for JWT verification).',
    )
    .option('--org-id <id>', 'Pre-select the Clerk org (skips the org-picker prompt).')
    .option('--skip-pgvector', 'Skip CREATE EXTENSION vector (use when role lacks privileges).')
    .option('--yes-reinit', 'Skip the "already in team mode — re-init?" prompt (CI only).')
    .option(
      '--no-login',
      'Phase H — skip chaining into the browser-based coodra login at the end. Use only for CI/tests; admin manually runs `coodra login` after.',
    )
    .action(async (opts: TeamInitOptions & { login?: boolean }) => {
      // Commander negates `--no-login` into `login: false`. Translate
      // to our internal `noLogin` flag.
      const merged: TeamInitOptions = {
        ...opts,
        ...(opts.login === false ? { noLogin: true } : {}),
      };
      delete (merged as { login?: boolean }).login;
      await teamInitRunner(merged, options.teamIO);
    });

  // Module 04 Phase 4 — admin bootstrap (legacy six-flag interface).
  // Run ONCE per team after creating your own Supabase / Postgres
  // project. Validates connectivity, installs pgvector, applies
  // migrations, generates a local hook secret, prints credentials for
  // teammates' `team join`. `team init` is the preferred interactive
  // counterpart for first-time admin use.
  const setupRunner = options.runTeamSetup ?? runTeamSetupCommand;
  team
    .command('setup')
    .description(
      'Bootstrap a team — runs against your own Supabase/Postgres. ' +
        'Verifies connectivity, installs pgvector, applies schema, prints credentials to share.',
    )
    .option('--user-id <id>', 'Your Clerk user id (or env COODRA_TEAM_USER_ID).')
    .option('--org-id <id>', 'Your Clerk org id (or env COODRA_TEAM_ORG_ID).')
    .option('--org-slug <slug>', 'Optional Clerk org slug for display.')
    .option('--secret <hex>', 'Local hook secret to use (or generate fresh 32-byte hex if absent).')
    .option('--database-url <url>', 'Cloud Postgres URL (or env DATABASE_URL).')
    .option('--skip-pgvector', 'Skip CREATE EXTENSION vector (use when role lacks privileges).')
    .option('--json', 'Print credentials as JSON instead of human-formatted prose.')
    .action(async (opts: TeamSetupOptions) => {
      await setupRunner(opts, options.teamIO);
    });

  // Module 04 Phase 2 — teammate-side counterpart to `team setup`.
  // Redeems a signed bootstrap URL (`/api/install/<token>` on the
  // admin's deployment) and writes ~/.coodra/config.json + .env.
  // Single-use; one invocation consumes the token at the server.
  const installRunner = options.runTeamInstall ?? runTeamInstallCommand;
  team
    .command('install')
    .description(
      'Join an existing team via a one-click invite. Provided by your admin from /settings/team. ' +
        'Writes ~/.coodra/config.json + .env. Single-use — re-running on a new machine requires a fresh invite.',
    )
    .option('--bootstrap-url <url>', 'Signed bootstrap URL from the invite email or /install/<token> page.')
    .option('--json', 'Print the result as JSON (suppresses human-formatted welcome message).')
    .action(async (opts: TeamInstallOptions) => {
      await installRunner(opts, options.teamIO);
    });

  // Interactive terminal UI — the tabbed terminal/commands/status app.
  // Launched explicitly via `coodra ui`, or by `coodra` with no
  // arguments at all (handled in `index.ts`, before commander parses,
  // so the no-args path can branch on TTY without commander's default
  // action turning the root program into a strict-arity command). The
  // TUI module is behind a dynamic `import()` so React + Ink never load
  // on the hot path of a one-shot command. Registered last so it lists
  // last in `--help`.
  program
    .command('ui')
    .description('Launch the interactive Coodra terminal UI (tabs: terminal · commands · status).')
    .action(async () => {
      const { launchTui } = await import('./tui/index.js');
      await launchTui();
    });

  return program;
}
