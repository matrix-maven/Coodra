import { spawn } from 'node:child_process';
import { openLocalDb } from '../../lib/open-local-db.js';
import { readProjectConfig } from '../../lib/project-store/index.js';
import { bundledMigrationsDir, resolveRuntimeBinary } from '../../lib/runtime-paths.js';
import type { Check } from '../types.js';

/**
 * Slice 5 (2026-05-03 audit §14.1) — synthetic PreToolUse end-to-end
 * loop test. The audit observed: the `__coodra__` matcher bug existed
 * for weeks because doctor only checks process health, not lifecycle
 * correctness. This check calls the native `lifecycle_event` MCP tool
 * directly with a synthetic PreToolUse payload that the default policy
 * MUST deny (Write to `.env`), then asserts the response is
 * `permissionDecision: 'deny'`.
 *
 * COOD-53 (2026-08-08) rewrite: the pre-COOD-53 version POSTed this
 * synthetic event to the now-retired HTTP hooks-bridge
 * (`/v1/hooks/claude-code`). Native plugin lifecycle no longer goes
 * through that bridge for any agent — Claude Code calls `lifecycle_event`
 * via an already-persistent `mcp_tool` session; Codex/Devin/Cursor/
 * Antigravity call it via `hook-runner.mjs`, which spawns `mcp-server`
 * over stdio transport and does the same `initialize` →
 * `notifications/initialized` → `tools/call` handshake this check now
 * performs directly. This check exercises that exact mechanism instead
 * of a transport that no longer carries real traffic, so it still proves
 * the enforcement loop end-to-end (spawn → policy evaluator → deny).
 *
 * What this catches:
 *   - mcp-server process can be spawned and answers stdio (covered
 *     alone by check 9, but this check proves POLICY ENFORCEMENT
 *     specifically, not just that the process answers `initialize`).
 *   - Default policy is seeded (Phase 3 Fix D / Phase 4 Fix F).
 *   - Per-event matcher is shaped correctly (covered by checks 28/39).
 *   - `lifecycle_event`'s PreToolUse handling routes to the policy
 *     evaluator.
 *
 * Side effects:
 *   - Writes ONE row to `policy_decisions` (audit-only append; the
 *     idempotency key is derived from the probe's session id, so
 *     re-running the check produces a single audit row, not a fresh
 *     row per probe). Marked as a doctor-probe in the session_id.
 *   - Does NOT write to `runs` or `run_events` (PreToolUse alone,
 *     with `agentType: 'claude_code'`, does not open a run — see
 *     `resolveRunId` in `apps/mcp-server/src/tools/lifecycle-event/handler.ts`).
 *
 * The synthetic call uses a tool_use_id prefix `doctor-` so a future
 * admin command can sweep doctor-probe rows if the user wants. For
 * v1 they're just audit noise the user can grep filter.
 */

interface HookOutput {
  readonly permissionDecision?: string;
  readonly permissionDecisionReason?: string;
}

function extractHookOutput(response: unknown): HookOutput | null {
  if (response === null || typeof response !== 'object') return null;
  const result = (response as { result?: unknown }).result;
  if (result === null || typeof result !== 'object') return null;
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (structured !== null && typeof structured === 'object' && 'hookOutput' in structured) {
    return (structured as { hookOutput: unknown }).hookOutput as HookOutput;
  }
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const firstText = content.find(
      (c): c is { type: string; text: string } =>
        c !== null && typeof c === 'object' && (c as { type?: unknown }).type === 'text',
    );
    if (firstText !== undefined) {
      try {
        const parsed = JSON.parse(firstText.text) as { hookOutput?: unknown };
        if (parsed.hookOutput !== undefined) return parsed.hookOutput as HookOutput;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Spawn `mcp-server --transport stdio` and call `lifecycle_event` once,
 * mirroring the exact handshake `hook-runner.mjs` performs for Codex/
 * Devin/Cursor/Antigravity (see e.g. `lib/agents/codex-plugin.ts`'s
 * generated `hookRunner()`): `initialize` → wait for id:1 → send
 * `notifications/initialized` + `tools/call` → wait for id:2 → kill.
 */
function callLifecycleToolViaStdio(args: {
  readonly binPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly rawPayload: Record<string, unknown>;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [args.binPath, '--transport', 'stdio'], {
      env: args.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let settled = false;
    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`doctor_check_29_timeout (stderr tail: ${stderrTail.slice(-300)})`));
    }, args.timeoutMs);

    function send(message: Record<string, unknown>): void {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    function settleWith(value: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(value);
    }
    function settleError(err: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      reject(err);
    }

    child.on('error', settleError);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const idx = buffer.indexOf('\n');
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg: { id?: number; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
          send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'lifecycle_event', arguments: { agentType: 'claude_code', rawPayload: args.rawPayload } },
          });
        } else if (msg.id === 2) {
          if (msg.error) settleError(new Error(msg.error.message ?? 'doctor_check_29_lifecycle_tool_failed'));
          else settleWith(JSON.parse(line));
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'coodra-doctor-check-29', version: '1.0.0' },
      },
    });
  });
}

