import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, ensureProject, migrateSqlite } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type MetricsIO, type MetricsOptions, runMetricsCommand } from '../../../src/commands/metrics.js';
import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../../../src/exit-codes.js';
import { resolveCoodraDataDb } from '../../../src/lib/coodra-home.js';

/**
 * `coodra metrics` / `roi` unit tests. A real migrated SQLite is seeded in a
 * tmpdir (no mocks per 01-development-discipline §1.1) including `mcp_call`
 * reuse-read run_events — so the test exercises the reuse-counting query +
 * the modeled-ROI rollup end-to-end.
 */

interface Cap {
  readonly io: MetricsIO;
  out: () => string;
  err: () => string;
}
function makeIo(homePath: string): Cap {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: MetricsIO = {
    writeStdout: (c) => {
      stdout.push(c);
    },
    writeStderr: (c) => {
      stderr.push(c);
    },
    exit: (code) => {
      throw new Error(`__exit__:${code}`);
    },
    coodraHome: homePath,
  };
  return { io, out: () => stdout.join(''), err: () => stderr.join('') };
}

async function run(options: MetricsOptions, io: MetricsIO): Promise<number> {
  try {
    await runMetricsCommand(options, io);
    return -1;
  } catch (err) {
    const m = (err as Error).message.match(/^__exit__:(\d+)$/);
    if (m) return Number(m[1]);
    throw err;
  }
}

let cwd: string;
let homePath: string;

