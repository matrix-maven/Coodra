import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveContextosPidsDir } from '../contextos-home.js';
import { isProcessAlive } from '../pid-status.js';
import type { DaemonManager, DaemonStatus, DaemonUnit } from './types.js';

export interface FallbackDaemonManagerOptions {
  /** Resolved ~/.contextos/ — used to find pids/. */
  readonly contextosHome: string;
  /** Override for tests — defaults to Node's `child_process.spawn`. */
  readonly spawn?: typeof spawn;
}

interface UnitRecord {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly workingDir?: string;
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
}

/**
 * Universal fallback: detached child process + PID file under ~/.contextos/pids/.
 * Works on every platform but does not survive reboot — for that, prefer the
 * launchd / systemd implementations on macOS / Linux respectively.
 *
 * Each unit gets two on-disk artifacts:
 *   - `~/.contextos/pids/<name>.unit.json` — install record (cmd + args + env).
 *   - `~/.contextos/pids/<name>.pid`       — running PID, written at start().
 */
export class FallbackDaemonManager implements DaemonManager {
  readonly kind = 'fallback' as const;
  private readonly pidsDir: string;
  private readonly spawnFn: typeof spawn;

  constructor(options: FallbackDaemonManagerOptions) {
    this.pidsDir = resolveContextosPidsDir(options.contextosHome);
    this.spawnFn = options.spawn ?? spawn;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async install(unit: DaemonUnit): Promise<void> {
    await mkdir(this.pidsDir, { recursive: true });
    const record: UnitRecord = {
      name: unit.name,
      command: unit.command,
      args: [...unit.args],
      env: { ...unit.env },
      ...(unit.workingDir !== undefined ? { workingDir: unit.workingDir } : {}),
      ...(unit.stdoutPath !== undefined ? { stdoutPath: unit.stdoutPath } : {}),
      ...(unit.stderrPath !== undefined ? { stderrPath: unit.stderrPath } : {}),
    };
    await writeFile(this.unitPath(unit.name), JSON.stringify(record, null, 2), 'utf8');
  }

  async uninstall(unitName: string): Promise<void> {
    await this.stop(unitName);
    await this.tryUnlink(this.unitPath(unitName));
    await this.tryUnlink(this.pidPath(unitName));
  }

  async start(unitName: string): Promise<void> {
    const status = await this.status(unitName);
    if (status.state === 'running') return;
    const record = await this.readUnit(unitName);
    if (record === null) {
      throw new Error(`fallback daemon: no unit installed at ${this.unitPath(unitName)}`);
    }
    // Open log files synchronously so we can pass numeric fds to spawn().
    // openSync('a') creates the file if missing; mkdir parent dirs first
    // so an unprovisioned ~/.contextos/logs/ doesn't break start().
    let stdoutFd: number | 'ignore' = 'ignore';
    let stderrFd: number | 'ignore' = 'ignore';
    if (record.stdoutPath !== undefined) {
      await mkdir(dirname(record.stdoutPath), { recursive: true });
      stdoutFd = openSync(record.stdoutPath, 'a');
    }
    if (record.stderrPath !== undefined) {
      await mkdir(dirname(record.stderrPath), { recursive: true });
      stderrFd = openSync(record.stderrPath, 'a');
    }
    const child = this.spawnFn(record.command, [...record.args], {
      env: { ...process.env, ...record.env },
      cwd: record.workingDir,
      detached: true,
      stdio: ['ignore', stdoutFd, stderrFd],
    });
    if (child.pid === undefined) {
      throw new Error(`fallback daemon: spawn failed for unit ${unitName}`);
    }
    child.unref();
    await writeFile(this.pidPath(unitName), `${child.pid}\n`, 'utf8');
  }

  async stop(unitName: string): Promise<void> {
    const pid = await this.readPid(unitName);
    if (pid === null) return;
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') throw err;
      // Process already gone — fall through to PID file cleanup.
    }
    await this.tryUnlink(this.pidPath(unitName));
  }

  async status(unitName: string): Promise<DaemonStatus> {
    const pid = await this.readPid(unitName);
    if (pid === null) {
      return { name: unitName, state: 'stopped' };
    }
    if (isProcessAlive(pid)) {
      return { name: unitName, state: 'running', pid };
    }
    // Stale PID file.
    await this.tryUnlink(this.pidPath(unitName));
    return { name: unitName, state: 'stopped', detail: 'stale PID file removed' };
  }

  async list(): Promise<DaemonStatus[]> {
    let entries: string[];
    try {
      entries = await readdir(this.pidsDir);
    } catch {
      return [];
    }
    const names = entries.filter((e) => e.endsWith('.unit.json')).map((e) => e.replace(/\.unit\.json$/, ''));
    return Promise.all(names.map((n) => this.status(n)));
  }

  private async readPid(unitName: string): Promise<number | null> {
    try {
      const raw = await readFile(this.pidPath(unitName), 'utf8');
      const pid = Number.parseInt(raw.trim(), 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
      return null;
    } catch {
      return null;
    }
  }

  private async readUnit(unitName: string): Promise<UnitRecord | null> {
    try {
      const raw = await readFile(this.unitPath(unitName), 'utf8');
      return JSON.parse(raw) as UnitRecord;
    } catch {
      return null;
    }
  }

  private async tryUnlink(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      /* ignore */
    }
  }

  private unitPath(unitName: string): string {
    return join(this.pidsDir, `${unitName}.unit.json`);
  }

  private pidPath(unitName: string): string {
    return join(this.pidsDir, `${unitName}.pid`);
  }
}
