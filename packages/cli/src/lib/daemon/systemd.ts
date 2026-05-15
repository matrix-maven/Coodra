import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Options as ExecaOptions, execa, type ResultPromise } from 'execa';
import type { DaemonManager, DaemonStatus, DaemonUnit } from './types.js';

const UNIT_PREFIX = 'coodra-';

type ExecaLike = (file: string, args: readonly string[], options?: ExecaOptions) => ResultPromise<ExecaOptions>;

export interface SystemdManagerOptions {
  readonly homeDir?: string;
  readonly execa?: ExecaLike;
}

export type { ExecaLike };

/**
 * Linux systemd --user. Writes ~/.config/systemd/user/coodra-<name>.service
 * and shells `systemctl --user start/stop/status/daemon-reload`. Survives the
 * user session; for restart-on-reboot the user must run `loginctl enable-linger
 * <user>` once (doctor check 16 surfaces this).
 */
export class SystemdDaemonManager implements DaemonManager {
  readonly kind = 'systemd' as const;
  private readonly unitsDir: string;
  private readonly run: ExecaLike;

  constructor(options: SystemdManagerOptions = {}) {
    const home = options.homeDir ?? homedir();
    this.unitsDir = join(home, '.config', 'systemd', 'user');
    this.run = options.execa ?? (execa as unknown as ExecaLike);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.run('systemctl', ['--user', '--version'], { reject: false, timeout: 1500 });
      return (result as { exitCode?: number }).exitCode === 0;
    } catch {
      return false;
    }
  }

  async install(unit: DaemonUnit): Promise<void> {
    await mkdir(this.unitsDir, { recursive: true });
    const body = renderServiceUnit(unit);
    await writeFile(this.unitPath(unit.name), body, 'utf8');
    await this.run('systemctl', ['--user', 'daemon-reload'], { reject: false, timeout: 3000 });
    // W5 / beta.5 (2026-05-13) — clear any prior failure / rate-limit
    // state for this unit. systemd's restart rate-limiter (StartLimitBurst,
    // default 5 starts / 10s) latches a unit into `failed` after a
    // crash-loop and then REFUSES every subsequent `systemctl restart`
    // until `reset-failed` runs. Because `start()` calls restart with
    // `reject: false`, that refusal was silently swallowed: the unit
    // file got fixed (e.g. DATABASE_URL added by `team init`) but the
    // daemon never actually came back up. Running `reset-failed` on
    // every install makes `coodra start` a genuine clean slate.
    // No-op on a healthy unit; idempotent.
    await this.run('systemctl', ['--user', 'reset-failed', this.unitName(unit.name)], {
      reject: false,
      timeout: 3000,
    });
  }

  async uninstall(unitName: string): Promise<void> {
    await this.stop(unitName);
    try {
      await unlink(this.unitPath(unitName));
      await this.run('systemctl', ['--user', 'daemon-reload'], { reject: false, timeout: 3000 });
    } catch {
      /* ignore */
    }
  }

  async start(unitName: string): Promise<void> {
    // Use `restart` not `start` so a fresh `coodra start` after a
    // unit-file change always picks up the latest env. systemd's `start`
    // is a no-op on an already-active unit; `restart` does stop+start
    // and re-reads the (already daemon-reloaded) unit file. install()
    // ran daemon-reload after writing, so this picks up new env.
    await this.run('systemctl', ['--user', 'restart', this.unitName(unitName)], { reject: false, timeout: 5000 });
  }

  async stop(unitName: string): Promise<void> {
    await this.run('systemctl', ['--user', 'stop', this.unitName(unitName)], { reject: false, timeout: 5000 });
  }

  async status(unitName: string): Promise<DaemonStatus> {
    const result = await this.run(
      'systemctl',
      ['--user', 'show', this.unitName(unitName), '--property=ActiveState,MainPID'],
      { reject: false, timeout: 3000 },
    );
    const out = String((result as { stdout?: unknown }).stdout ?? '');
    const active = /ActiveState=(\S+)/.exec(out)?.[1] ?? 'unknown';
    const pidMatch = /MainPID=(\d+)/.exec(out)?.[1];
    if (active === 'active') {
      const pid = pidMatch !== undefined ? Number.parseInt(pidMatch, 10) : undefined;
      return { name: unitName, state: 'running', ...(pid !== undefined && pid > 0 ? { pid } : {}) };
    }
    if (active === 'inactive' || active === 'failed') {
      return { name: unitName, state: 'stopped', detail: active };
    }
    return { name: unitName, state: 'unknown', detail: active };
  }

  async list(): Promise<DaemonStatus[]> {
    let entries: string[];
    try {
      entries = await readdir(this.unitsDir);
    } catch {
      return [];
    }
    const names = entries
      .filter((e) => e.startsWith(UNIT_PREFIX) && e.endsWith('.service'))
      .map((e) => e.replace(UNIT_PREFIX, '').replace(/\.service$/, ''));
    return Promise.all(names.map((n) => this.status(n)));
  }

  private unitPath(unitName: string): string {
    return join(this.unitsDir, this.unitName(unitName));
  }

  private unitName(unitName: string): string {
    return `${UNIT_PREFIX}${unitName}.service`;
  }
}

function renderServiceUnit(unit: DaemonUnit): string {
  const envLines = Object.entries(unit.env).map(([k, v]) => renderEnvLine(k, v));
  const lines = [
    '[Unit]',
    `Description=Coodra managed unit (${unit.name})`,
    'After=default.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${unit.command} ${unit.args.map(quoteArg).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=2',
    ...(unit.workingDir !== undefined ? [`WorkingDirectory=${unit.workingDir}`] : []),
    ...(unit.stdoutPath !== undefined ? [`StandardOutput=append:${unit.stdoutPath}`] : []),
    ...(unit.stderrPath !== undefined ? [`StandardError=append:${unit.stderrPath}`] : []),
    ...envLines,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ];
  return lines.join('\n');
}

function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_\-./=:]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Render a single `Environment="KEY=VALUE"` line for a systemd unit.
 *
 * beta.8 (2026-05-14) — the critical escape is `%` → `%%`. systemd does
 * **specifier expansion** on `Environment=` values (`%n`, `%u`, `%i`,
 * …). A URL-encoded Postgres password like `Abi%4029250204` (`%40` is
 * an encoded `@`) contains `%4`, which systemd tries to expand as a
 * specifier — it isn't one, so systemd mangles or drops the whole
 * value. The sync-daemon then boots with `DATABASE_URL=undefined` and
 * crash-loops. The pre-beta.8 `escapeForUnit` handled `\n` and `'` but
 * NOT `%`, so any DATABASE_URL with a percent-encoded character in the
 * password silently broke team mode on Linux. launchd (macOS) never
 * hit this — plist `<string>` values do no specifier expansion.
 *
 * Full escaping, applied in order:
 *   - newlines → space (a newline would split the unit line)
 *   - `\` → `\\`, `"` → `\"`  (we wrap the whole assignment in quotes
 *     so values with spaces — e.g. a home dir with spaces — survive)
 *   - `%` → `%%`  (literal percent; the load-bearing fix)
 */
function renderEnvLine(key: string, value: string): string {
  const escaped = value.replace(/\r?\n/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  return `Environment="${key}=${escaped}"`;
}
