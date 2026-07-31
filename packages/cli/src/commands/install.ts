import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureGlobalProject, migrateSqlite } from '@coodra/db';
import { EXIT_OK } from '../exit-codes.js';
import { resolveCoodraHome, resolveCoodraLogsDir, resolveCoodraPidsDir } from '../lib/coodra-home.js';
import { detectIDE, IDE_DISPLAY } from '../lib/detect.js';
import {
  ensureManagedGraphifyRuntime,
  type ManagedGraphifyRuntimeResult,
  managedGraphifyPythonPath,
  managedGraphifyRuntimeRoot,
} from '../lib/graphify/managed-runtime.js';
import type { InstallCommandRunner } from '../lib/init/graphify-install.js';
import type { VerifyResult } from '../lib/init/graphify-python.js';
import {
  classifyMachineRuntimePath,
  machineManifestPath,
  recordMachineManifest,
} from '../lib/machine-store/manifest.js';
import { openLocalDb } from '../lib/open-local-db.js';
import { readTeamConfig, writeTeamConfig } from '../lib/team-config.js';
import { upsertEnvKey } from '../lib/team-init/finalize-config.js';
import { commandTitle, hintLine, pc, terminalWidth } from '../ui/index.js';

export interface InstallOptions {
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly home?: string;
  readonly userHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly graphifyRunner?: InstallCommandRunner;
  readonly graphifyProbeUv?: () => Promise<boolean>;
  readonly graphifyVerify?: (pythonPath: string) => Promise<VerifyResult>;
  readonly platform?: NodeJS.Platform;
}

export interface InstallIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_INSTALL_IO: InstallIO = {
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

function portFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? String(n) : fallback;
}

async function readOrCreateHookSecret(home: string): Promise<string> {
  try {
    const raw = await readFile(join(home, '.env'), 'utf8');
    const match = raw.match(/^LOCAL_HOOK_SECRET=(\S+)/m);
    if (match?.[1] !== undefined && match[1].length > 0) return match[1];
  } catch {
    // First install on this machine.
  }
  return randomBytes(32).toString('hex');
}

