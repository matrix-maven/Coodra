/**
 * `packages/shared/__tests__/fixtures/claude-code-real-envelope.ts` —
 * canonical fixtures of Claude Code's six wire-level hook envelopes
 * exactly as they arrive at the bridge.
 *
 * Source of truth: `code.claude.com/docs/en/hooks` (verified
 * 2026-05-02 during Phase 3.1 verification — see
 * `docs/verification/2026-04-28-functest/phase-2-verification.md`).
 *
 * **Why these fixtures exist.** Phase 2 verification (2026-04-28)
 * showed that every real Claude Code envelope was rejected by the
 * `.strict()` payload schema with `permissionDecisionReason:
 * 'invalid_hook_payload'` and the route fell open — meaning policy
 * was silently bypassed for every real install. Phase 3 Fix A
 * (2026-05-02 — `dec_ea32e7ed`) widened the schema to
 * `.passthrough()` and added `SessionEnd` to the enum. These
 * fixtures lock the contract: any future schema regression that
 * narrows again will fail the integration test that uses them.
 *
 * **Fields beyond the ContextOS enum.** Every envelope here carries
 * `transcript_path`. Tool-call events add `permission_mode`.
 * SessionStart adds `source` and `model`. The `.passthrough()`
 * wrapper accepts these unchanged; the adapter ignores them; the
 * route processes the canonical fields and returns a structured
 * response.
 *
 * **Constants.** `MODEL` is exported separately so tests can
 * override per-fixture without forking the whole envelope (the
 * model string drifts as Anthropic releases new models).
 */

export const MODEL = 'claude-sonnet-4-6' as const;
export const SESSION_ID = 'fixture-session-1' as const;
export const TRANSCRIPT_PATH = '/Users/dev/.claude/projects/abc/abc.jsonl' as const;
export const CWD = '/Users/dev/myapp' as const;

export const REAL_ENVELOPE_SESSION_START = {
  session_id: SESSION_ID,
  transcript_path: TRANSCRIPT_PATH,
  cwd: CWD,
  hook_event_name: 'SessionStart',
  // 'startup' | 'resume' | 'clear' | 'compact'
  source: 'startup',
  model: MODEL,
} as const;

export const REAL_ENVELOPE_PRE_TOOL_USE = {
  session_id: SESSION_ID,
  transcript_path: TRANSCRIPT_PATH,
  cwd: CWD,
  // 'default' | 'plan' | 'acceptEdits' | 'auto' | 'dontAsk' | 'bypassPermissions'
  permission_mode: 'default',
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: '/Users/dev/myapp/x.ts', content: '// hi' },
  tool_use_id: 'toolu_fixture_1',
} as const;

export const REAL_ENVELOPE_POST_TOOL_USE = {
  session_id: SESSION_ID,
  transcript_path: TRANSCRIPT_PATH,
  cwd: CWD,
  permission_mode: 'default',
  hook_event_name: 'PostToolUse',
  tool_name: 'Write',
  tool_input: { file_path: '/Users/dev/myapp/x.ts', content: '// hi' },
  tool_use_id: 'toolu_fixture_1',
} as const;

export const REAL_ENVELOPE_STOP = {
  session_id: SESSION_ID,
  transcript_path: TRANSCRIPT_PATH,
  cwd: CWD,
  permission_mode: 'default',
  hook_event_name: 'Stop',
} as const;

// SessionEnd's `reason` field shape is not pinned in the canonical
// docs (matcher values are clear/resume/logout/prompt_input_exit/
// bypass_permissions_disabled/other but the wire payload doesn't
// document a `reason` field explicitly). `.passthrough()` will
// accept it if Claude Code adds one; we don't encode an unverified
// shape here.
export const REAL_ENVELOPE_SESSION_END = {
  session_id: SESSION_ID,
  transcript_path: TRANSCRIPT_PATH,
  cwd: CWD,
  hook_event_name: 'SessionEnd',
} as const;

export const REAL_ENVELOPE_USER_PROMPT_SUBMIT = {
  session_id: SESSION_ID,
  transcript_path: TRANSCRIPT_PATH,
  cwd: CWD,
  permission_mode: 'default',
  hook_event_name: 'UserPromptSubmit',
  prompt: 'help me write a function',
} as const;

export const ALL_REAL_ENVELOPES = [
  REAL_ENVELOPE_SESSION_START,
  REAL_ENVELOPE_PRE_TOOL_USE,
  REAL_ENVELOPE_POST_TOOL_USE,
  REAL_ENVELOPE_STOP,
  REAL_ENVELOPE_SESSION_END,
  REAL_ENVELOPE_USER_PROMPT_SUBMIT,
] as const;
