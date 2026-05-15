import { execa } from 'execa';

/**
 * `packages/cli/src/lib/npm-view` — thin wrapper around
 * `npm view @coodra/cli version --json`.
 *
 * One outbound HTTPS GET to registry.npmjs.org per call. Used by
 * `coodra upgrade` (M08b S7) to compare the installed version
 * against the latest published version.
 *
 * `--json` ensures stdout is a parseable string regardless of the
 * registry's response shape (some npm versions print warnings to
 * stdout in non-JSON mode).
 *
 * `timeout: 5_000ms` keeps the upgrade flow snappy when the registry
 * is slow. Failure (network outage, registry 5xx, parse error) throws
 * a structured `NpmViewError` so the caller can surface a helpful
 * message + exit non-zero.
 */

export interface NpmViewOptions {
  /** npm package name. Defaults to `@coodra/cli`. */
  readonly packageName?: string;
  /** Override the npm binary for tests. */
  readonly npmBin?: string;
  /** Per-call timeout in ms. Default 5_000. */
  readonly timeoutMs?: number;
}

export class NpmViewError extends Error {
  readonly code: 'spawn_failed' | 'non_zero_exit' | 'parse_failed';
  readonly details?: { stderr?: string; stdout?: string; exitCode?: number };
  constructor(
    code: 'spawn_failed' | 'non_zero_exit' | 'parse_failed',
    message: string,
    details?: { stderr?: string; stdout?: string; exitCode?: number },
  ) {
    super(message);
    this.name = 'NpmViewError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export async function npmViewVersion(options: NpmViewOptions = {}): Promise<string> {
  const packageName = options.packageName ?? '@coodra/cli';
  const npmBin = options.npmBin ?? 'npm';
  const timeout = options.timeoutMs ?? 5_000;

  let result: {
    exitCode?: number | null;
    stdout?: string | string[] | Uint8Array;
    stderr?: string | string[] | Uint8Array;
  };
  try {
    result = (await execa(npmBin, ['view', packageName, 'version', '--json'], {
      timeout,
      reject: false,
    })) as typeof result;
  } catch (err) {
    throw new NpmViewError(
      'spawn_failed',
      `\`${npmBin} view ${packageName} version --json\` failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // execa returns string | string[] | Uint8Array; normalise to a string
  // for the JSON.parse path. We don't pipe binary, so coerce.
  const stdoutStr = typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? '');
  const stderrStr = typeof result.stderr === 'string' ? result.stderr : String(result.stderr ?? '');

  if (result.exitCode !== 0) {
    throw new NpmViewError(
      'non_zero_exit',
      `\`${npmBin} view ${packageName} version --json\` exited with code ${result.exitCode}`,
      { stderr: stderrStr, stdout: stdoutStr, exitCode: result.exitCode ?? -1 },
    );
  }

  const raw = stdoutStr.trim();
  if (raw.length === 0) {
    throw new NpmViewError('parse_failed', `\`npm view\` returned empty stdout`);
  }

  // npm view returns the version as a JSON string: `"0.1.0"`.
  // Some npm versions return a JSON array when multiple versions exist
  // for a tag/range; handle both shapes.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new NpmViewError(
      'parse_failed',
      `\`npm view\` stdout is not JSON: ${err instanceof Error ? err.message : String(err)}`,
      { stdout: raw },
    );
  }

  if (typeof parsed === 'string') return parsed;
  if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[parsed.length - 1] === 'string') {
    return parsed[parsed.length - 1] as string;
  }
  throw new NpmViewError('parse_failed', `\`npm view\` returned an unexpected shape: ${raw.slice(0, 200)}`, {
    stdout: raw,
  });
}