export async function runInstallCommand(
  options: InstallOptions = {},
  io: InstallIO = DEFAULT_INSTALL_IO,
): Promise<never> {
  const env = options.env ?? process.env;
  const dryRun = options.dryRun === true;
  const coodraHome = resolveCoodraHome({
    ...(options.home !== undefined ? { override: options.home } : {}),
    env,
  });
  const userHome = options.userHome ?? homedir();
  const detected = await detectIDE({ homeDir: userHome });
  const machineConfigPath = join(coodraHome, 'config.json');
  const homeEnvPath = join(coodraHome, '.env');
  const dataDbPath = join(coodraHome, 'data.db');
  const logsDir = resolveCoodraLogsDir(coodraHome);
  const pidsDir = resolveCoodraPidsDir(coodraHome);
  const manifestPath = machineManifestPath(coodraHome);
  const graphifyRuntimeRoot = managedGraphifyRuntimeRoot(coodraHome);

  if (options.json !== true) {
    io.writeStdout(`${commandTitle('Install', 'Coodra runtime', { width: terminalWidth(), indent: 0 })}\n`);
  }

  let graphifyRuntime: ManagedGraphifyRuntimeResult = {
    ok: true,
    python: managedGraphifyPythonPath(coodraHome, options.platform),
    runtimeRoot: graphifyRuntimeRoot,
    installed: false,
    tool: 'existing',
  };

  if (!dryRun) {
    await mkdir(coodraHome, { recursive: true, mode: 0o700 });
    try {
      await chmod(coodraHome, 0o700);
    } catch {
      // Doctor reports permission drift on platforms where chmod cannot apply.
    }
    await mkdir(logsDir, { recursive: true, mode: 0o700 });
    await mkdir(pidsDir, { recursive: true, mode: 0o700 });

    const machineCfg = readTeamConfig({ homeOverride: coodraHome });
    if (machineCfg.mode === 'solo') {
      writeTeamConfig({ mode: 'solo' }, { homeOverride: coodraHome });
    }

    const localHookSecret = await readOrCreateHookSecret(coodraHome);
    upsertEnvKey(homeEnvPath, 'LOCAL_HOOK_SECRET', localHookSecret);
    upsertEnvKey(homeEnvPath, 'MCP_SERVER_PORT', portFromEnv(env, 'MCP_SERVER_PORT', '3100'));
    upsertEnvKey(homeEnvPath, 'HOOKS_BRIDGE_PORT', portFromEnv(env, 'HOOKS_BRIDGE_PORT', '3101'));

    const handle = await openLocalDb(dataDbPath, { loadVecExtension: true });
    try {
      migrateSqlite(handle.db);
      await ensureGlobalProject(handle);
    } finally {
      handle.close();
    }

    graphifyRuntime = await ensureManagedGraphifyRuntime({
      coodraHome,
      dryRun,
      ...(options.graphifyRunner !== undefined ? { runner: options.graphifyRunner } : {}),
      ...(options.graphifyProbeUv !== undefined ? { probeUv: options.graphifyProbeUv } : {}),
      ...(options.graphifyVerify !== undefined ? { verify: options.graphifyVerify } : {}),
      ...(options.json === true ? {} : { writeStdout: io.writeStdout }),
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
    });
  }

  const manifest = await recordMachineManifest({
    home: coodraHome,
    entries: [
      ...[machineConfigPath, homeEnvPath, dataDbPath, logsDir, pidsDir, manifestPath].map((path) =>
        classifyMachineRuntimePath(coodraHome, path, 'coodra install'),
      ),
      {
        path: 'graphify-mcp',
        scope: 'machine' as const,
        owner: 'graphify',
        kind: 'managed-mcp-runtime',
        createdBy: 'coodra install',
        cleanup: 'ask' as const,
        safeToDelete: true,
      },
    ],
    detectedAgents: detected,
    dryRun,
  });

  if (options.json === true) {
    io.writeStdout(
      `${JSON.stringify(
        {
          ok: true,
          dryRun,
          coodraHome,
          runtime: {
            dirs: ['logs', 'pids'],
            sqlite: 'data.db',
            envKeys: ['LOCAL_HOOK_SECRET', 'MCP_SERVER_PORT', 'HOOKS_BRIDGE_PORT'],
          },
          manifest: {
            path: manifestPath,
            entries: manifest.entries.length,
            agents: manifest.agents,
          },
          graphifyRuntime,
          detectedAgents: detected,
          pluginInstallers: 'pending-native-agent-features',
        },
        null,
        2,
      )}\n`,
    );
    return io.exit(EXIT_OK);
  }

  io.writeStdout(`${pc.green('✓')} Coodra home: ${coodraHome}${dryRun ? pc.gray(' (dry-run)') : ''}\n`);
  io.writeStdout(`${pc.green('✓')} Runtime directories: logs, pids\n`);
  io.writeStdout(`${pc.green('✓')} Local SQLite store: data.db + migrations + __global__ sentinel\n`);
  io.writeStdout(`${pc.green('✓')} Runtime env: LOCAL_HOOK_SECRET, MCP_SERVER_PORT, HOOKS_BRIDGE_PORT\n`);
  if (graphifyRuntime.ok) {
    io.writeStdout(
      `${pc.green('✓')} Graphify MCP runtime: ${graphifyRuntime.python}${graphifyRuntime.installed ? pc.gray(` (${graphifyRuntime.tool})`) : ''}\n`,
    );
  } else {
    io.writeStdout(`${pc.yellow('◌')} Graphify MCP runtime: ${graphifyRuntime.error}\n`);
  }
  io.writeStdout(`${pc.green('✓')} Machine manifest: ${manifestPath}\n`);

  if (detected.length > 0) {
    io.writeStdout(`\n${pc.bold('Detected agent CLIs/config homes')}\n`);
    for (const agent of detected) {
      io.writeStdout(`  ${pc.green('•')} ${IDE_DISPLAY[agent]}\n`);
    }
  } else {
    io.writeStdout(`\n${pc.gray('·')} No supported agent config homes detected yet.\n`);
  }

  io.writeStdout(
    `\n${hintLine(
      'Native agent plugin installers are tracked separately in COOD-6 through COOD-9. `coodra agent add <agent>` remains the follow-up command for adding one later.',
    )}\n`,
  );
  io.writeStdout(`${hintLine('Next: run `coodra init` inside a repo to create that project’s .coodra/ layout.')}\n`);

  return io.exit(EXIT_OK);
}
