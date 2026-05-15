#!/usr/bin/env node
// MUST be the first import — sets COODRA_LOG_DESTINATION=stderr before
// any module that constructs a @coodra/shared logger. See
// `lib/log-destination-shim.ts` for the rationale.
import './lib/log-destination-shim.js';
// MUST be imported BEFORE any `import '@coodra/db'` — pins
// COODRA_MIGRATIONS_DIR to the bundled drizzle path so the
// module-level MIGRATIONS_FOLDER constant resolves correctly when the
// CLI is running from the bundled npm tarball. Decision dec_83ba10c1
// (2026-05-02). No-op in monorepo dev.
import './lib/migrations-dir-shim.js';
// MUST be imported AFTER the log shim and BEFORE `buildProgram` — layers
// `<COODRA_HOME>/.env` and `<cwd>/.env` into `process.env` so doctor /
// start / status all see the same env. Closes Finding A from the
// 2026-04-28 functest. See `lib/env-bootstrap-shim.ts`.
import './lib/env-bootstrap-shim.js';
import { buildProgram } from './program.js';

// `coodra` with no arguments at all, on an interactive terminal,
// launches the redesigned TUI. Any arguments (a subcommand, `--help`,
// `--version`, `ui`) fall through to commander untouched — and a
// non-TTY no-args invocation (piped, CI) also goes to commander, which
// prints help. Gating here rather than via a commander root `.action()`
// keeps the CLI surface unchanged: `coodra help <cmd>` and strict
// argument arity still behave exactly as before.
const cliArgs = process.argv.slice(2);
if (cliArgs.length === 0 && process.stdin.isTTY === true && process.stdout.isTTY === true) {
  const { launchTui } = await import('./tui/index.js');
  await launchTui();
} else {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}
