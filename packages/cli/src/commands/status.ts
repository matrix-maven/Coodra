import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT_OK, EXIT_USER_ACTION_REQUIRED, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { resolveCoodraHome } from '../lib/coodra-home.js';
import { selectDaemonManager } from '../lib/daemon/index.js';
import { loadHomeEnv } from '../lib/load-home-env.js';
import { openLocalDb } from '../lib/open-local-db.js';
import { readPidStatus } from '../lib/pid-status.js';
import { SERVICES } from '../lib/services.js';
import { readTeamConfig } from '../lib/team-config.js';
import {
  type CheckTone,
  checkGlyph,
  commandTitle,
  hintLine,
  type KvRow,
  kvBlock,
  kvRow,
  sectionHead,
  terminalWidth,
  warnLine,
} from '../ui/index.js';

export interface StatusOptions {
  readonly json?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly home?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface StatusIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_STATUS_IO: StatusIO = {
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

export interface ProjectState {
  readonly slug: string | null;
  readonly registered: boolean;
  readonly projectId: string | null;
  readonly cwd: string;
  readonly mode: string;
  /**
   * W6 / beta.6 — the project's actual `org_id` from the local DB.
   * `__solo__` / `__global__` / null → local-only; a real `org_…` →
   * synced to that team org. Independent of the machine mode.
   */
  readonly orgId: string | null;
  readonly notes: string[];
}

export interface ServiceState {
  readonly name: string;
  readonly displayName: string;
  readonly kind: 'http' | 'worker';
  readonly state: 'running' | 'stopped' | 'unknown';
  /** Null for worker services (sync-daemon). */
  readonly port: number | null;
  /** Empty string for worker services. */
  readonly url: string;
}

export interface RecentState {
  readonly lastRun: { id: string; status: string; startedAt: string; agentType: string } | null;
  readonly lastDecision: { description: string; createdAt: string } | null;
  readonly blockerNote: string | null;
}

export interface MachineModeState {
  /**
   * The mode the machine is configured for, per
   * `~/.coodra/config.json::mode`. This is the SOLE authority for
   * machine mode (Phase A, clarity-pass-plan 2026-05-11) — env vars
   * and project `.env` files are derived from it, never the other
   * way around.
   */
  readonly mode: 'solo' | 'team';
  /** Clerk org slug, when in team mode and the config block carries one. */
  readonly orgSlug: string | null;
  /** Clerk org id, when in team mode. Falls back to `null` for solo. */
  readonly orgId: string | null;
  /**
   * The literal value of `process.env.COODRA_MODE` when set, or `null`
   * when unset. Surfaced for diagnostic output ("shell says X but config
   * says Y"). `envDriftsFromConfig` is the derived boolean signal.
   */
  readonly shellModeValue: string | null;
  /**
   * Drift signal: true when `process.env.COODRA_MODE` is set AND
   * disagrees with the config.json mode. `coodra start` would
   * still pick the home-env layer (which wins for MACHINE_LEVEL_KEYS
   * after Phase A's `load-home-env` fix), but a drift here means the
   * operator's shell will mislead them when they `echo $COODRA_MODE`.
   */
  readonly envDriftsFromConfig: boolean;
}

export interface StatusReport {
  readonly machine: MachineModeState;
  readonly project: ProjectState;
  readonly services: ServiceState[];
  readonly recent: RecentState;
  readonly coodraHome: string;
}

export async function runStatusCommand(options: StatusOptions = {}, io: StatusIO = DEFAULT_STATUS_IO): Promise<never> {
  const baseEnv = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const coodraHome = resolveCoodraHome({
    ...(options.home !== undefined ? { override: options.home } : {}),
    env: baseEnv,
  });
  // Layer ~/.coodra/.env + <cwd>/.env in so that team-mode flags
  // surface in `ctx status` even when the operator hasn't exported
  // COODRA_MODE in their shell. Without this, status from a
  // non-demo cwd reports the worker as "stopped" because the
  // `requiresTeamMode` filter trips off the team check entirely.
  const layered = loadHomeEnv(coodraHome, cwd);
  const env: NodeJS.ProcessEnv = { ...layered, ...baseEnv };
  const fetchImpl = options.fetchImpl ?? fetch;

  const machine = collectMachineMode(coodraHome, baseEnv);
  // Project mode is INHERITED from the machine — sourcing it from
  // `machine.mode` (config.json) rather than `env.COODRA_MODE` keeps
  // the two lines in agreement even when the operator's shell carries
  // a stale `COODRA_MODE` override. The drift signal in
  // `machine.envDriftsFromConfig` already surfaces the override
  // separately as a `⚠`.
  const project = await collectProjectState(cwd, coodraHome, env, machine.mode);
  const services = await collectServiceStates(env, fetchImpl, coodraHome);
  const recent = await collectRecentState(coodraHome, project.projectId);

  const report: StatusReport = { machine, project, services, recent, coodraHome };

  if (options.json === true) {
    io.writeStdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    io.writeStdout(formatHumanReport(report));
  }

  const exit = decideExit(report);
  return io.exit(exit);
}

/**
 * Read the machine-level mode from `~/.coodra/config.json` and compare
 * it to the operator's shell `COODRA_MODE` to detect drift.
 *
 * `baseEnv` (the original `process.env`, NOT the layered one) is used
 * deliberately — the layered env always agrees with config.json because
 * `loadHomeEnv` writes the home value on top for MACHINE_LEVEL_KEYS. The
 * drift signal we want here is "what does the operator's terminal show?"
 * which is the un-layered `process.env`.
 */
function collectMachineMode(coodraHome: string, baseEnv: NodeJS.ProcessEnv): MachineModeState {
  const cfg = readTeamConfig({ homeOverride: coodraHome });
  const mode: 'solo' | 'team' = cfg.mode;
  const orgSlug = cfg.team?.clerkOrgSlug ?? null;
  const orgId = cfg.team?.clerkOrgId ?? null;
  const shellModeValue =
    typeof baseEnv.COODRA_MODE === 'string' && baseEnv.COODRA_MODE.length > 0 ? baseEnv.COODRA_MODE : null;
  const envDriftsFromConfig = shellModeValue !== null && shellModeValue !== mode;
  return { mode, orgSlug, orgId, shellModeValue, envDriftsFromConfig };
}

async function collectProjectState(
  cwd: string,
  coodraHome: string,
  _env: NodeJS.ProcessEnv,
  inheritedMode: 'solo' | 'team',
): Promise<ProjectState> {
  const configPath = join(cwd, '.coodra.json');
  const notes: string[] = [];
  let slug: string | null = null;
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as { projectSlug?: unknown };
    if (typeof parsed.projectSlug === 'string') slug = parsed.projectSlug;
  } catch {
    notes.push('.coodra.json missing — bridge will fall back to __global__ for this cwd');
  }
  // Resolve the slug to a projects.id in local SQLite so `collectRecent`
  // can scope the "Last run / Last decision" query to THIS project.
  // Without this lookup, status's recent block showed the latest run
  // across all projects (typically a migration backfill sentinel) on
  // every fresh project — confusing for a user who just init'd and
  // has never opened a Claude Code session. (Demo finding 2026-05-11.)
  let projectId: string | null = null;
  let registered = false;
  // W6 / beta.6 — the PROJECT's org scope is independent of the MACHINE
  // mode. A team-mode machine can host solo (`org_id=__solo__`) projects.
  // Read the actual org_id off the row instead of assuming it inherits.
  let projectOrgId: string | null = null;
  if (slug !== null) {
    try {
      const dataDb = join(coodraHome, 'data.db');
      const handle = await openLocalDb(dataDb);
      try {
        const row = handle.raw.prepare('SELECT id, org_id FROM projects WHERE slug = ? LIMIT 1').get(slug) as
          | { id: string; org_id: string }
          | undefined;
        if (row !== undefined) {
          projectId = row.id;
          projectOrgId = row.org_id;
          registered = true;
        }
      } finally {
        handle.close();
      }
    } catch {
      // DB missing / unreadable — leave registered=false and projectId=null.
      // The note from the missing-.coodra.json branch already covers
      // the "you need to init" case; nothing extra to surface here.
    }
  }
  // Derive the project's effective mode from its org_id, falling back to
  // the machine mode for an unregistered cwd (no row → can't know yet).
  const isLocalOnlyOrg = projectOrgId === null || projectOrgId === '__solo__' || projectOrgId === '__global__';
  const projectMode: 'solo' | 'team' = registered ? (isLocalOnlyOrg ? 'solo' : 'team') : inheritedMode;
  return { slug, registered, projectId, cwd, mode: projectMode, orgId: projectOrgId, notes };
}

async function collectServiceStates(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  coodraHome: string,
): Promise<ServiceState[]> {
  const mcpPort = parsePort(env.MCP_SERVER_PORT, 3100);
  const bridgePort = parsePort(env.HOOKS_BRIDGE_PORT, 3101);
  // W6 / beta.6 — the web service (W1) was never wired into status's
  // port resolution; the `: bridgePort` fallthrough showed it on :3101
  // (the bridge's port), probed the bridge's non-existent /api/healthz,
  // got a 404, and reported the web as "unknown" forever.
  const webPort = parsePort(env.COODRA_WEB_PORT, 3001);
  const isTeamMode = env.COODRA_MODE === 'team';

  const states: ServiceState[] = [];
  for (const descriptor of SERVICES) {
    if (descriptor.kind === 'worker' && descriptor.requiresTeamMode && !isTeamMode) {
      // Don't surface workers that aren't applicable in solo mode.
      continue;
    }
    if (descriptor.kind === 'http') {
      const port = descriptor.name === 'mcp-server' ? mcpPort : descriptor.name === 'web' ? webPort : bridgePort;
      const url = descriptor.healthUrl(port);
      let state: ServiceState['state'] = 'stopped';
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1500);
        const response = await fetchImpl(url, { signal: controller.signal });
        clearTimeout(timeout);
        state = response.ok ? 'running' : 'unknown';
      } catch {
        state = 'stopped';
      }
      states.push({
        name: descriptor.name,
        displayName: descriptor.displayName,
        kind: 'http',
        state,
        port,
        url,
      });
    } else {
      // Worker: ask the active daemon manager. launchd-managed daemons
      // do NOT write to ~/.coodra/pids/, so the PID-file fallback
      // alone reports stopped even when the daemon is running. Try the
      // manager first, fall back to PID file for the no-launchd
      // (`fallback`) manager which DOES write the PID file at start.
      let state: ServiceState['state'] = 'stopped';
      try {
        const manager = await selectDaemonManager({ coodraHome });
        const ds = await manager.status(descriptor.name);
        if (ds.state === 'running') state = 'running';
        else if (ds.state === 'unknown') state = 'unknown';
        else state = 'stopped';
      } catch {
        const pid = await readPidStatus(coodraHome, descriptor.name);
        state = pid.state === 'alive' ? 'running' : pid.state === 'dead' ? 'unknown' : 'stopped';
      }
      states.push({
        name: descriptor.name,
        displayName: descriptor.displayName,
        kind: 'worker',
        state,
        port: null,
        url: '',
      });
    }
  }
  return states;
}

