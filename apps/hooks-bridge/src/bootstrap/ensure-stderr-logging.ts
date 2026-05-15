/**
 * Side-effect bootstrap module. **MUST be the first import of `index.ts`.**
 *
 * Hooks Bridge is HTTP-only — there is no stdout-purity requirement
 * like there is for the mcp-server's stdio transport. But routing pino
 * to stderr keeps the operator log convention identical across the two
 * services: `journalctl -u coodra-mcp-server -u coodra-hooks-bridge -f`
 * shows interleaved JSON, not a stdout/stderr split that the IDE
 * launcher might or might not pipe consistently.
 *
 * Policy:
 *   - If the env var is unset, set it to `'stderr'`.
 *   - If it is already `'stderr'`, normalise the case.
 *   - `'stdout'` is allowed (HTTP-only service, no stdio frame to
 *     corrupt) but logs a one-line note so the operator sees the
 *     deviation. We do NOT exit 1 the way mcp-server does — there
 *     is no transport that would break.
 *
 * Once this module has run, any subsequent `import '@coodra/shared'`
 * call resolves the shared logger pointed at the configured destination.
 */

const configured = process.env.COODRA_LOG_DESTINATION;
const normalized = configured?.toLowerCase();

if (normalized === undefined || normalized === '') {
  process.env.COODRA_LOG_DESTINATION = 'stderr';
} else if (normalized === 'stderr' || normalized === 'stdout') {
  process.env.COODRA_LOG_DESTINATION = normalized;
} else {
  const msg = `@coodra/hooks-bridge: refusing to start — COODRA_LOG_DESTINATION is '${configured}', must be 'stderr' or 'stdout'.\n`;
  process.stderr.write(msg);
  process.exit(1);
}

export {};
