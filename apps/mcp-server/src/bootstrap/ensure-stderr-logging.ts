/**
 * Side-effect bootstrap module. **MUST be the first import of `index.ts`.**
 *
 * The MCP stdio transport writes JSON-RPC frames on stdout exclusively.
 * A single stray byte — a `console.log` from our code, or a pino line
 * from any transitive dependency — corrupts the transport and the
 * client disconnects. Defending against that is not something we can
 * achieve inside `index.ts` alone: ES modules hoist `import`
 * declarations, so setting env vars in the body of `index.ts` would
 * run AFTER `@coodra/shared/logger` has already resolved its
 * destination.
 *
 * This module fixes that by being imported for its side effect BEFORE
 * any other import that transitively reaches the shared logger. It
 * guarantees that when the logger module evaluates `process.env
 * .COODRA_LOG_DESTINATION` it sees `'stderr'`.
 *
 * Policy:
 *   - If the env var is unset, set it to `'stderr'`. This is the happy
 *     path for direct `node dist/index.js` invocations.
 *   - If it is already set to `'stderr'` (any case), leave it alone.
 *   - If it is set to anything else (including `'stdout'`), we REFUSE
 *     to silently override — that would hide an operator mistake.
 *     Write a loud diagnostic to fd 2 and exit 1 before the transport
 *     has a chance to come up with a corrupted stdout.
 *
 * Once this module has run, any subsequent `import '@coodra/shared'`
 * call (direct or transitive) resolves the shared logger pointed at
 * fd 2.
 */

const configured = process.env.COODRA_LOG_DESTINATION;
const normalized = configured?.toLowerCase();

if (normalized === undefined || normalized === '') {
  process.env.COODRA_LOG_DESTINATION = 'stderr';
} else if (normalized === 'stderr') {
  // Already correct — no-op. Normalise case so the shared logger sees
  // a canonical value.
  process.env.COODRA_LOG_DESTINATION = 'stderr';
} else {
  const msg = `@coodra/mcp-server: refusing to start — COODRA_LOG_DESTINATION is '${configured}', but the stdio transport requires 'stderr'. Unset the variable or set it to 'stderr' and restart.\n`;
  process.stderr.write(msg);
  process.exit(1);
}

export {};