async function seed(): Promise<void> {
  const handle = createDb({ kind: 'local', sqlite: { path: resolveCoodraDataDb(homePath) } });
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
  migrateSqlite(handle.db);
  // Strip the migration's __global__ sentinel project + its synthetic
  // backfill run so the fixture counts are isolated and exact.
  handle.raw.prepare("DELETE FROM runs WHERE project_id = '__global__'").run();
  handle.raw.prepare("DELETE FROM projects WHERE id = '__global__'").run();
  const project = await ensureProject(handle, { slug: 'metrics-test' });
  const pid = project.id;
  const raw = handle.raw;
  raw
    .prepare('INSERT INTO runs (id, project_id, session_id, agent_type, mode, status) VALUES (?,?,?,?,?,?)')
    .run('run1', pid, 's1', 'claude_code', 'solo', 'completed');
  raw
    .prepare('INSERT INTO runs (id, project_id, session_id, agent_type, mode, status) VALUES (?,?,?,?,?,?)')
    .run('run2', pid, 's2', 'claude_code', 'solo', 'in_progress');
  // 3 native tool calls + 2 mcp_call reuse reads (both on run1).
  const ev = raw.prepare(
    'INSERT INTO run_events (id, run_id, phase, tool_name, tool_use_id, tool_input) VALUES (?,?,?,?,?,?)',
  );
  ev.run('e1', 'run1', 'post', 'Bash', 'tu1', '{}');
  ev.run('e2', 'run1', 'post', 'Edit', 'tu2', '{}');
  ev.run('e3', 'run1', 'post', 'Write', 'tu3', '{}');
  ev.run('e4', 'run1', 'mcp_call', 'coodra__search_packs_nl', 'tu4', '{}');
  ev.run('e5', 'run1', 'mcp_call', 'coodra__query_run_history', 'tu5', '{}');
  // policy decisions: 3 allow, 1 deny, 1 ask.
  const pd = raw.prepare(
    'INSERT INTO policy_decisions (id, idempotency_key, run_id, session_id, project_id, agent_type, event_type, tool_name, tool_input_snapshot, permission_decision, reason) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  );
  for (const [i, d] of (['allow', 'allow', 'allow', 'deny', 'ask'] as const).entries()) {
    pd.run(`pd${i}`, `idem-${i}`, 'run1', 's1', pid, 'claude_code', 'PreToolUse', 'Bash', '{}', d, 'test');
  }
  // context packs: 1 agent + 1 bridge_auto.
  const cp = raw.prepare(
    'INSERT INTO context_packs (id, run_id, project_id, title, content, source) VALUES (?,?,?,?,?,?)',
  );
  cp.run('cp1', 'run1', pid, 'Agent pack', 'a'.repeat(4000), 'agent');
  cp.run('cp2', 'run2', pid, 'Auto pack', 'b'.repeat(2000), 'bridge_auto');
  // 1 decision.
  raw
    .prepare('INSERT INTO decisions (id, idempotency_key, run_id, description, rationale) VALUES (?,?,?,?,?)')
    .run('d1', 'dec-1', 'run1', 'chose X', 'because Y');
  handle.close();
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'cli-metrics-'));
  homePath = join(cwd, '.coodra');
  mkdirSync(homePath, { recursive: true });
});
afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('runMetricsCommand', () => {
  it('counts measured KPIs (incl. mcp_call reuse reads) and emits modeled ROI as JSON', async () => {
    await seed();
    const cap = makeIo(homePath);
    const code = await run({ json: true }, cap.io);
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(cap.out()) as {
      ok: boolean;
      mode: string;
      measured: Record<string, number | null>;
      modeled: Record<string, unknown>;
      reuseByTool: Array<{ tool: string; count: number }>;
      perProject: Array<{ slug: string; runs: number }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.measured.totalRuns).toBe(2);
    expect(payload.measured.completedRuns).toBe(1);
    expect(payload.measured.toolCalls).toBe(5);
    expect(payload.measured.governedActions).toBe(5);
    expect(payload.measured.blockedActions).toBe(1);
    expect(payload.measured.askActions).toBe(1);
    expect(payload.measured.contextPacks).toBe(2);
    expect(payload.measured.agentPacks).toBe(1);
    expect(payload.measured.decisions).toBe(1);
    // The two mcp_call reuse reads are counted; both on run1 → 1 distinct run.
    expect(payload.measured.reuseReads).toBe(2);
    expect(payload.measured.runsWithReuse).toBe(1);
    expect(payload.measured.linkRatePct).toBe(100);
    // Modeled rollup present + sane (reuse + blocks present → benefit > 0).
    expect(typeof payload.modeled.netValueUsd).toBe('number');
    expect(payload.modeled.creditsSavedUsd as number).toBeGreaterThan(0);
    expect(payload.modeled.timeReclaimedHours as number).toBeGreaterThan(0); // 2 reuse + 1 block
    expect(payload.reuseByTool.map((t) => t.tool)).toEqual(
      expect.arrayContaining(['coodra__search_packs_nl', 'coodra__query_run_history']),
    );
    expect(payload.perProject).toEqual([{ slug: 'metrics-test', runs: 2, lastRunAt: expect.any(String) }]);
  });

  it('renders a human report with the four sections', async () => {
    await seed();
    const cap = makeIo(homePath);
    const code = await run({}, cap.io);
    expect(code).toBe(EXIT_OK);
    const text = cap.out();
    expect(text).toMatch(/net \$/);
    expect(text).toMatch(/IMPACT · MODELED/);
    expect(text).toMatch(/KNOWLEDGE CAPITALIZATION/);
    expect(text).toMatch(/reuse reads/);
    expect(text).toMatch(/GOVERNANCE/);
    expect(text).toMatch(/metrics-test/);
  });

  it('exits EXIT_OK with a hint when no projects are registered', async () => {
    // migrate only — no project rows.
    const handle = createDb({ kind: 'local', sqlite: { path: resolveCoodraDataDb(homePath) } });
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
    migrateSqlite(handle.db);
    handle.raw.prepare("DELETE FROM runs WHERE project_id = '__global__'").run();
    handle.raw.prepare("DELETE FROM projects WHERE id = '__global__'").run();
    handle.close();
    const cap = makeIo(homePath);
    const code = await run({}, cap.io);
    expect(code).toBe(EXIT_OK);
    expect(cap.out()).toMatch(/no projects registered yet/);
  });

  it('rejects an unknown --project slug with EXIT_USER_RECOVERABLE', async () => {
    await seed();
    const cap = makeIo(homePath);
    const code = await run({ project: 'does-not-exist' }, cap.io);
    expect(code).toBe(EXIT_USER_RECOVERABLE);
    expect(cap.err()).toMatch(/not registered/);
  });
});
