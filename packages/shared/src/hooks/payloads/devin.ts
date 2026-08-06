import { z } from 'zod';

/**
 * Devin CLI lifecycle hook payloads.
 *
 * Devin command hooks receive one JSON object on stdin, same contract
 * shape as Claude Code/Codex/Cursor. Field names below are taken from
 * Devin's own extensibility docs (`/Applications/Devin.app/Contents/
 * Resources/app/extensions/windsurf/devin/share/devin/docs/
 * extensibility/hooks/{overview,lifecycle-hooks}.mdx`, read 2026-08-05)
 * — `hook_event_name` plus `session_id`/`prompt_id` (every payload),
 * and the per-event fields Coodra reads. This has NOT been verified
 * against a live, authenticated Devin session (Devin plugins are
 * closed beta and require `devin auth login`, which Coodra never
 * drives) — passthrough + all-optional fields keep a wire-format
 * surprise from crashing the hook rather than failing open, matching
 * the existing Codex/Claude Code/Cursor schemas' discipline.
 *
 * Devin's own hook vocabulary is smaller than every other agent's — 8
 * events total. Notably: `PascalCase` names, already the canonical
 * vocabulary (unlike Cursor's camelCase), so no event-name translation
 * map is needed downstream. No `PreCompact`-equivalent exists at all —
 * only `PostCompaction`, fired after the fact with no confirmed veto
 * power. No `SubagentStart`/`SubagentStop`, no `PermissionDenied`, no
 * `PostToolUseFailure`, no `StopFailure`, no `ConfigChange`-equivalent.
 *
 * Per-event fields:
 *   - `PreToolUse`/`PostToolUse`/`PermissionRequest`: `tool_name`,
 *     `tool_input`. `PostToolUse` additionally carries `tool_response`
 *     — a NESTED `{success, output, error}` object, structurally
 *     different from every other agent's flatter error fields.
 *   - `UserPromptSubmit`: `prompt` (no `tool_name` at all).
 *   - `Stop`: `stop_hook_active`.
 *   - `PostCompaction`: `summary` (may be null).
 *   - `SessionStart`: `source`.
 *   - `SessionEnd`: `reason`.
 *
 * `cwd` is NOT a documented stdin field for any event — Devin instead
 * sets `DEVIN_PROJECT_DIR` as an environment variable, which
 * `devin-plugin.ts`'s `hookRunner()` enriches onto the payload before
 * it reaches this schema. The field stays optional here so a future
 * confirmed case (or a wrong assumption about the env-var mechanism)
 * still parses.
 */
export const DevinHookPayloadSchema = z
  .object({
    hook_event_name: z.enum([
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'UserPromptSubmit',
      'Stop',
      'PostCompaction',
      'SessionStart',
      'SessionEnd',
    ]),
    session_id: z.string().optional(),
    prompt_id: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_response: z
      .object({
        success: z.boolean().optional(),
        output: z.string().optional(),
        error: z.string().nullable().optional(),
      })
      .optional(),
    prompt: z.string().optional(),
    stop_hook_active: z.boolean().optional(),
    summary: z.string().nullable().optional(),
    source: z.string().optional(),
    reason: z.string().optional(),
    cwd: z.string().optional(),
  })
  .passthrough();

export type DevinHookPayload = z.infer<typeof DevinHookPayloadSchema>;
