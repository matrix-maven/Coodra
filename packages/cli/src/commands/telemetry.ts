import { readCoodraProjectConfig } from '@coodra/shared';

import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { resolveCoodraHome } from '../lib/coodra-home.js';
import { loadHomeEnv } from '../lib/load-home-env.js';
import {
  claudeCodeEnvSnippet,
  codexConfigSnippet,
  probeReceiver,
  type ReceiverProbe,
  readHomeEnvKey,
  setHomeEnvKey,
  TELEMETRY_FLAG,
} from '../lib/telemetry-env.js';
import { pc } from '../ui/index.js';

/**
 * `coodra telemetry <enable|disable|status|env>` (COOD-105).
 *
 * Native harness telemetry is opt-in and local-only. `enable` records the choice in
 * `<COODRA_HOME>/.env` so it persists across `coodra start`, reinstall and reboot; the daemon
 * reads it at boot, so a restart applies it. `status` compares the persisted choice with what the
 * running daemon actually mounts, so a pending restart is visible instead of silent.
 */

export interface TelemetryOptions {
  readonly project?: string;
  /** `claude` | `codex`; both are printed when omitted. */
  readonly harness?: string;
  readonly json?: boolean;
}

export interface TelemetryIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
  readonly coodraHome?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly probe?: (port: number) => Promise<ReceiverProbe>;
}

export const DEFAULT_TELEMETRY_IO: TelemetryIO = {
  writeStdout: (chunk) => {
    process.stdout.write(chunk);
  },
  writeStderr: (chunk) => {
    process.stderr.write(chunk);
  },
  exit: (code) => {
    process.exit(code);
  },
};

type Action = 'enable' | 'disable' | 'status' | 'env';

function mcpPort(home: string, env: NodeJS.ProcessEnv, cwd: string): number {
  const layered = { ...loadHomeEnv(home, cwd), ...env };
  const parsed = Number.parseInt(layered.MCP_SERVER_PORT ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 3100;
}

async function projectSlug(options: TelemetryOptions, cwd: string): Promise<string | null> {
  if (options.project !== undefined && options.project.trim() !== '') return options.project.trim();
  const config = await readCoodraProjectConfig(cwd).catch(() => null);
  return config?.projectSlug ?? null;
}

export async function runTelemetryCommand(
  action: string,
  options: TelemetryOptions = {},
  ioOverride?: TelemetryIO,
): Promise<void> {
  const io = ioOverride ?? DEFAULT_TELEMETRY_IO;
  const home = io.coodraHome ?? resolveCoodraHome();
  const cwd = io.cwd ?? process.cwd();
  const env = io.env ?? process.env;
  const out = (s: string) => io.writeStdout(`${s}\n`);

  if (!['enable', 'disable', 'status', 'env'].includes(action)) {
    io.writeStderr(`${pc.red('✗')} unknown telemetry action "${action}". Use enable, disable, status or env.\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }
  const act = action as Action;
  const port = mcpPort(home, env, cwd);

  if (act === 'enable' || act === 'disable') {
    const { changed } = setHomeEnvKey(home, TELEMETRY_FLAG, act === 'enable' ? '1' : null);
    out(
      `${pc.green('✓')} Native telemetry ${act === 'enable' ? 'enabled' : 'disabled'} in ${home}/.env${
        changed ? '' : ' (already set)'
      }.`,
    );
    out('  Restart the daemon to apply it:  coodra stop && coodra start');
    if (act === 'enable') out('  Then point Claude Code and/or Codex at it:  coodra telemetry env --project <slug>');
    return io.exit(EXIT_OK);
  }

  if (act === 'env') {
    const slug = await projectSlug(options, cwd);
    if (slug === null) {
      io.writeStderr(
        `${pc.red('✗')} no project slug. Pass --project <slug>, or run inside a project initialised with \`coodra init\`.\n`,
      );
      return io.exit(EXIT_USER_RECOVERABLE);
    }
    const harness = options.harness?.trim().toLowerCase();
    if (harness !== undefined && harness !== '' && harness !== 'claude' && harness !== 'codex') {
      io.writeStderr(`${pc.red('✗')} unknown --harness "${options.harness}". Use claude or codex.\n`);
      return io.exit(EXIT_USER_RECOVERABLE);
    }
    const both = harness === undefined || harness === '';
    if (both || harness === 'claude') {
      out('# Claude Code — add to the shell that launches it. Metadata only; content is never stored.');
      out(claudeCodeEnvSnippet({ port, projectSlug: slug }));
    }
    if (both) out('');
    if (both || harness === 'codex') {
      out('# Codex — add to ~/.codex/config.toml. Coodra discards the tool arguments and outputs Codex exports.');
      out(codexConfigSnippet({ port, projectSlug: slug }));
    }
    return io.exit(EXIT_OK);
  }

  // status
  const persisted = readHomeEnvKey(home, TELEMETRY_FLAG) === '1' || env[TELEMETRY_FLAG] === '1';
  const live = await (io.probe ?? ((p: number) => probeReceiver(p)))(port);
  const state =
    live === 'unreachable'
      ? 'daemon not reachable'
      : live === 'enabled'
        ? persisted
          ? 'enabled and running'
          : 'running with telemetry on, but not persisted (set by hand); run `coodra telemetry enable` to keep it'
        : persisted
          ? 'enabled in config, daemon needs a restart (coodra stop && coodra start)'
          : 'disabled';
  if (options.json === true) {
    out(JSON.stringify({ persisted, receiver: live, port, state }));
  } else {
    out(`Native telemetry: ${state}`);
    out(`  persisted in ${home}/.env : ${persisted ? 'yes' : 'no'}`);
    out(`  receiver on :${port}     : ${live}`);
    out('  scope                    : local only, SQLite, never synced; metadata only, no content');
  }
  return io.exit(EXIT_OK);
}