export const preToolUseLoopCheck: Check = {
  id: 29,
  name: 'Native lifecycle_event synthetic PreToolUse returns deny for Write→.env (proves enforcement loop)',
  severity: 'red',
  async run(ctx) {
    // Don't fire the synthetic when the cwd has no `.coodra/config.json`.
    // lifecycle_event would otherwise auto-create a project from
    // `basename(cwd)` (per `resolveAndEnsure`), polluting the projects
    // table with one row per `coodra doctor` invocation from an
    // un-registered folder. The policy-enforcement loop is meaningless
    // for a freshly-derived project anyway — no rules are seeded for it.
    // Check 12 already covers the missing-config case.
    if ((await readProjectConfig(ctx.cwd)) === null) {
      return {
        status: 'yellow',
        detail:
          'cwd has no .coodra/config.json — skipping synthetic enforcement probe (would auto-create a stub project).',
        remediation: 'Run `coodra init` from the project root to register it, then re-run doctor.',
      };
    }

    let binPath: string;
    let source: 'bundled' | 'monorepo';
    try {
      const resolved = await resolveRuntimeBinary('mcp-server');
      binPath = resolved.path;
      source = resolved.source;
    } catch (err) {
      return {
        status: 'red',
        detail: `cannot resolve mcp-server binary: ${(err as Error).message}`,
        remediation:
          'For dev contributors: run `pnpm --filter @coodra/cli build` to produce the bundled runtime ' +
          'or `pnpm --filter @coodra/mcp-server build` to produce the monorepo dev dist. ' +
          'For end users: reinstall `@coodra/cli` from npm — the bundle ships in the published tarball.',
      };
    }

    const probeSessionId = `doctor-check-29-${ctx.now().getTime()}`;
    const payload = {
      hook_event_name: 'PreToolUse',
      session_id: probeSessionId,
      tool_name: 'Write',
      tool_input: { file_path: '.env', content: 'doctor probe' },
      tool_use_id: `doctor-${ctx.now().getTime()}`,
      cwd: ctx.cwd,
    };

    const childEnv: NodeJS.ProcessEnv = { ...ctx.env, COODRA_LOG_DESTINATION: 'stderr', COODRA_HOME: ctx.coodraHome };
    if (source === 'bundled') {
      const bundled = bundledMigrationsDir('sqlite');
      if (bundled !== null) {
        childEnv.COODRA_MIGRATIONS_DIR = bundled.replace(/\/sqlite$/, '').replace(/\\sqlite$/, '');
      }
    }

    let response: unknown;
    let callError: { status: 'yellow'; detail: string; remediation: string } | null = null;
    try {
      response = await callLifecycleToolViaStdio({
        binPath,
        env: childEnv,
        timeoutMs: Math.max(ctx.timeoutMs - 200, 500),
        rawPayload: payload,
      });
    } catch (err) {
      callError = {
        status: 'yellow',
        detail: `synthetic lifecycle_event call failed: ${(err as Error).message}`,
        remediation:
          'Run `coodra doctor --full` after confirming `node <mcp-server bin> --transport stdio` starts cleanly.',
      };
    }

    // Always sweep the probe rows lifecycle_event created on our behalf —
    // one policy_decision (and possibly a runs row) keyed on the unique
    // probeSessionId. Without this, every `coodra doctor` invocation
    // leaves an audit row behind, which pollutes the policy-decisions
    // feed in the web UI.
    await sweepProbeRows({ dataDb: ctx.dataDb, probeSessionId });

    if (callError !== null) return callError;

    const hookOutput = extractHookOutput(response);
    if (hookOutput === null) {
      return {
        status: 'red',
        detail: 'lifecycle_event responded but the envelope did not carry a hookOutput.',
        remediation: 'The MCP tool responded but the envelope did not match the documented hook contract.',
      };
    }
    const decision = hookOutput.permissionDecision;
    if (decision === 'deny') {
      return {
        status: 'green',
        detail: `lifecycle_event correctly denied synthetic Write→.env (reason: ${hookOutput.permissionDecisionReason ?? '(none)'}).`,
      };
    }
    if (decision === 'allow') {
      return {
        status: 'red',
        detail:
          'lifecycle_event ALLOWED synthetic Write→.env. The default policy is broken or not seeded for this project.',
        remediation:
          'Run `coodra init` to re-seed the default policy (Phase 3 Fix D / Phase 4 Fix F: Write/Edit/MultiEdit/NotebookEdit on .env, .git/**, node_modules/** must deny).',
      };
    }
    return {
      status: 'yellow',
      detail: `lifecycle_event returned permissionDecision=${decision ?? '(missing)'} — neither deny nor allow.`,
    };
  },
};

