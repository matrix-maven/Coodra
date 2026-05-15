import {
  type ContextPackRow,
  cancelRun,
  type DecisionRow,
  getRunWithEverything,
  type ListRunsFilter,
  listRunsForProject,
  lookupProjectBySlug,
  type PolicyDecisionRow,
  type RunEventRow,
  type RunRow,
  type RunWithEverything,
} from '@coodra/db';
import { EXIT_OK, EXIT_USER_ACTION_REQUIRED, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { resolveCoodraDataDb, resolveCoodraHome } from '../lib/coodra-home.js';
import { openLocalDb } from '../lib/open-local-db.js';
import {
  commandTitle,
  errorLine,
  hintLine,
  kvBlock,
  okLine,
  paint,
  sectionHead,
  terminalWidth,
  timelineRow,
  type Verdict,
} from '../ui/index.js';

/**
 * `coodra run {list|show|cancel}` — admin surface for the `runs`
 * table + every per-run audit row. Module 08b S11.
 *
 * Per OQ-6 lock (2026-05-03), `cancel` is informational metadata
 * only — it does NOT block future events at the bridge. The bridge's
 * latency-sensitive PostToolUse path skips a `runs.status` lookup;
 * cancellation is a record of operator intent, not enforcement.
 *
 * `show <runId>` formats as a human-readable timeline by default
 * (events ordered by created_at) and emits the structured object
 * verbatim under `--json`.
 */

export interface RunListOptions {
  readonly project?: string;
  readonly status?: string;
  readonly limit?: string;
  readonly json?: boolean;
}

export interface RunShowOptions {
  readonly json?: boolean;
}

export interface RunCancelOptions {
  readonly json?: boolean;
  readonly force?: boolean;
}

export interface RunIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
  readonly coodraHome?: string;
}

export const DEFAULT_RUN_IO: RunIO = {
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

// ============================================================================
// list
// ============================================================================

export async function runRunListCommand(options: RunListOptions, ioOverride?: RunIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_RUN_IO;
  const json = options.json === true;
  const handle = await openHandle(io);
  try {
    let projectId: string | undefined;
    if (options.project !== undefined && options.project.length > 0) {
      const project = await lookupProjectBySlug(handle, options.project.trim());
      if (project === null) {
        return surfaceError(io, json, EXIT_USER_RECOVERABLE, `project slug "${options.project}" does not exist`);
      }
      projectId = project.id;
    }
    let status: string | undefined;
    if (options.status !== undefined && options.status.length > 0) {
      status = options.status.trim();
    }
    let limit: number | undefined;
    if (options.limit !== undefined) {
      const n = Number(options.limit);
      if (!Number.isInteger(n) || n < 1 || n > 1000) {
        return surfaceError(
          io,
          json,
          EXIT_USER_RECOVERABLE,
          `--limit must be an integer between 1 and 1000 (got "${options.limit}")`,
        );
      }
      limit = n;
    }
    const filter: ListRunsFilter = {
      ...(projectId !== undefined ? { projectId } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
    const rows = await listRunsForProject(handle, filter);
    if (json) {
      io.writeStdout(`${JSON.stringify({ ok: true, runs: rows.map(serializeRun) }, null, 2)}\n`);
    } else if (rows.length === 0) {
      io.writeStdout(`${hintLine('— no runs match the filter.')}\n`);
    } else {
      for (const r of rows) {
        printRunHumanShort(io, r);
      }
    }
    io.exit(EXIT_OK);
  } finally {
    handle.close();
  }
}

// ============================================================================
// show
// ============================================================================

export async function runRunShowCommand(runId: string, options: RunShowOptions, ioOverride?: RunIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_RUN_IO;
  const json = options.json === true;
  if (runId.trim().length === 0) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, 'run show requires <runId>');
  }
  const handle = await openHandle(io);
  try {
    const result = await getRunWithEverything(handle, runId.trim());
    if (result === null) {
      return surfaceError(io, json, EXIT_USER_RECOVERABLE, `no run with id "${runId}"`);
    }
    if (json) {
      io.writeStdout(`${JSON.stringify({ ok: true, ...serializeRunWithEverything(result) }, null, 2)}\n`);
    } else {
      printRunWithEverythingHuman(io, result);
    }
    io.exit(EXIT_OK);
  } finally {
    handle.close();
  }
}

// ============================================================================
// cancel
// ============================================================================

export async function runRunCancelCommand(runId: string, options: RunCancelOptions, ioOverride?: RunIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_RUN_IO;
  const json = options.json === true;
  if (runId.trim().length === 0) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, 'run cancel requires <runId>');
  }
  const handle = await openHandle(io);
  try {
    const result = await cancelRun(handle, runId.trim());
    if (result.status === 'not_found') {
      return surfaceError(io, json, EXIT_USER_RECOVERABLE, `no run with id "${runId}"`);
    }
    if (result.status === 'already_terminal') {
      return surfaceError(
        io,
        json,
        EXIT_USER_ACTION_REQUIRED,
        `run "${runId}" is already in terminal state "${result.run.status}" — nothing to cancel`,
      );
    }
    if (json) {
      io.writeStdout(`${JSON.stringify({ ok: true, status: 'cancelled', run: serializeRun(result.run) }, null, 2)}\n`);
    } else {
      io.writeStdout(`${okLine(`Cancelled run ${result.run.id}.`)}\n`);
      io.writeStdout(
        `  ${hintLine('Note: cancellation is informational; the bridge keeps recording any post-cancel events for audit.')}\n`,
      );
    }
    io.exit(EXIT_OK);
  } finally {
    handle.close();
  }
}

