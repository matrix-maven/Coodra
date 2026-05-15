import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Options as ExecaOptions, execa, type ResultPromise } from 'execa';
import type { DaemonManager, DaemonStatus, DaemonUnit } from './types.js';

const LABEL_PREFIX = 'com.coodra.';

type ExecaLike = (file: string, args: readonly string[], options?: ExecaOptions) => ResultPromise<ExecaOptions>;

export interface LaunchdManagerOptions {
  readonly homeDir?: string;
  readonly execa?: ExecaLike;
}

export type { ExecaLike };

/**
 * macOS launchd via launchctl. Writes plist files to
 * ~/Library/LaunchAgents/com.coodra.<name>.plist and uses `launchctl
 * bootstrap gui/<uid>` / `bootout` for the lifecycle. Works without root.
 */
export class LaunchdDaemonManager implements DaemonManager {
  readonly kind = 'launchd' as const;
  private readonly agentsDir: string;
  private readonly run: ExecaLike;

  constructor(options: LaunchdManagerOptions = {}) {
    const home = options.homeDir ?? homedir();
    this.agentsDir = join(home, 'Library', 'LaunchAgents');
    this.run = options.execa ?? (execa as unknown as ExecaLike);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.run('launchctl', ['version'], { reject: false, timeout: 1500 });
      return (result as { exitCode?: number }).exitCode === 0;
    } catch {
      return false;
    }
  }

  async install(unit: DaemonUnit): Promise<void> {
    await mkdir(this.agentsDir, { recursive: true });
    const plist = renderPlist(unit);
    await writeFile(this.plistPath(unit.name), plist, 'utf8');
  }

  async uninstall(unitName: string): Promise<void> {
    await this.stop(unitName);
    try {
      await unlink(this.plistPath(unitName));
    } catch {
      /* ignore */
    }
  }

  async start(unitName: string): Promise<void> {
    const userTarget = `gui/${process.getuid?.() ?? 0}`;
    const labelTarget = `${userTarget}/${this.label(unitName)}`;
    // CRITICAL: launchctl bootstrap is a no-op on an already-loaded
    // label. Without an explicit bootout first, a second `coodra
    // start` invocation with a different COODRA_HOME (or any plist
    // change — env, working dir, log path) is silently ignored, and
    // the previously-loaded daemon keeps running with its stale env.
    // The user thinks the new home is being served (`✓ Sync Daemon
    // started`, /healthz responds 200) but every audit row is going
    // to the wrong SQLite database.
    //
    // Best-effort bootout — if the label isn't loaded it returns
    // non-zero, which we ignore (reject: false).
    await this.run('launchctl', ['bootout', labelTarget], {
      reject: false,
      timeout: 5000,
    });
    await this.run('launchctl', ['bootstrap', userTarget, this.plistPath(unitName)], {
      reject: false,
      timeout: 5000,
    });
  }

  async stop(unitName: string): Promise<void> {
    const target = `gui/${process.getuid?.() ?? 0}/${this.label(unitName)}`;
    await this.run('launchctl', ['bootout', target], { reject: false, timeout: 5000 });
  }

  async status(unitName: string): Promise<DaemonStatus> {
    const result = await this.run('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/${this.label(unitName)}`], {
      reject: false,
      timeout: 3000,
    });
    const out = String((result as { stdout?: unknown }).stdout ?? '');
    const exitCode = (result as { exitCode?: number }).exitCode ?? 1;
    if (exitCode !== 0) {
      return { name: unitName, state: 'stopped' };
    }
    const pidMatch = /pid\s*=\s*(\d+)/.exec(out);
    if (pidMatch !== null && pidMatch[1] !== undefined) {
      const pid = Number.parseInt(pidMatch[1], 10);
      return { name: unitName, state: 'running', pid };
    }
    return { name: unitName, state: 'unknown', detail: out.slice(0, 200) };
  }

  async list(): Promise<DaemonStatus[]> {
    let entries: string[];
    try {
      entries = await readdir(this.agentsDir);
    } catch {
      return [];
    }
    const names = entries
      .filter((e) => e.startsWith(LABEL_PREFIX) && e.endsWith('.plist'))
      .map((e) => e.replace(LABEL_PREFIX, '').replace(/\.plist$/, ''));
    return Promise.all(names.map((n) => this.status(n)));
  }

  private plistPath(unitName: string): string {
    return join(this.agentsDir, `${this.label(unitName)}.plist`);
  }

  private label(unitName: string): string {
    return `${LABEL_PREFIX}${unitName}`;
  }
}

function renderPlist(unit: DaemonUnit): string {
  const programArgs = [unit.command, ...unit.args].map(escapeXml);
  const envEntries = Object.entries(unit.env)
    .map(([k, v]) => `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(v)}</string>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LABEL_PREFIX}${escapeXml(unit.name)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...programArgs.map((a) => `    <string>${a}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    ...(envEntries.length > 0 ? ['  <key>EnvironmentVariables</key>', '  <dict>', envEntries, '  </dict>'] : []),
    ...(unit.workingDir !== undefined
      ? [`  <key>WorkingDirectory</key><string>${escapeXml(unit.workingDir)}</string>`]
      : []),
    ...(unit.stdoutPath !== undefined
      ? [`  <key>StandardOutPath</key><string>${escapeXml(unit.stdoutPath)}</string>`]
      : []),
    ...(unit.stderrPath !== undefined
      ? [`  <key>StandardErrorPath</key><string>${escapeXml(unit.stderrPath)}</string>`]
      : []),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
