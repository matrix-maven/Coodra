import {
  GLOBAL_PROJECT_ID,
  getProjectByIdentifier,
  listProjects,
  type ProjectDetailRow,
  type ProjectListRow,
  type ResetProjectResult,
  resetProject,
} from '@coodra/contextos-db';
import pc from 'picocolors';

import { EXIT_OK, EXIT_USER_ACTION_REQUIRED, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { resolveContextosDataDb, resolveContextosHome } from '../lib/contextos-home.js';
import { openLocalDb } from '../lib/open-local-db.js';

/**
 * `contextos project {list|show|reset}` — admin surface for the
 * `projects` table. Module 08b S10.
 *
 * The `__global__` sentinel is a special row used as the
 * audit-fallback FK for events arriving from cwds that have no
 * `.contextos.json`. `project list` shows it (with a `(sentinel)`
 * tag); `project show __global__` works; `project reset` REFUSES to
 * touch it because losing it would break F7's audit-fallback path.
 */

export interface ProjectListOptions {
  readonly json?: boolean;
  readonly includeGlobal?: boolean;
}

export interface ProjectShowOptions {
  readonly json?: boolean;
}

export interface ProjectResetOptions {
  readonly force?: boolean;
  readonly keepPolicies?: boolean;
  readonly json?: boolean;
}

export interface ProjectIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
  readonly contextosHome?: string;
}

export const DEFAULT_PROJECT_IO: ProjectIO = {
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

export async function runProjectListCommand(options: ProjectListOptions, ioOverride?: ProjectIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_PROJECT_IO;
  const json = options.json === true;
  const handle = await openHandle(io);
  try {
    const all = await listProjects(handle);
    const filtered = options.includeGlobal === true ? all : all.filter((p) => p.id !== GLOBAL_PROJECT_ID);
    if (json) {
      io.writeStdout(`${JSON.stringify({ ok: true, projects: filtered.map(serializeListRow) }, null, 2)}\n`);
    } else if (filtered.length === 0) {
      io.writeStdout(
        `${pc.dim('—')} no projects in this contextos store. Run \`contextos init\` in a project root to register one.\n`,
      );
    } else {
      for (const p of filtered) {
        printListRowHuman(io, p);
      }
    }
    io.exit(EXIT_OK);
  } finally {
    handle.close();
  }
}

export async function runProjectShowCommand(
  identifier: string,
  options: ProjectShowOptions,
  ioOverride?: ProjectIO,
): Promise<void> {
  const io = ioOverride ?? DEFAULT_PROJECT_IO;
  const json = options.json === true;
  if (identifier.trim().length === 0) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, 'project show requires <identifier> (slug or id)');
  }
  const handle = await openHandle(io);
  try {
    const project = await getProjectByIdentifier(handle, identifier.trim());
    if (project === null) {
      return surfaceError(io, json, EXIT_USER_RECOVERABLE, `no project with slug or id "${identifier}"`);
    }
    if (json) {
      io.writeStdout(`${JSON.stringify({ ok: true, project: serializeDetailRow(project) }, null, 2)}\n`);
    } else {
      printDetailRowHuman(io, project);
    }
    io.exit(EXIT_OK);
  } finally {
    handle.close();
  }
}

export async function runProjectResetCommand(
  identifier: string,
  options: ProjectResetOptions,
  ioOverride?: ProjectIO,
): Promise<void> {
  const io = ioOverride ?? DEFAULT_PROJECT_IO;
  const json = options.json === true;
  if (identifier.trim().length === 0) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, 'project reset requires <identifier> (slug or id)');
  }
  const handle = await openHandle(io);
  try {
    const project = await getProjectByIdentifier(handle, identifier.trim());
    if (project === null) {
      return surfaceError(io, json, EXIT_USER_RECOVERABLE, `no project with slug or id "${identifier}"`);
    }
    if (project.id === GLOBAL_PROJECT_ID) {
      return surfaceError(
        io,
        json,
        EXIT_USER_RECOVERABLE,
        `cannot reset the '${GLOBAL_PROJECT_ID}' sentinel — losing it breaks the audit-fallback path for unregistered cwds (F7)`,
      );
    }
    if (options.force !== true) {
      const planned = `${project.runCount} run(s) + their events / decisions / policy_decisions / context_packs`;
      const policyNote =
        options.keepPolicies === false
          ? ' AND their policies + policy_rules + project-scoped kill_switches'
          : ' (policies preserved)';
      return surfaceError(
        io,
        json,
        EXIT_USER_ACTION_REQUIRED,
        `project reset will delete ${planned}${policyNote}. Re-run with --force to confirm.`,
      );
    }
    const result = await resetProject(handle, project.id, {
      keepPolicies: options.keepPolicies !== false,
    });
    if (json) {
      io.writeStdout(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    } else {
      io.writeStdout(`${pc.green('✓')} Reset project "${project.slug}" (${project.id}):\n`);
      io.writeStdout(`  runs:             ${result.runsDeleted}\n`);
      io.writeStdout(`  run_events:       ${result.runEventsDeleted}\n`);
      io.writeStdout(`  policy_decisions: ${result.policyDecisionsDeleted}\n`);
      io.writeStdout(`  decisions:        ${result.decisionsDeleted}\n`);
      io.writeStdout(`  context_packs:    ${result.contextPacksDeleted}\n`);
      if (options.keepPolicies === false) {
        io.writeStdout(`  kill_switches:    ${result.killSwitchesDeleted}\n`);
        io.writeStdout(`  policies:         ${result.policiesDeleted}\n`);
        io.writeStdout(`  policy_rules:     ${result.policyRulesDeleted}\n`);
      } else {
        io.writeStdout(`  policies:         ${pc.dim('preserved (use --keep-policies=false to drop)')}\n`);
      }
    }
    io.exit(EXIT_OK);
  } finally {
    handle.close();
  }
}