// ============================================================================
// helpers
// ============================================================================

async function openHandle(io: RunIO): Promise<Awaited<ReturnType<typeof openLocalDb>>> {
  const homePath = io.coodraHome ?? resolveCoodraHome();
  const dbPath = resolveCoodraDataDb(homePath);
  return await openLocalDb(dbPath);
}

interface SerializedRun {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly agentType: string;
  readonly mode: string;
  readonly status: string;
  readonly issueRef: string | null;
  readonly prRef: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

function serializeRun(r: RunRow): SerializedRun {
  return {
    id: r.id,
    projectId: r.projectId,
    sessionId: r.sessionId,
    agentType: r.agentType,
    mode: r.mode,
    status: r.status,
    issueRef: r.issueRef,
    prRef: r.prRef,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null,
  };
}

function serializeRunWithEverything(r: RunWithEverything): {
  run: SerializedRun;
  events: ReadonlyArray<unknown>;
  policyDecisions: ReadonlyArray<unknown>;
  decisions: ReadonlyArray<unknown>;
  contextPack: unknown | null;
} {
  return {
    run: serializeRun(r.run),
    events: r.events.map((e) => ({
      id: e.id,
      runId: e.runId,
      phase: e.phase,
      toolName: e.toolName,
      toolUseId: e.toolUseId,
      toolInput: e.toolInput,
      outcome: e.outcome,
      createdAt: e.createdAt.toISOString(),
    })),
    policyDecisions: r.policyDecisions.map((p) => ({
      id: p.id,
      idempotencyKey: p.idempotencyKey,
      runId: p.runId,
      sessionId: p.sessionId,
      projectId: p.projectId,
      agentType: p.agentType,
      eventType: p.eventType,
      toolName: p.toolName,
      permissionDecision: p.permissionDecision,
      matchedRuleId: p.matchedRuleId,
      reason: p.reason,
      createdAt: p.createdAt.toISOString(),
    })),
    decisions: r.decisions.map((d) => ({
      id: d.id,
      idempotencyKey: d.idempotencyKey,
      runId: d.runId,
      description: d.description,
      rationale: d.rationale,
      alternatives: d.alternatives,
      createdAt: d.createdAt.toISOString(),
    })),
    contextPack:
      r.contextPack === null
        ? null
        : {
            id: r.contextPack.id,
            runId: r.contextPack.runId,
            projectId: r.contextPack.projectId,
            title: r.contextPack.title,
            contentExcerpt: r.contextPack.contentExcerpt,
            createdAt: r.contextPack.createdAt.toISOString(),
          },
  };
}

/** Map a `runs.status` value onto an axis verdict. */
function runVerdict(status: string): Verdict {
  switch (status) {
    case 'completed':
      return 'ok';
    case 'failed':
      return 'fail';
    case 'in_progress':
      return 'warn';
    default:
      // cancelled · abandoned
      return 'idle';
  }
}

function printRunHumanShort(io: RunIO, r: RunRow): void {
  // Each run is a node observed on the context axis.
  io.writeStdout(
    `${timelineRow(
      {
        verdict: runVerdict(r.status),
        when: r.startedAt.toISOString(),
        id: r.id,
        status: r.status,
        meta: `${r.agentType} · ${r.sessionId}`,
      },
      { whenWidth: 26, idWidth: 40, statusWidth: 12 },
    )}\n`,
  );
}

function printRunWithEverythingHuman(io: RunIO, x: RunWithEverything): void {
  const r = x.run;
  const width = terminalWidth();
  io.writeStdout(`${commandTitle('Run', r.id, { width, indent: 0 })}\n`);
  io.writeStdout(
    `${kvBlock(
      [
        { key: 'status', value: r.status, valueTone: 'ink' },
        { key: 'project', value: r.projectId },
        { key: 'session', value: r.sessionId },
        { key: 'agent', value: `${r.agentType} (mode: ${r.mode})` },
        { key: 'started', value: r.startedAt.toISOString() },
        { key: 'ended', value: r.endedAt?.toISOString() ?? '(in progress)' },
        ...(r.issueRef !== null ? [{ key: 'issue', value: r.issueRef } as const] : []),
        ...(r.prRef !== null ? [{ key: 'pr', value: r.prRef } as const] : []),
      ],
      { keyWidth: 12, indent: 2 },
    )}\n`,
  );

  io.writeStdout(`\n${sectionHead('01', `events (${x.events.length})`, { width })}\n`);
  if (x.events.length === 0) {
    io.writeStdout(`  ${hintLine('(none)')}\n`);
  } else {
    for (const e of x.events) {
      io.writeStdout(
        `  ${paint.inkFar(`[${e.createdAt.toISOString()}]`)} ${paint.inkDim(e.phase.padEnd(12, ' '))} ${paint.ink(e.toolName)} ${paint.inkFar(`(${e.toolUseId})`)}\n`,
      );
    }
  }

  io.writeStdout(`\n${sectionHead('02', `policy decisions (${x.policyDecisions.length})`, { width })}\n`);
  if (x.policyDecisions.length === 0) {
    io.writeStdout(`  ${hintLine('(none)')}\n`);
  } else {
    for (const p of x.policyDecisions) {
      const tint =
        p.permissionDecision === 'deny'
          ? paint.crimson
          : p.permissionDecision === 'allow'
            ? paint.phosphor
            : paint.amber;
      io.writeStdout(
        `  ${paint.inkFar(`[${p.createdAt.toISOString()}]`)} ${tint(p.permissionDecision.padEnd(5, ' '))} ${paint.ink(p.toolName)} ${paint.inkFar('—')} ${paint.inkDim(p.reason)}\n`,
      );
    }
  }

  io.writeStdout(`\n${sectionHead('03', `decisions (${x.decisions.length})`, { width })}\n`);
  if (x.decisions.length === 0) {
    io.writeStdout(`  ${hintLine('(none)')}\n`);
  } else {
    for (const d of x.decisions) {
      io.writeStdout(
        `  ${paint.inkFar(`[${d.createdAt.toISOString()}]`)} ${paint.ink(d.description)}\n    ${paint.inkFar('rationale:')} ${paint.inkDim(d.rationale)}\n`,
      );
    }
  }

  io.writeStdout(`\n${sectionHead('04', 'context pack', { width })}\n`);
  if (x.contextPack === null) {
    io.writeStdout(`  ${hintLine('(none — no context pack saved for this run)')}\n`);
  } else {
    io.writeStdout(
      `${kvBlock(
        [
          { key: 'id', value: x.contextPack.id },
          { key: 'title', value: x.contextPack.title },
          {
            key: 'excerpt',
            value: `${x.contextPack.contentExcerpt.slice(0, 200)}${x.contextPack.contentExcerpt.length > 200 ? '…' : ''}`,
          },
        ],
        { keyWidth: 10, indent: 2 },
      )}\n`,
    );
  }
}

function surfaceError(io: RunIO, json: boolean, exitCode: number, message: string): void {
  if (json) {
    io.writeStdout(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  } else {
    io.writeStderr(`${errorLine(message)}\n`);
  }
  io.exit(exitCode);
}

void ({} as RunEventRow);
void ({} as PolicyDecisionRow);
void ({} as DecisionRow);
void ({} as ContextPackRow);