async function collectRecentState(coodraHome: string, projectId: string | null): Promise<RecentState> {
  const dataDb = join(coodraHome, 'data.db');
  let dbExists = true;
  try {
    await access(dataDb);
  } catch {
    dbExists = false;
  }
  if (!dbExists) {
    return { lastRun: null, lastDecision: null, blockerNote: null };
  }

  let handle: Awaited<ReturnType<typeof openLocalDb>>;
  try {
    handle = await openLocalDb(dataDb);
  } catch {
    return { lastRun: null, lastDecision: null, blockerNote: null };
  }
  try {
    const runRow = (() => {
      try {
        const row = handle.raw
          .prepare(
            `SELECT id, status, started_at, agent_type FROM runs ${
              projectId !== null ? 'WHERE project_id = ?' : ''
            } ORDER BY started_at DESC LIMIT 1`,
          )
          .get(...(projectId !== null ? [projectId] : [])) as
          | { id: string; status: string; started_at: number; agent_type: string }
          | undefined;
        if (row === undefined) return null;
        return {
          id: row.id,
          status: row.status,
          startedAt: new Date(row.started_at * 1000).toISOString(),
          agentType: row.agent_type,
        };
      } catch {
        return null;
      }
    })();

    const decisionRow = (() => {
      try {
        // Scope to the current project when known. The `decisions` table
        // has no direct project_id FK — it's keyed by `run_id`, which
        // foreign-keys to `runs.project_id`. So we join through `runs`
        // to filter by the current project. Falls back to the latest
        // decision across all projects when projectId is null
        // (unregistered cwd).
        const row = handle.raw
          .prepare(
            projectId !== null
              ? `SELECT d.description, d.created_at FROM decisions d
                 JOIN runs r ON r.id = d.run_id
                 WHERE r.project_id = ?
                 ORDER BY d.created_at DESC LIMIT 1`
              : `SELECT description, created_at FROM decisions ORDER BY created_at DESC LIMIT 1`,
          )
          .get(...(projectId !== null ? [projectId] : [])) as { description: string; created_at: number } | undefined;
        if (row === undefined) return null;
        return {
          description: row.description,
          createdAt: new Date(row.created_at * 1000).toISOString(),
        };
      } catch {
        return null;
      }
    })();

    let blockerNote: string | null = null;
    try {
      const blockersPath = join(process.cwd(), 'context_memory', 'blockers.md');
      const stats = await stat(blockersPath);
      if (stats.size > 0) {
        const raw = await readFile(blockersPath, 'utf8');
        if (raw.trim().length > 0) blockerNote = `${raw.trim().slice(0, 80)}…`;
      }
    } catch {
      /* no blockers file */
    }

    return { lastRun: runRow, lastDecision: decisionRow, blockerNote };
  } finally {
    handle.close();
  }
}

