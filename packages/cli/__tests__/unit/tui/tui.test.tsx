import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../../src/program.js';
import { App } from '../../../src/tui/App.js';
import {
  ALL_CATALOG_COMMANDS,
  CATALOG_COMMAND_COUNT,
  COMMAND_CATALOG,
  findPlaceholderToken,
  isInteractiveCommand,
  isKnownCommand,
  parseCommandInput,
  resolveCatalogCommand,
} from '../../../src/tui/command-catalog.js';
import type { TuiContext } from '../../../src/tui/context.js';
import { runCommandInProcess } from '../../../src/tui/run-command.js';
import { VERSION } from '../../../src/version.js';

function plain(s: string | undefined): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR escapes.
  return (s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}

const FAKE_CTX: TuiContext = {
  version: '0.1.0-beta.8',
  cwd: '/tmp/my-awesome-app',
  coodraHome: '/tmp/.coodra',
  mode: 'solo',
  orgSlug: null,
  projectSlug: 'my-awesome-app',
};

describe('command catalog', () => {
  it('covers every command in the real program surface — nothing missing or invented', () => {
    // Derive the program's command set and assert the catalog matches it exactly.
    const program = buildProgram();
    const programCommands = new Set<string>();
    for (const top of program.commands) {
      if (top.name() === 'help') continue;
      if (top.commands.length > 0) {
        for (const sub of top.commands) programCommands.add(`${top.name()} ${sub.name()}`);
      } else {
        programCommands.add(top.name());
      }
    }
    const catalogCommands = new Set(ALL_CATALOG_COMMANDS.map((c) => c.argv.join(' ')));
    expect(catalogCommands).toEqual(programCommands);
    expect(ALL_CATALOG_COMMANDS.length).toBe(CATALOG_COMMAND_COUNT);
  });

  it('recognises EVERY top-level program command — a CATEGORY_OF omission must fail here', () => {
    // 2026-07-24 QA: six command groups (metrics, agent, files, graphify,
    // jira, wiki) were missing from CATEGORY_OF. The catalog still listed
    // them (via the ?? 'lifecycle' fallback) but `isKnownCommand` returned
    // false, so the Terminal view REJECTED commands the catalog itself
    // offered. This asserts the map covers the real program surface.
    const program = buildProgram();
    for (const top of program.commands) {
      if (top.name() === 'help') continue;
      expect(isKnownCommand([top.name()]), `top-level command '${top.name()}' missing from CATEGORY_OF`).toBe(true);
    }
  });

  it('runs a formerly-unwired command group in-process without killing the process', async () => {
    // Companion to the CATEGORY_OF fix: these groups' IO also was not wired
    // in run-command.ts, so their default `process.exit()` would have
    // terminated the TUI. `files status --json` exercises one of the eight
    // newly-wired groups end-to-end (read-only).
    const result = await runCommandInProcess(['files', 'status', '--json']);
    expect(result.crashed).toBe(false);
    const parsed = JSON.parse(result.stdout) as { ok: unknown };
    expect(parsed).toHaveProperty('ok');
  });

  it('groups into ordered /NN categories with no empty group', () => {
    expect(COMMAND_CATALOG.length).toBeGreaterThan(0);
    expect(COMMAND_CATALOG.every((c) => c.commands.length > 0)).toBe(true);
    // /NN numbers are sequential from 01.
    expect(COMMAND_CATALOG.map((c) => c.num)).toEqual(COMMAND_CATALOG.map((_, i) => String(i + 1).padStart(2, '0')));
  });

  it('flags interactive commands (need their own terminal); everything else runs in-process', () => {
    const interactive = ALL_CATALOG_COMMANDS.filter((c) => c.interactive).map((c) => c.id);
    // readline-prompt / browser-handoff commands are interactive.
    expect(interactive).toContain('init');
    expect(interactive).toContain('login');
    expect(interactive).toContain('db-restore');
    expect(interactive).toContain('team-init');
    expect(interactive).toContain('org-switch');
    // prompt-gated on stdin.isTTY (true under Ink raw mode) — must be
    // flagged interactive or the TUI would fight Ink for stdin and hang.
    expect(interactive).toContain('files-clean');
    // a normal mutating command is NOT interactive — the TUI runs it in-process.
    expect(ALL_CATALOG_COMMANDS.find((c) => c.id === 'pause')?.interactive).toBe(false);
    expect(ALL_CATALOG_COMMANDS.find((c) => c.id === 'doctor')?.interactive).toBe(false);
    expect(ALL_CATALOG_COMMANDS.find((c) => c.id === 'uninstall')?.interactive).toBe(false);
    expect(ALL_CATALOG_COMMANDS.find((c) => c.id === 'db-migrate')?.interactive).toBe(false);
    expect(ALL_CATALOG_COMMANDS.find((c) => c.id === 'files-status')?.interactive).toBe(false);
    expect(ALL_CATALOG_COMMANDS.find((c) => c.id === 'graphify-build')?.interactive).toBe(false);
  });

  it('parses + resolves typed input, and recognises interactive / known commands', () => {
    expect(parseCommandInput('  coodra   run   list  ')).toEqual(['run', 'list']);
    expect(parseCommandInput('status')).toEqual(['status']);
    expect(resolveCatalogCommand('status')?.id).toBe('status');
    expect(resolveCatalogCommand('coodra run list')?.id).toBe('run-list');
    expect(resolveCatalogCommand('coodra export run_abc')?.id).toBe('export');
    expect(resolveCatalogCommand('not-a-command')).toBeNull();

    expect(isInteractiveCommand(['team', 'init'])).toBe(true);
    expect(isInteractiveCommand(['login'])).toBe(true);
    expect(isInteractiveCommand(['doctor'])).toBe(false);
    expect(isInteractiveCommand(['pause'])).toBe(false);

    expect(isKnownCommand(['status'])).toBe(true);
    expect(isKnownCommand(['bogus'])).toBe(false);
  });
});

