import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/program.js';
import { VERSION } from '../../src/version.js';

/**
 * Snapshot-locked help text. The CLI's help output is part of the user
 * contract — reviewers see exactly what changes here in PRs. If a slice
 * intentionally changes the surface, update the snapshot in the same commit.
 */
describe('coodra --help (snapshot-locked surface)', () => {
  it('renders the top-level program help text', () => {
    const program = buildProgram();
    const help = program.helpInformation();
    expect(help).toMatchInlineSnapshot(`
      "Usage: coodra [options] [command]

      Coodra CLI — install, configure, run, and diagnose Coodra on your machine.

      Options:
        -v, --version             Print the @coodra/cli version and exit.
        -h, --help                Show help for a command.

      Commands:
        init [options]            Initialise Coodra in the current project (writes
                                  ~/.coodra/, .mcp.json, .coodra.json, .env).
        start [options]           Start MCP Server + Hooks Bridge + Web Dashboard (+
                                  Sync Daemon in team mode) as background daemons.
        stop [options]            Stop Coodra daemons. Idempotent.
        status [options]          Print unified project + service state for the
                                  current cwd.
        agents [options]          Show per-agent wiring status (Claude Code, Cursor,
                                  Windsurf, Codex). Read-only — use \`coodra init\` to
                                  wire and \`coodra uninstall\` to strip.
        graphify                  Wire Graphify's codebase-graph MCP server (a
                                  structural-query tool) into your agent config
                                  (Claude Code / Cursor / Windsurf / Codex). Option C
                                  per ADR-010 / ADR-015 — Coodra consumes Graphify by
                                  configuration, not code, and mints no Feature Packs
                                  from it.
        wiki                      Generate a DeepWiki-style, hierarchical/mind-map
                                  explanation of this codebase. Your coding agent
                                  (Claude Code / Codex / Cursor) is the model; Coodra
                                  ships the grounding, the MCP persistence tools, and
                                  the web render.
        jira                      Wire Atlassian's Jira (Rovo) remote MCP server into
                                  your agent config (Claude Code / Cursor / Windsurf /
                                  Codex). Direct per ADR-016 — Coodra consumes Jira by
                                  configuration, not code, and builds no Jira client,
                                  OAuth, or jira_* tools.
        login [options]           Browser-handoff Clerk login. Writes
                                  ~/.coodra/clerk-token.json and switches mode to
                                  team.
        org                       Multi-org user commands. Status + switch the active
                                  Clerk org bound to this laptop.
        logout [options]          Log out of team mode. Deletes clerk-token.json,
                                  demotes config to solo, strips team env keys.
        invite [options] <email>  Mint a team invite from the CLI. Prints a single
                                  shareable /install/<token> URL.
        doctor [options]          Run health checks (read-only). Defaults to the 11
                                  essential checks for the Claude Code + solo-mode
                                  path; use --full for the complete 35-check registry
                                  (debug invariants, team-mode probes, outbox
                                  observability, lifecycle invariants, M08b
                                  operational visibility).
        cloud-migrate [options]   Apply Drizzle Postgres migrations to the cloud
                                  DATABASE_URL (team-mode self-host). Idempotent.
                                  Refuses to run if unknown tables contain data — see
                                  Module 04a OQ4.
        db                        Database administration: migrate / backup / restore
                                  the local SQLite primary store.
        policy                    Manage policies + policy_rules in the local SQLite
                                  store.
        project                   Manage project rows in the local SQLite store.
        export [options] <runId>  Render one run as markdown / json / html / slack.
                                  Read-only. Per OQ-7, non-JSON formats exclude the
                                  policy_decisions audit trail by default;
                                  --include-audit opts in. JSON always includes the
                                  audit.
        template                  Manage feature-pack templates (bundled +
                                  user-installed).
        pack                      Manage docs/feature-packs/<slug>/ directories.
        feature                   Manage docs/features/<slug>/ — skill-style knowledge
                                  units the agent loads on demand.
        run                       Inspect + cancel rows in the \`runs\` table.
        uninstall [options]       Reverse \`coodra init\`: remove \`__coodra__\` matchers
                                  from ~/.claude/settings.json + \`coodra\` server from
                                  .mcp.json. Default-safe (preserves data + config +
                                  feature/context packs); --purge removes ~/.coodra/.
        upgrade [options]         Check for a newer @coodra/cli on npm. Does NOT
                                  self-update — prints the install command. After
                                  install, re-run to apply migrations + restart
                                  daemons.
        logs [options] <service>  Tail or print recent lines from
                                  ~/.coodra/logs/<service>.log. Pure file-read; no DB.
                                  Service ∈ {mcp-server, hooks-bridge, sync-daemon,
                                  web}.
        pause [options]           Pause Coodra enforcement on the local machine via a
                                  row in \`kill_switches\`. Hard mode (default) denies;
                                  soft mode allows + audits. Local-only (M08b OQ-8);
                                  cross-developer sync is M04.
        resume [options]          Resume one or more active kill switches. Use --id,
                                  --all, or --scope[/--target].
        team                      Team-mode commands. Bodies land when team mode is
                                  reachable end-to-end (post-Module 04).
        ui                        Launch the interactive Coodra terminal UI (tabs:
                                  terminal · commands · status).
        help [command]            display help for command
      "
    `);
  });

  it('renders init subcommand help with the documented flags', () => {
    const program = buildProgram();
    const init = program.commands.find((c) => c.name() === 'init');
    expect(init).toBeDefined();
    const help = init?.helpInformation() ?? '';
    expect(help).toContain('--project-slug <slug>');
    expect(help).toContain('--ide <ide>');
    expect(help).toContain('--no-graphify');
    expect(help).toContain('--dry-run');
    expect(help).toContain('--force');
    expect(help).toContain('Overwrite existing files with the baseline');
  });

  it('renders doctor subcommand help with --json and --timeout-ms', () => {
    const program = buildProgram();
    const doctor = program.commands.find((c) => c.name() === 'doctor');
    expect(doctor).toBeDefined();
    const help = doctor?.helpInformation() ?? '';
    expect(help).toContain('--json');
    expect(help).toContain('--timeout-ms <ms>');
    expect(help).toContain('Run health checks (read-only)');
  });

  it('renders team login subcommand help with deprecated [token] and --server flags (Phase G alias)', () => {
    const program = buildProgram();
    const team = program.commands.find((c) => c.name() === 'team');
    const login = team?.commands.find((c) => c.name() === 'login');
    expect(login).toBeDefined();
    const help = login?.helpInformation() ?? '';
    expect(help).toContain('[token]');
    expect(help).toContain('--server <url>');
    // Phase G — `team login` is now an alias for `coodra login`. The
    // help text marks the legacy args as deprecated.
    expect(help).toMatch(/alias for `coodra login`/);
    expect(help).toMatch(/deprecated/);
  });

  it('renders top-level login subcommand help (Phase G slice G.3)', () => {
    const program = buildProgram();
    const login = program.commands.find((c) => c.name() === 'login');
    expect(login).toBeDefined();
    const help = login?.helpInformation() ?? '';
    expect(help).toMatch(/Browser-handoff Clerk login/);
    expect(help).toContain('--web-url <url>');
    expect(help).toContain('--no-open');
    expect(help).toContain('--timeout-ms <ms>');
  });
});

describe('coodra --version', () => {
  it('returns the VERSION constant (sourced from package.json via prebuild)', () => {
    const program = buildProgram();
    expect(program.version()).toBe(VERSION);
  });

  it('VERSION is a valid semver-shaped string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/);
  });
});
