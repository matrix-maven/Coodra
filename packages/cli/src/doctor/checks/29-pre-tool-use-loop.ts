import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Check } from '../types.js';

/**
 * Slice 5 (2026-05-03 audit §14.1) — synthetic PreToolUse end-to-end
 * loop test. The audit observed: the `__contextos__` matcher bug existed
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
        remediation: 'Run `contextos init` to lay down a fresh .env with a generated LOCAL_HOOK_SECRET.',
      };
    }

    const payload = {
      hook_event_name: 'PreToolUse',
      session_id: `doctor-check-29-${ctx.now().getTime()}`,
      tool_name: 'Write',
      tool_input: { file_path: '.env', content: 'doctor probe' },
      tool_use_id: `doctor-${ctx.now().getTime()}`,
      cwd: ctx.cwd,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(ctx.timeoutMs - 200, 500));
    let body: unknown;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Local-Hook-Secret': secret },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        return {
          status: 'red',
          detail: `bridge returned HTTP ${res.status} for synthetic PreToolUse POST.`,
          remediation:
            res.status === 401 || res.status === 403
              ? 'Re-run `contextos init` to align the LOCAL_HOOK_SECRET between .env and the bridge.'
              : `Check ~/.contextos/logs/hooks-bridge.log for the request handling.`,
        };
      }
      body = await res.json();
    } catch (err) {
      return {
        status: 'red',
        detail: `synthetic PreToolUse POST failed: ${(err as Error).message}`,
        remediation:
          'Confirm hooks-bridge is running (`contextos status`) and that the daemon listens on ' +
          `port ${ctx.bridgePort}.`,
      };
    } finally {
      clearTimeout(timer);
    }

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
          'Run `contextos init` to re-seed the default policy (Phase 3 Fix D / Phase 4 Fix F: Write/Edit/MultiEdit/NotebookEdit on .env, .git/**, node_modules/** must deny).',
      };
    }
    return {
      status: 'yellow',
      detail: `bridge returned permissionDecision=${decision ?? '(missing)'} — neither deny nor allow.`,
    };
  },
};