describe('runCommandInProcess', () => {
  it('captures --version output without exiting the process', async () => {
    const result = await runCommandInProcess(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.crashed).toBe(false);
    // Assert against the VERSION constant — survives version bumps.
    expect(result.stdout).toContain(VERSION);
  });

  it('captures subcommand help text', async () => {
    const result = await runCommandInProcess(['doctor', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Run health checks');
  });

  it('reports an unknown command as a non-zero exit, not a throw', async () => {
    const result = await runCommandInProcess(['definitely-not-a-command']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/unknown command|error/i);
  });

  it('runs `status --json` and produces parseable JSON', async () => {
    const result = await runCommandInProcess(['status', '--json']);
    // status exits 0/1/2 depending on service health — all are "ran fine".
    expect(result.crashed).toBe(false);
    const parsed = JSON.parse(result.stdout) as { project: unknown; services: unknown };
    expect(parsed).toHaveProperty('project');
    expect(parsed).toHaveProperty('services');
  });
});

describe('<App>', () => {
  it('renders the chrome, the splash, and the terminal footer', () => {
    const frame = plain(render(<App ctx={FAKE_CTX} />).lastFrame());
    // top bar
    expect(frame).toContain('coodra');
    expect(frame).toContain('/01 terminal');
    expect(frame).toContain('/02 commands');
    expect(frame).toContain('/03 status');
    expect(frame).toContain('solo · my-awesome-app');
    // splash body
    expect(frame).toContain('Master the context.');
    expect(frame).toContain('/01  TRY');
    expect(frame).toContain('/02  CONTROLS');
    // footer hints for the terminal tab
    expect(frame).toContain('switch views');
    expect(frame).toContain('quit');
  });

  it('switches to the commands catalog on tab', async () => {
    const { stdin, lastFrame } = render(<App ctx={FAKE_CTX} />);
    stdin.write('\t');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const frame = plain(lastFrame());
    // The catalog is a scroll window; the top of it shows from the
    // initial selection (index 0, in /01 lifecycle).
    expect(frame).toContain('/01  LIFECYCLE');
    expect(frame).toContain('coodra init');
    expect(frame).toContain('insert in terminal');
  });
});

describe('placeholder guard', () => {
  // The bug we fixed in 0.2.0-beta.1: selecting `coodra export <runId>`
  // from the catalog used to inject the literal `<runId>` into the
  // prompt, and pressing ⏎ ran the command with `<runId>` as the actual
  // value. The fix has two parts: (1) the catalog inserts the
  // placeholder-free `coodra export ` prefix, and (2) the terminal
  // refuses to run any argv whose tokens still match `<…>` / `[…]`.
  it('catalog entries with placeholders are still correctly listed', () => {
    // The /02 view shows `coodra export <runId>` so the user knows what
    // to type — but `argv` does NOT contain the placeholder.
    const exportCmd = ALL_CATALOG_COMMANDS.find((c) => c.id === 'export');
    expect(exportCmd).toBeDefined();
    expect(exportCmd?.display).toContain('<runId>');
    expect(exportCmd?.argv).toEqual(['export']);
  });

  it('findPlaceholderToken detects required + optional positionals; returns null for real values', () => {
    expect(findPlaceholderToken(['export', '<runId>'])).toBe('<runId>');
    expect(findPlaceholderToken(['work', 'import-jira', '<issueKey>'])).toBe('<issueKey>');
    expect(findPlaceholderToken(['logs', '[service]'])).toBe('[service]');
    expect(findPlaceholderToken(['export', 'run_abc123'])).toBeNull();
    expect(findPlaceholderToken(['status'])).toBeNull();
    expect(findPlaceholderToken([])).toBeNull();
    // Arrows on flags don't trip it — `<>` must wrap the entire token.
    expect(findPlaceholderToken(['policy', 'add', '--scope=path<>here'])).toBeNull();
  });
});
