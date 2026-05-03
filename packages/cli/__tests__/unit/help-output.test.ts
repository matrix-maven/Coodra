import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/program.js';
import { VERSION } from '../../src/version.js';

/**
 * Snapshot-locked help text. The CLI's help output is part of the user
 * contract — reviewers see exactly what changes here in PRs. If a slice
 * intentionally changes the surface, update the snapshot in the same commit.
 */
describe('contextos --help (snapshot-locked surface)', () => {
  it('renders the top-level program help text', () => {
    const program = buildProgram();
    const help = program.helpInformation();
    expect(help).toMatchInlineSnapshot(`
      "Usage: contextos [options] [command]

      ContextOS CLI — install, configure, run, and diagnose ContextOS on your machine.

      Options:
        -v, --version             Print the @coodra/contextos-cli version and exit.
        -h, --help                Show help for a command.

      Commands:
        init [options]            Initialise ContextOS in the current project (writes
                                  ~/.contextos/, .mcp.json, .contextos.json, .env).
        start [options]           Start MCP Server + Hooks Bridge (+ Sync Daemon in
                                  team mode) as background daemons.
        stop [options]            Stop ContextOS daemons. Idempotent.
        status [options]          Print unified project + service state for the
                                  current cwd.
        doctor [options]          Run health checks (read-only). Defaults to the 11
                                  essential checks for the Claude Code + solo-mode
                                  path; use --full for the complete 30-check registry
                                  (debug invariants, team-mode probes, outbox
                                  observability, lifecycle invariants).
        cloud-migrate [options]   Apply Drizzle Postgres migrations to the cloud
                                  DATABASE_URL (team-mode self-host). Idempotent.
                                  Refuses to run if unknown tables contain data — see
                                  Module 04a OQ4.
        logs [options] <service>  Tail or print recent lines from
                                  ~/.contextos/logs/<service>.log. Pure file-read; no
                                  DB. Service ∈ {mcp-server, hooks-bridge,
                                  sync-daemon}.
        pause [options]           Pause ContextOS enforcement on the local machine via
                                  a row in \`kill_switches\`. Hard mode (default)
                                  denies; soft mode allows + audits. Local-only (M08b
                                  OQ-8); cross-developer sync is M04.
        resume [options]          Resume one or more active kill switches. Use --id,
                                  --all, or --scope[/--target].
        team                      Team-mode commands. Bodies land when team mode is
                                  reachable end-to-end (post-Module 04).
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

  it('renders team login subcommand help with [token] and --server', () => {
    const program = buildProgram();
    const team = program.commands.find((c) => c.name() === 'team');
    const login = team?.commands.find((c) => c.name() === 'login');
    expect(login).toBeDefined();
    const help = login?.helpInformation() ?? '';
    expect(help).toContain('[token]');
    expect(help).toContain('--server <url>');
    // Commander wraps long descriptions, so match across whitespace.
    expect(help).toMatch(/Stub\s+in\s+08a/);
  });
});

describe('contextos --version', () => {
  it('returns the VERSION constant (sourced from package.json via prebuild)', () => {
    const program = buildProgram();
    expect(program.version()).toBe(VERSION);
  });

  it('VERSION is a valid semver-shaped string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/);
  });
});