function formatHumanReport(report: StatusReport): string {
  const width = terminalWidth();
  const m = report.machine;
  const p = report.project;
  const lines: string[] = [];

  lines.push(commandTitle('Status', 'project + service state', { width, indent: 0 }));
  lines.push('');

  // /01 machine — the machine mode is the sole authority (config.json),
  // surfaced first so the operator sees "what mode is this laptop in?"
  lines.push(sectionHead('01', 'machine', { width }));
  const machineRows: KvRow[] = [{ key: 'mode', value: m.mode, valueTone: m.mode === 'team' ? 'blue' : 'inkDim' }];
  if (m.mode === 'team' && (m.orgSlug !== null || m.orgId !== null)) {
    machineRows.push({
      key: 'org',
      value: m.orgSlug ?? (m.orgId !== null ? `${m.orgId.slice(0, 12)}…` : '—'),
    });
  }
  lines.push(kvBlock(machineRows, { keyWidth: 14, indent: 2 }));
  if (m.envDriftsFromConfig) {
    // Shell COODRA_MODE disagrees with config.json — the daemon
    // spawn-env layer neutralises it, but the operator's terminal will
    // mislead them. The fix is shell-side (`unset COODRA_MODE`).
    lines.push(
      `  ${warnLine(`shell $COODRA_MODE=${m.shellModeValue ?? ''} disagrees with config.json (mode=${m.mode}) — \`unset COODRA_MODE\` to clear`)}`,
    );
  }
  lines.push('');

  // /02 project — the project's org scope is independent of machine mode.
  lines.push(sectionHead('02', 'project', { width }));
  let modeMeta: string;
  if (!p.registered) {
    modeMeta = 'cwd not yet registered — run `coodra init`';
  } else if (p.mode === 'team') {
    modeMeta = `syncs to ${p.orgId !== null ? `${p.orgId.slice(0, 16)}…` : 'team org'}`;
  } else {
    modeMeta = 'local-only — `coodra project promote` to share';
  }
  const projectRows: KvRow[] = [
    {
      glyph: checkGlyph(p.slug !== null ? 'ok' : 'warn'),
      key: 'slug',
      value: p.slug ?? '(unregistered)',
      valueTone: p.slug === null ? 'amber' : 'ink',
    },
    { key: 'cwd', value: p.cwd },
    { key: 'mode', value: p.mode, meta: modeMeta },
    { glyph: checkGlyph(p.registered ? 'ok' : 'warn'), key: 'registered', value: p.registered ? 'yes' : 'no' },
  ];
  lines.push(kvBlock(projectRows, { keyWidth: 14, indent: 2 }));
  for (const note of p.notes) {
    lines.push(`  ${warnLine(note)}`);
  }
  lines.push('');

  // /03 services — same dot vocabulary as the TUI Status view.
  lines.push(sectionHead('03', 'services', { width }));
  for (const service of report.services) {
    const tone: CheckTone = service.state === 'running' ? 'ok' : service.state === 'stopped' ? 'fail' : 'warn';
    lines.push(
      kvRow(
        {
          glyph: checkGlyph(tone),
          key: service.displayName,
          value: service.state,
          valueTone: service.state === 'running' ? 'phosphor' : service.state === 'stopped' ? 'crimson' : 'amber',
          meta: service.port !== null ? `:${service.port}  ${service.url}` : '(worker)',
        },
        { keyWidth: 26, indent: 2 },
      ),
    );
  }
  lines.push('');

  // /04 recent — the latest observed run + decision + blocker state.
  lines.push(sectionHead('04', 'recent', { width }));
  const recentRows: KvRow[] = [];
  if (report.recent.lastRun !== null) {
    const r = report.recent.lastRun;
    recentRows.push({ key: 'last run', value: r.startedAt, meta: `status=${r.status} · agent=${r.agentType}` });
  } else {
    recentRows.push({ key: 'last run', value: '(none)', valueTone: 'inkFar' });
  }
  if (report.recent.lastDecision !== null) {
    const d = report.recent.lastDecision;
    recentRows.push({ key: 'last decision', value: `"${d.description.slice(0, 60)}"`, meta: d.createdAt });
  } else {
    recentRows.push({ key: 'last decision', value: '(none)', valueTone: 'inkFar' });
  }
  lines.push(kvBlock(recentRows, { keyWidth: 16, indent: 2 }));
  if (report.recent.blockerNote !== null) {
    lines.push(
      kvRow(
        { glyph: checkGlyph('warn'), key: 'pending blocker', value: report.recent.blockerNote, valueTone: 'amber' },
        { keyWidth: 16, indent: 2 },
      ),
    );
  } else {
    lines.push(
      kvRow(
        { glyph: checkGlyph('ok'), key: 'pending blocker', value: 'context_memory/blockers.md is empty' },
        { keyWidth: 16, indent: 2 },
      ),
    );
  }
  lines.push('');
  lines.push(hintLine('  Run `coodra doctor` for the full diagnostic.'));
  return `${lines.join('\n')}\n`;
}

function decideExit(report: StatusReport): 0 | 1 | 2 {
  const allDown = report.services.every((s) => s.state === 'stopped');
  if (allDown) return EXIT_USER_ACTION_REQUIRED as 2;
  const someDown = report.services.some((s) => s.state !== 'running');
  const unregistered = !report.project.registered && report.project.slug === null;
  if (someDown || unregistered) return EXIT_USER_RECOVERABLE as 1;
  return EXIT_OK as 0;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return fallback;
  return parsed;
}
