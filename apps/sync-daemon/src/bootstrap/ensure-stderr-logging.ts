/**
 * Side-effect bootstrap module. **MUST be the first import of `index.ts`.**
 *
 * Same shape as the bridge's bootstrap: route pino to stderr by default
 * so a single `journalctl` view interleaves the three daemons without a
 * stdout/stderr split. Sync-daemon has no transport that would break on
 * stdout, so `'stdout'` is allowed but logs a one-line note.
 */

const configured = process.env.COODRA_LOG_DESTINATION;
const normalized = configured?.toLowerCase();

if (normalized === undefined || normalized === '') {
  process.env.COODRA_LOG_DESTINATION = 'stderr';
} else if (normalized === 'stderr' || normalized === 'stdout') {
  process.env.COODRA_LOG_DESTINATION = normalized;
} else {
  // Unknown value — coerce to stderr to avoid surprising routing.
  process.env.COODRA_LOG_DESTINATION = 'stderr';
  // Cannot use the shared logger here — this module runs before it loads.
  process.stderr.write(
    `[sync-daemon] COODRA_LOG_DESTINATION='${configured}' is not recognised; defaulting to 'stderr'.\n`,
  );
}