async function openHandle(io: ProjectIO): Promise<Awaited<ReturnType<typeof openLocalDb>>> {
  const homePath = io.contextosHome ?? resolveContextosHome();
  const dbPath = resolveContextosDataDb(homePath);
  return await openLocalDb(dbPath);
}

interface SerializedListRow {
  readonly id: string;
  readonly slug: string;
  readonly orgId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly runCount: number;
  readonly lastRunAt: string | null;
  readonly isGlobal: boolean;
}

interface SerializedDetailRow extends SerializedListRow {
  readonly recentRuns: ReadonlyArray<{
    readonly id: string;
    readonly sessionId: string;
    readonly agentType: string;
    readonly status: string;
    readonly startedAt: string;
    readonly endedAt: string | null;
  }>;
  readonly statusCounts: Readonly<Record<string, number>>;
}

function serializeListRow(p: ProjectListRow): SerializedListRow {
  return {
    id: p.id,
    slug: p.slug,
    orgId: p.orgId,
    name: p.name,
    createdAt: p.createdAt.toISOString(),
    runCount: p.runCount,
    lastRunAt: p.lastRunAt?.toISOString() ?? null,
    isGlobal: p.id === GLOBAL_PROJECT_ID,
  };
}

function serializeDetailRow(p: ProjectDetailRow): SerializedDetailRow {
  return {
    ...serializeListRow(p),
    recentRuns: p.recentRuns.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      agentType: r.agentType,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
    })),
    statusCounts: p.statusCounts,
  };
}

function printListRowHuman(io: ProjectIO, p: ProjectListRow): void {
  const tag = p.id === GLOBAL_PROJECT_ID ? pc.dim(' (sentinel)') : '';
  const last = p.lastRunAt === null ? 'never' : p.lastRunAt.toISOString();
  io.writeStdout(`${pc.bold(p.slug)}${tag} — id: ${p.id}\n`);
  io.writeStdout(`  name: ${p.name}\n`);
  io.writeStdout(`  org: ${p.orgId}\n`);
  io.writeStdout(`  runs: ${p.runCount} (last: ${last})\n`);
  io.writeStdout(`  created: ${p.createdAt.toISOString()}\n\n`);
}

function printDetailRowHuman(io: ProjectIO, p: ProjectDetailRow): void {
  printListRowHuman(io, p);
  if (Object.keys(p.statusCounts).length > 0) {
    io.writeStdout('  status breakdown:\n');
    for (const [status, n] of Object.entries(p.statusCounts).sort()) {
      io.writeStdout(`    ${status.padEnd(12, ' ')} ${n}\n`);
    }
  }
  if (p.recentRuns.length > 0) {
    io.writeStdout(`  recent runs (showing ${p.recentRuns.length}):\n`);
    for (const r of p.recentRuns) {
      io.writeStdout(`    ${r.id} (${r.agentType}, ${r.status}, started ${r.startedAt.toISOString()})\n`);
    }
  }
}

function surfaceError(io: ProjectIO, json: boolean, exitCode: number, message: string): void {
  if (json) {
    io.writeStdout(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  } else {
    io.writeStderr(`${pc.red('error')}: ${message}\n`);
  }
  io.exit(exitCode);
}

void ({} as ResetProjectResult);