/**
 * Erase the audit footprint of a single PreToolUse probe.
 *
 * Background. `lifecycle_event` may open a `runs` row for an audited
 * hook (M04 Phase 2 S1 F3 fix — `run_events.run_id` would otherwise
 * land NULL during the race between SessionStart recording and the
 * first PostToolUse). That fix is correct for real sessions but means
 * doctor's synthetic PreToolUse can leave rows behind: one
 * `policy_decisions`, and (if a run was opened) one `runs` +
 * `run_events`. This helper deletes them by
 * `session_id LIKE 'doctor-check-29-%'` matching exactly the probe we
 * just fired.
 *
 * Best-effort. If the delete throws (DB locked, file missing), we swallow
 * — the check's main return value is the contract we care about, and the
 * sweep is a courtesy. We open the DB read-write only at the very end of
 * the check to minimize lock contention with the running services.
 */
async function sweepProbeRows(args: { readonly dataDb: string; readonly probeSessionId: string }): Promise<void> {
  let handle: Awaited<ReturnType<typeof openLocalDb>> | null = null;
  try {
    handle = await openLocalDb(args.dataDb);
    const raw = handle.raw;

    // lifecycle_event's audit writes may land via the durable outbox
    // (async drain), so the synchronous MCP response can return before
    // those rows land. Poll for the runs row up to 1s before giving up;
    // once it appears, delete the whole audit chain in a single txn.
    let runIds: string[] = [];
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const runRows = raw.prepare(`SELECT id FROM runs WHERE session_id = ?`).all(args.probeSessionId) as Array<{
        id: string;
      }>;
      if (runRows.length > 0) {
        runIds = runRows.map((r) => r.id);
        break;
      }
      // Brief sleep to let the async audit-write land.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }

    const txn = raw.transaction(() => {
      if (runIds.length > 0) {
        const placeholders = runIds.map(() => '?').join(',');
        raw.prepare(`DELETE FROM run_events WHERE run_id IN (${placeholders})`).run(...runIds);
        raw.prepare(`DELETE FROM decisions WHERE run_id IN (${placeholders})`).run(...runIds);
        raw.prepare(`DELETE FROM policy_decisions WHERE run_id IN (${placeholders})`).run(...runIds);
        raw.prepare(`DELETE FROM runs WHERE id IN (${placeholders})`).run(...runIds);
      }
      // Defense-in-depth: drop any policy_decisions that reference this
      // session_id directly (the schema attaches projectId + run_id; if a
      // future change widens the indexed columns this catches stragglers).
      raw.prepare(`DELETE FROM policy_decisions WHERE session_id = ?`).run(args.probeSessionId);
    });
    txn();
  } catch {
    // swallow — sweep is best-effort
  } finally {
    try {
      handle?.close();
    } catch {
      /* ignore */
    }
  }
}
