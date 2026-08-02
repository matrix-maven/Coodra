import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { IDE } from '../detect.js';

export const MACHINE_MANIFEST_REL = 'manifest.json' as const;

export type MachineManifestScope = 'machine' | 'agent-global';

export interface MachineManifestEntry {
  readonly path: string;
  readonly scope: MachineManifestScope;
  readonly owner: string;
  readonly kind: string;
  readonly createdBy: string;
  readonly cleanup: 'preserve' | 'ask' | 'safe';
  readonly safeToDelete: boolean;
  readonly updatedAt?: string;
}

export type MachineManifestEntryInput = Omit<MachineManifestEntry, 'updatedAt'>;

export interface MachineManifestAgent {
  readonly id: IDE;
  readonly status: 'detected' | 'installed';
  readonly installed: boolean;
  readonly pluginPath?: string;
  readonly marketplacePath?: string;
  readonly updatedAt?: string;
}

export interface MachineManifestProject {
  readonly id: string;
  readonly slug: string;
  readonly cwd: string;
  readonly updatedAt?: string;
}

export interface MachineManifest {
  readonly version: 1;
  readonly coodraHome: string;
  readonly entries: MachineManifestEntry[];
  readonly agents: MachineManifestAgent[];
  readonly projects: MachineManifestProject[];
}

export function machineManifestPath(home: string): string {
  return join(home, MACHINE_MANIFEST_REL);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.coodra.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

export async function readMachineManifest(home: string): Promise<MachineManifest | null> {
  let raw: string;
  try {
    raw = await readFile(machineManifestPath(home), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MachineManifest>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries) || !Array.isArray(parsed.agents)) return null;
    return {
      version: 1,
      coodraHome: typeof parsed.coodraHome === 'string' ? parsed.coodraHome : home,
      entries: parsed.entries,
      agents: parsed.agents,
      projects: Array.isArray(parsed.projects) ? (parsed.projects as MachineManifestProject[]) : [],
    };
  } catch {
    return null;
  }
}

export function classifyMachineRuntimePath(
  home: string,
  absPath: string,
  createdBy: string,
): MachineManifestEntryInput {
  const rel = absPath.startsWith(`${home}/`) ? absPath.slice(home.length + 1) : absPath;
  const base = rel.split(/[\\/]/).pop() ?? rel;
  const kind =
    rel === 'config.json'
      ? 'machine-config'
      : rel === '.env'
        ? 'runtime-env'
        : rel === 'data.db'
          ? 'sqlite-db'
          : base === 'logs'
            ? 'logs-dir'
            : base === 'pids'
              ? 'pids-dir'
              : rel === MACHINE_MANIFEST_REL
                ? 'machine-manifest'
                : 'generated';
  return {
    path: rel,
    scope: rel === absPath ? 'agent-global' : 'machine',
    owner: 'coodra',
    kind,
    createdBy,
    cleanup: 'preserve',
    safeToDelete: false,
  };
}

export interface RecordMachineManifestOptions {
  readonly home: string;
  readonly entries: readonly MachineManifestEntryInput[];
  readonly detectedAgents?: readonly IDE[];
  readonly installedAgents?: readonly {
    readonly id: IDE;
    readonly pluginPath?: string;
    readonly marketplacePath?: string;
  }[];
  readonly registeredProjects?: readonly {
    readonly id: string;
    readonly slug: string;
    readonly cwd: string;
  }[];
  readonly dryRun: boolean;
  readonly now?: () => string;
}

export async function recordMachineManifest(opts: RecordMachineManifestOptions): Promise<MachineManifest> {
  const now = opts.now ?? (() => new Date().toISOString());
  const existing = await readMachineManifest(opts.home);
  const byPath = new Map<string, MachineManifestEntry>();
  for (const entry of existing?.entries ?? []) byPath.set(entry.path, entry);
  for (const input of opts.entries) byPath.set(input.path, { ...input, updatedAt: now() });

  const byAgent = new Map<IDE, MachineManifestAgent>();
  for (const agent of existing?.agents ?? []) byAgent.set(agent.id, agent);
  for (const id of opts.detectedAgents ?? []) {
    const existingAgent = byAgent.get(id);
    byAgent.set(
      id,
      existingAgent?.installed === true
        ? existingAgent
        : { id, status: 'detected', installed: false, updatedAt: now() },
    );
  }
  for (const agent of opts.installedAgents ?? []) {
    byAgent.set(agent.id, {
      id: agent.id,
      status: 'installed',
      installed: true,
      ...(agent.pluginPath !== undefined ? { pluginPath: agent.pluginPath } : {}),
      ...(agent.marketplacePath !== undefined ? { marketplacePath: agent.marketplacePath } : {}),
      updatedAt: now(),
    });
  }

  const byProjectCwd = new Map<string, MachineManifestProject>();
  for (const project of existing?.projects ?? []) byProjectCwd.set(project.cwd, project);
  for (const project of opts.registeredProjects ?? []) {
    byProjectCwd.set(project.cwd, { ...project, updatedAt: now() });
  }

  const manifest: MachineManifest = {
    version: 1,
    coodraHome: opts.home,
    entries: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
    agents: [...byAgent.values()].sort((a, b) => a.id.localeCompare(b.id)),
    projects: [...byProjectCwd.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
  };
  if (!opts.dryRun) await writeJsonAtomic(machineManifestPath(opts.home), manifest);
  return manifest;
}
