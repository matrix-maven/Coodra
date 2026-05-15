import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { openLocalDb } from '../../lib/open-local-db.js';
import type { Check } from '../types.js';

/**
 * Slice 5 (2026-05-03 audit §14.1) — synthetic PreToolUse end-to-end
 * loop test. The audit observed: the `__coodra__` matcher bug existed
 * for weeks because doctor only checks process health, not lifecycle
 * correctness. This check fires a SYNTHETIC PreToolUse hook at the
 * bridge with a payload that the post-Fix-F default policy MUST deny
 * (Write to `.env`), then asserts the response is
 * `permissionDecision: 'deny'`.
 *
 * What this catches:
 *   - Bridge process is up (covered by check 11) but actually denies (this).
 *   - Default policy is seeded (Phase 3 Fix D / Phase 4 Fix F).
 *   - Per-event matcher is shaped correctly (covered by check 28).
 *   - The bridge's PreToolUse handler routes to the policy evaluator.
 *
 * Side effects:
 *   - Writes ONE row to `policy_decisions` (audit-only append; the
 *     idempotency key is `pd:doctor-check-<runtime-id>:Write:PreToolUse`
 *     so re-running the check produces a single audit row, not a
 *     fresh row per probe). Marked as a doctor-probe in the session_id.
 *   - Does NOT write to `runs` or `run_events`.
 *
 * The synthetic POST uses a tool_use_id prefix `doctor-` so a future
 * admin command can sweep doctor-probe rows if the user wants. For
 * v1 they're just audit noise that the user can grep filter.
 */

const hookResponseSchema = z
  .object({
    ok: z.boolean().optional(),
    hookSpecificOutput: z
      .object({
        permissionDecision: z.string().optional(),
        permissionDecisionReason: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const preToolUseLoopCheck: Check = {
  id: 29,
  name: 'PreToolUse synthetic POST returns deny for Write→.env (proves enforcement loop)',
  severity: 'red',
  async run(ctx) {
    // Don't fire the synthetic when the cwd has no `.coodra.json`. The
    // bridge would otherwise auto-create a project from `basename(cwd)`
    // (per `resolveAndEnsure`), polluting the projects table with one row
    // per `coodra doctor` invocation from an un-registered folder. The
    // policy-enforcement loop is meaningless for a freshly-derived project
    // anyway — no rules are seeded for it. Check 12 already covers the
    // missing-sidecar case.
    try {
      await stat(join(ctx.cwd, '.coodra.json'));
    } catch {
      return {
        status: 'yellow',
        detail: 'cwd has no .coodra.json — skipping synthetic enforcement probe (would auto-create a stub project).',
        remediation: 'Run `coodra init` from the project root to register it, then re-run doctor.',
      };
    }

    const url = `http://127.0.0.1:${ctx.bridgePort}/v1/hooks/claude-code`;
    // Read LOCAL_HOOK_SECRET from the project's .env (the bridge requires
    // the secret on every hook call). Doctor probes for the secret in
    // check 20; here we just need the value.
    let secret = ctx.env.LOCAL_HOOK_SECRET ?? '';
    if (!secret) {
      try {
        const envBody = await readFile(join(ctx.cwd, '.env'), 'utf8');
        const match = envBody.match(/^LOCAL_HOOK_SECRET=([0-9a-fA-F]+)/m);
        if (match?.[1]) secret = match[1];
      } catch {
        // .env missing — surface that before assuming the bridge is broken
      }
    }
    if (!secret) {
      return {
        status: 'yellow',
        detail: 'LOCAL_HOOK_SECRET not found in env or .env — cannot fire synthetic hook.',
        remediation: 'Run `coodra init` to lay down a fresh .env with a generated LOCAL_HOOK_SECRET.',
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(ctx.timeoutMs - 200, 500));
    let body: unknown;
    let httpError: { status: 'red'; detail: string; remediation: string } | null = null;
    let fetchError: { status: 'red'; detail: string; remediation: string } | null = null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Local-Hook-Secret': secret },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        httpError = {
          status: 'red',
          detail: `bridge returned HTTP ${res.status} for synthetic PreToolUse POST.`,
          remediation:
            res.status === 401 || res.status === 403
              ? 'Re-run `coodra init` to align the LOCAL_HOOK_SECRET between .env and the bridge.'
              : `Check ~/.coodra/logs/hooks-bridge.log for the request handling.`,
        };
      } else {
        body = await res.json();
      }
    } catch (err) {
      fetchError = {
        status: 'red',
        detail: `synthetic PreToolUse POST failed: ${(err as Error).message}`,
        remediation:
          'Confirm hooks-bridge is running (`coodra status`) and that the daemon listens on ' +
          `port ${ctx.bridgePort}.`,
      };
    } finally {
      clearTimeout(timer);
    }

    // Always sweep the probe rows the bridge created on our behalf — one
    // run, one policy_decision, one or more run_events keyed on the unique
    // probeSessionId. Without this, every `coodra doctor` invocation
    // leaves an in_progress run + audit row behind, which pollutes the
    // /runs feed and the policy-decisions feed in the web UI.
    await sweepProbeRows({ dataDb: ctx.dataDb, probeSessionId });

    if (httpError !== null) return httpError;
    if (fetchError !== null) return fetchError;

    const parsed = hookResponseSchema.safeParse(body);
    if (!parsed.success) {
      return {
        status: 'red',
        detail: `bridge response shape unexpected: ${parsed.error.message}`,
        remediation: 'The bridge responded but the envelope did not match the documented hook contract.',
      };
    }
    const decision = parsed.data.hookSpecificOutput?.permissionDecision;
    if (decision === 'deny') {
      return {
        status: 'green',
        detail: `bridge correctly denied synthetic Write→.env (reason: ${parsed.data.hookSpecificOutput?.permissionDecisionReason ?? '(none)'}).`,
      };
    }
    if (decision === 'allow') {
      return {
        status: 'red',
        detail: `bridge ALLOWED synthetic Write→.env. The default policy is broken or not seeded for this project.`,
        remediation:
          'Run `coodra init` to re-seed the default policy (Phase 3 Fix D / Phase 4 Fix F: Write/Edit/MultiEdit/NotebookEdit on .env, .git/**, node_modules/** must deny).',
      };
    }
    return {
      status: 'yellow',
      detail: `bridge returned permissionDecision=${decision ?? '(missing)'} — neither deny nor allow.`,
    };
  },
};

/**
 * Erase the audit footprint of a single PreToolUse probe.
 *
 * Background. The bridge auto-opens a `runs` row on every audited hook
 * (M04 Phase 2 S1 F3 fix — `run_events.run_id` would otherwise land NULL
 * during the race between `recordSessionStart` and the first PostToolUse).
 * That fix is correct for real sessions but means doctor's synthetic
 * PreToolUse leaves three rows behind: one `runs`, one `policy_decisions`,
 * and (if the durable outbox drained in-process) one `run_events`. This
 * helper deletes them by `session_id LIKE 'doctor-check-29-%'` matching
 * exactly the probe we just fired.
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

    // The bridge's audit handler fires the runs/policy_decisions inserts
    // as fire-and-forget promises (recordPolicyDecision is `void`-prefixed
    // in the PreToolUse handler). The synchronous HTTP response can return
    // before those rows land. Poll for the runs row up to 1s before giving
    // up; once it appears, delete the whole audit chain in a single txn.
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
      // Brief sleep to let the bridge's async audit-write land.
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
