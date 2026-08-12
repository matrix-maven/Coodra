import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Options as ExecaOptions, execa, type ResultPromise } from 'execa';
import type { DaemonManager, DaemonStatus, DaemonUnit } from './types.js';

const TASK_FOLDER = '\\Coodra';

type ExecaLike = (file: string, args: readonly string[], options?: ExecaOptions) => ResultPromise<ExecaOptions>;

export interface TaskSchedulerManagerOptions {
  readonly coodraHome: string;
  readonly execa?: ExecaLike;
}

export type { ExecaLike };

/**
 * Windows Task Scheduler manager. It writes one launcher `.ps1` per Coodra
 * service under `~/.coodra/tasks/`, then registers `\Coodra\<name>` to run
 * at user logon and uses `schtasks /Run|/End|/Query` for lifecycle.
 */
export class TaskSchedulerDaemonManager implements DaemonManager {
  readonly kind = 'task-scheduler' as const;
  private readonly tasksDir: string;
  private readonly run: ExecaLike;

  constructor(options: TaskSchedulerManagerOptions) {
    this.tasksDir = join(options.coodraHome, 'tasks');
    this.run = options.execa ?? (execa as unknown as ExecaLike);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.run('schtasks.exe', ['/Query', '/?'], { reject: false, timeout: 1500 });
      return ((result as { exitCode?: number }).exitCode ?? 1) === 0;
    } catch {
      return false;
    }
  }

  async install(unit: DaemonUnit): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true });
    const launcherPath = this.launcherPath(unit.name);
    await writeFile(launcherPath, renderLauncher(unit), 'utf8');
    await this.run(
      'schtasks.exe',
      ['/Create', '/TN', this.taskName(unit.name), '/SC', 'ONLOGON', '/TR', taskRunCommand(launcherPath), '/F'],
      { reject: false, timeout: 5000 },
    );
  }

  async uninstall(unitName: string): Promise<void> {
    await this.stop(unitName);
    await this.run('schtasks.exe', ['/Delete', '/TN', this.taskName(unitName), '/F'], { reject: false, timeout: 5000 });
    try {
      await unlink(this.launcherPath(unitName));
    } catch {
      /* ignore */
    }
  }

  async start(unitName: string): Promise<void> {
    await this.run('schtasks.exe', ['/End', '/TN', this.taskName(unitName)], { reject: false, timeout: 5000 });
    await this.run('schtasks.exe', ['/Run', '/TN', this.taskName(unitName)], { reject: false, timeout: 5000 });
  }

  async stop(unitName: string): Promise<void> {
    await this.run('schtasks.exe', ['/End', '/TN', this.taskName(unitName)], { reject: false, timeout: 5000 });
  }

  async status(unitName: string): Promise<DaemonStatus> {
    const result = await this.run('schtasks.exe', ['/Query', '/TN', this.taskName(unitName), '/FO', 'LIST', '/V'], {
      reject: false,
      timeout: 5000,
    });
    const exitCode = (result as { exitCode?: number }).exitCode ?? 1;
    if (exitCode !== 0) return { name: unitName, state: 'stopped' };
    const out = String((result as { stdout?: unknown }).stdout ?? '');
    const status = /^Status:\s*(.+)$/im.exec(out)?.[1]?.trim().toLowerCase();
    if (status === 'running') return { name: unitName, state: 'running' };
    if (status === 'ready' || status === 'queued' || status === 'disabled') {
      return { name: unitName, state: 'stopped', detail: status };
    }
    return { name: unitName, state: 'unknown', detail: status ?? out.slice(0, 200) };
  }

  async list(): Promise<DaemonStatus[]> {
    let entries: string[];
    try {
      entries = await readdir(this.tasksDir);
    } catch {
      return [];
    }
    const names = entries.filter((e) => e.endsWith('.ps1')).map((e) => e.replace(/\.ps1$/, ''));
    return Promise.all(names.map((name) => this.status(name)));
  }

  private taskName(unitName: string): string {
    return `${TASK_FOLDER}\\${unitName}`;
  }

  private launcherPath(unitName: string): string {
    return join(this.tasksDir, `${unitName}.ps1`);
  }
}

function renderLauncher(unit: DaemonUnit): string {
  const lines = ["$ErrorActionPreference = 'Stop'"];
  for (const [key, value] of Object.entries(unit.env)) {
    lines.push(`$env:${key} = ${quotePowerShellLiteral(value)}`);
  }
  if (unit.workingDir !== undefined) lines.push(`Set-Location -LiteralPath ${quotePowerShellLiteral(unit.workingDir)}`);

  const command = ['&', quotePowerShellLiteral(unit.command), ...unit.args.map(quotePowerShellLiteral)].join(' ');
  const stdout = unit.stdoutPath !== undefined ? `>> ${quotePowerShellLiteral(unit.stdoutPath)}` : '> $null';
  const stderr = unit.stderrPath !== undefined ? `2>> ${quotePowerShellLiteral(unit.stderrPath)}` : '2> $null';
  lines.push(`${command} ${stdout} ${stderr}`);
  return `${lines.join('\r\n')}\r\n`;
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/\r?\n/g, ' ').replace(/'/g, "''")}'`;
}

function taskRunCommand(path: string): string {
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${path.replace(/"/g, '""')}"`;
}
