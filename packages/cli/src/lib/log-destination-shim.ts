/**
 * `packages/cli/src/lib/log-destination-shim` — must be imported first
 * in the CLI binary's entry point, before any module that constructs
 * a `@coodra/shared` logger (`createLogger` reads the env var at
 * module-init time).
 *
 * Closes integration finding 2026-04-27 (post-08a walk): `coodra init`
 * was printing structured pino JSON onto stdout, interleaved with the
 * human-readable `✓`/`⚠` progress UI. Scripted callers piping init or
 * doctor output got JSON garbage mixed with checkmarks. Root cause:
 * the shared logger defaults to pino's stdout when no destination is
 * configured; mcp-server's stdio transport sets `COODRA_LOG_DESTINATION=stderr`
 * via .mcp.json, but the CLI binary had no equivalent hook.
 *
 * Defaulting to stderr in the CLI binary keeps stdout JSON-clean for
 * scripted consumers while preserving any explicit user override
 * (`COODRA_LOG_DESTINATION=stdout coodra doctor` still works
 * for users who want both streams unified).
 *
 * Why a separate file: ESM evaluates imports in source order. A
 * top-level statement `process.env.COODRA_LOG_DESTINATION = 'stderr'`
 * placed AFTER `import { buildProgram } from './program.js'` would run
 * after every transitively-imported `createLogger` call has already
 * captured the original (undefined) value. Keeping the assignment in
 * its own module that index.ts imports first is the only ordering-safe
 * way.
 */

if (process.env.COODRA_LOG_DESTINATION === undefined) {
  process.env.COODRA_LOG_DESTINATION = 'stderr';
}

// Phase B clarity-pass demo finding (2026-05-11): even on stderr, the
// CLI's info-level pino logs (project_seeded, default_policy_seeded,
// kill_switch_inserted, etc.) interleave with the human-readable
// `✓`/`⚠` UI on the terminal because both fds default to the tty.
// For interactive CLI commands the structured logs are noise — they
// were designed for daemon diagnostics, not user-facing output.
//
// Default the CLI process to LOG_LEVEL=warn so info-level pinos go
// silent unless the user opts in (`LOG_LEVEL=info coodra init`).
// Spawned daemons are unaffected because services.ts only forwards
// env keys starting with COODRA_/CLERK_ — LOG_LEVEL is intention-
// ally NOT forwarded, so the mcp-server / hooks-bridge / sync-daemon
// children continue to log at their own boot-time 'info' default.
if (process.env.LOG_LEVEL === undefined) {
  process.env.LOG_LEVEL = 'warn';
}
