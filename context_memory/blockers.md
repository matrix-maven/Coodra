# Blockers

Things actively preventing progress right now. Keep minimal — move items out when resolved. Items that require the user are duplicated into `pending-user-actions.md`; items that are purely technical stay here.

Format:

```
## YYYY-MM-DD HH:mm — <short title>
**Blocks:** <what surface is stuck>
**Cause:** <root cause>
**Attempted:** <what was tried>
**Path to unblock:** <next step>
```

---

_No active blockers as of 2026-04-22 14:35. Docker-daemon absence is tracked in `pending-user-actions.md` and does not block Module 01._

## 2026-05-02 14:51 — workspace `pnpm build` (turbo) fails with cyclic dependency

**Blocks:** Phase 2 verification T1.4. Workspace-level `pnpm build` cannot complete; per-package `pnpm --filter @coodra/cli build` still works (used by Phase 2 cold-install integration test, which is green).

**Cause:** Phase 2 Step 2 (decision `dec_83ba10c1`) added `@coodra/mcp-server` and `@coodra/hooks-bridge` to `@coodra/cli`'s `devDependencies` so pnpm would symlink them into `node_modules` for esbuild's resolver. But:
- `apps/mcp-server` and `apps/hooks-bridge` already declare `@coodra/cli` (workspace:*) in their `dependencies` (for the runtime `@coodra/cli/lib/outbox` import).
- Turbo treats devDependencies as build-graph edges. Result: `cli#build → mcp-server#build → cli#build` and `cli#build → hooks-bridge#build → cli#build`.

```
WARNING  Circular package dependency detected: @coodra/hooks-bridge, @coodra/cli, @coodra/mcp-server
x Cyclic dependency detected
```

**Attempted:** Re-ran `pnpm install --frozen-lockfile` cleanly (1s, ✅). The cycle is structural — not a stale-cache artifact.

**Path to unblock (low-risk):** the CLI's `bundle.mjs` reads `apps/{mcp-server,hooks-bridge}/src/index.ts` via absolute path; esbuild does NOT need the apps to be present in `node_modules/@coodra/`. The `devDependencies` entries can be removed without affecting the bundle. Concretely: drop `@coodra/mcp-server` and `@coodra/hooks-bridge` from `packages/cli/package.json#devDependencies`, re-run `pnpm install`, and the cycle disappears. Bundle still produces the same artifacts.

**Path to unblock (higher-risk, deferred):** move the `lib/outbox/*` source out of `@coodra/cli` and into a new `@coodra/outbox` shared workspace package. The apps then depend on `@coodra/outbox` instead of `@coodra/cli`, breaking the asymmetric dependency entirely. Cleaner long-term but expands surface area beyond what Phase 2 should touch.

**Verification status:** treating `pnpm --filter @coodra/cli build` as the canonical build for Phase 2 verification (it produces the published-tarball artifact). Workspace `pnpm build` is a CI ergonomics concern, not a publish-path correctness concern. Findings report flags this as a yellow blocker.

## 2026-05-02 14:55 — `.tsbuildinfo` incremental-cache poisons re-builds when `dist/` is wiped without it

**Blocks:** local dev iteration; CI runs that wipe `dist/` without also wiping `.tsbuildinfo` produce silent half-builds (only `.d.ts` emitted, no `.js`).

**Cause:** TypeScript's `incremental: true` (set in `tsconfig.base.json`) writes `.tsbuildinfo` next to the package root. After `rm -rf packages/*/dist` the cache is stale-but-extant; tsc consults it, sees "nothing has changed since the last emit," and skips the JS emit step. The bundle script then fails because `dist/lib/outbox/index.js` (the workspace `@coodra/cli/lib/outbox` exports target) does not exist on disk.

**Reproduction (T1.4 of the 2026-05-02 verification run):**
```
rm -rf packages/cli/dist                      # leaves .tsbuildinfo
pnpm exec tsc -p packages/cli/tsconfig.json   # emits only .d.ts files
node packages/cli/scripts/bundle.mjs           # fails: cannot resolve @coodra/cli/lib/outbox
```

**Attempted:** `rm -rf packages/cli/dist && rm -f packages/cli/.tsbuildinfo && pnpm exec tsc` emits the full output and the bundle succeeds. Reproducible.

**Path to unblock (low-risk):** add `.tsbuildinfo` to the `clean` script's wipe list in every package's `package.json`, AND extend `bundle.mjs` to wipe `dist/.tsbuildinfo` (or just `dist/`) before tsc runs. Concretely the prebuild can do `rm -rf dist .tsbuildinfo` so a wedged cache cannot survive a build.

**Verification status:** Phase 2 build was reproducible after clearing `.tsbuildinfo`. The bundle artifacts produced match Phase 2's contract (1.7MB CLI, 2.0MB mcp-server, 1.4MB hooks-bridge, drizzle/ copied). This is a minor build-hygiene blocker, not a publish-path correctness issue.

## 2026-05-02 14:39 — `~/.claude/settings.json` writer gates on `~/.claude/` directory existing

**Blocks:** Phase 2 autonomy goal C1 (auto-inject Feature Pack at SessionStart) for fresh installs where the user has not yet launched Claude Code. Verification T2 caught this in the tmp-$HOME simulation.

**Cause:** `packages/cli/src/commands/init.ts` (the post-Phase-2 wiring of `mergeClaudeSettings`) is gated on `if (ides.includes('claude'))`. The `detectIDE` helper (`packages/cli/src/lib/detect.ts`) only returns `'claude'` when `~/.claude/` is a real directory at init time. So:

- A stranger who installs Claude Code AND launches it once → `~/.claude/` exists → init writes the four hook entries → autonomy works.
- A stranger who installs Claude Code but has not launched it yet → `~/.claude/` does NOT exist → init prints the yellow "skipping" warning → no hook config → autonomy silently does NOT fire on first session.

The user-facing message reads:
```
⚠ Claude Code config dir (~/.claude) not detected — skipping settings.json hook merge
```

This is an honest log line but it does not surface the consequence — that the bridge will never be reached because no hook entry was written. Most users will miss the warning.

**Path to unblock:** init should `mkdir -p ~/.claude` (or use the `claudeHome` resolution helper) and write `settings.json` regardless of whether the directory existed at init time. Claude Code reads `~/.claude/settings.json` at app launch — pre-creating the file is safe and the right default. The IDE-detection check should stay as a banner ("Detected IDEs: …") but should NOT gate the `mergeClaudeSettings` call.

Concrete patch sketch:
```typescript
// init.ts
// before:
if (ides.includes('claude')) {
  await mergeClaudeSettings(...);
} else {
  io.writeStdout('skipping');
}
// after:
const claudeMerge = await mergeClaudeSettings(...);  // always run
outcomes.push(claudeMerge.outcome);
if (!ides.includes('claude')) {
  io.writeStdout('Note: ~/.claude was created — Claude Code will pick up the hook config on next launch.');
}
```

`mergeClaudeSettings` already calls `mkdir -p` on the parent dir before writing (`fs/promises::mkdir(dirname(path), { recursive: true })`), so it'll Just Work.

**Verification status:** caught in T2 of the 2026-05-02 cold-install verification. Workaround for verification: pre-create `~/.claude/` to simulate a real Claude Code user. Real fix: drop the gate in `init.ts`. This is a P1 follow-up for the publish-flag-day commit.

## ✅ 2026-05-02 14:52 — Claude Code hook payload schema `.strict()` rejection — RESOLVED by Phase 3 Fix A

**Audit 2026-05-04 (M04 pre-S1 review):** verified all three adapter payload schemas at `packages/shared/src/hooks/payloads/{claude-code,windsurf,cursor}.ts` use `.passthrough()` on the outer object, with explicit docblock notes citing Phase 3 Fix A (2026-05-02) and the rationale ("the wire protocol is controlled by the OTHER side, `.strict()` is wrong by construction"). The route handler at `apps/hooks-bridge/src/app.ts` calls `safeParse` and on failure logs `invalid_hook_payload` + fails open — same fail-open posture, but the parse no longer fails for the real envelope. Closes the original C1 / C2 autonomy gap.

**Adjacent finding (NOT a blocker, low priority):** the bridge's `200 OK` response shape is identical for every event type (`hookSpecificOutput.{hookEventName, permissionDecision, permissionDecisionReason, additionalContext?}`). Per Claude Code's hook-response spec (fetched 2026-05-04 from `code.claude.com/docs/en/hooks`), only PreToolUse + SessionStart use `hookSpecificOutput`; PostToolUse / Stop / SessionEnd / SubagentStop expect top-level `decision: 'block'` + `reason` (or empty body to allow). For these events Claude Code "silently ignores" the bridge's PreToolUse-shaped fields per the docs, so there is no user-visible bug — just response-shape fidelity drift that surfaces as a silently-ignored field, not as a rejected hook. Reserved as M04 S11 cleanup (per-event response shaping in `apps/hooks-bridge/src/app.ts`); not a fix-up PR concern.

---

**Original entry (preserved for context):**



**Blocks:** Phase 2 autonomy goal C1 (and C2). Every real Claude Code SessionStart, PreToolUse, PostToolUse, and Stop hook is rejected by Zod's strict-object validation; the bridge fails open per §7 with `{ permissionDecision: 'allow', reason: 'invalid_hook_payload' }`. The SessionStart handler is **never invoked**, so no `additionalContext` is computed, no runs row is created via the bridge, and no Context Pack auto-saves at SessionEnd. Phase 2's unit + integration tests are green only because they construct stripped payloads matching the schema.

**Cause:** `packages/shared/src/hooks/payloads/claude-code.ts:31-42` uses `.strict()` on a schema that lists 8 fields. Claude Code's actual SessionStart envelope includes `transcript_path` (path to JSONL transcript) and `source` (`'startup' | 'resume' | 'clear' | …`); both are dropped by `.strict()`. The route handler in `apps/hooks-bridge/src/app.ts:118-125` catches the parse failure and returns the fail-open response.

**Reproduction (T4.1 of the 2026-05-02 verification):**
```
POST http://127.0.0.1:3101/v1/hooks/claude-code
{ "session_id": "...", "hook_event_name": "SessionStart",
  "transcript_path": "/tmp/x.jsonl", "cwd": "/tmp/proj", "source": "startup" }
→ 200 OK
{ "ok": true,
  "hookSpecificOutput": { "permissionDecision": "allow",
                           "permissionDecisionReason": "invalid_hook_payload" } }
# additionalContext is missing.

POST same-without-transcript_path-without-source
→ 200 OK
{ "ok": true,
  "hookSpecificOutput": { "permissionDecision": "allow",
                           "additionalContext": "# Coodra Feature Pack — stranger-app\n\n## spec.md\n…" } }
# 223 bytes of Feature Pack content. The handler works; the schema gate is the bug.
```

**Path to unblock:** swap `.strict()` for `.passthrough()` on every adapter payload schema (`payloads/{claude-code,windsurf,cursor}.ts`). The adapter projects only known fields into `HookEvent`, so passthrough is safe. One-line fix per file. The `.strict()` choice was probably defensive (catch typos in our test fixtures), but for a wire protocol the OTHER side controls, `.strict()` is wrong by construction.

**Verification status:** caught in T4.1 of the 2026-05-02 cold-install verification. **This is the most consequential Phase 2 finding.** It means autonomy goals C1 and C2 DO NOT WORK on real Claude Code traffic. The fix is one line per payload file. NOT applying it as part of this verification run per the user's discipline reminder ("If a check fails, do not patch it to make this run go green"). Phase T4-T6 continue with stripped payloads to keep producing data; every check that depends on real wire format gets a YELLOW/qualified pass with this caveat noted in the findings report.

## ✅ 2026-05-02 14:55 — `coodra init` seeds zero policy rules — RESOLVED by Phase 3 Fix D

**Audit 2026-05-04 (M04 pre-S1 review):** `packages/cli/src/commands/init.ts:142` calls `ensureDefaultPolicy(handle, projectResult.id)` (Phase 3 Fix D, 2026-05-02). The helper at `packages/db/src/ensure-default-policy.ts` inserts the baseline rule set described in the original "path to unblock" — denies on `.env` / `**/.env` / `**/.env.production` / `.git/**` / `node_modules/**` for the file-mutating tools (Write, Edit, MultiEdit, NotebookEdit), with `Bash` requiring `ask`. Init-time stdout confirms with `✓ Seeded default policy with N baseline rules`. Phase 4 Fix F (2026-05-03) further hardened by adding the per-event matcher coverage. No further work needed.

---

**Original entry (preserved for context):**



**Blocks:** Phase 2 autonomy claim about "policy denials surface in-path." A stranger who runs `coodra init` ends up with empty `policies` and `policy_rules` tables. Every PreToolUse decision returns `permissionDecision: 'allow', reason: 'no_rule_matched'`. There is no install-time guidance for the user on how to author a rule.

**Cause:** `commands/init.ts` calls `ensureGlobalProject` + `ensureProject` but does NOT insert any rows into `policies` / `policy_rules`. The user must do this manually via SQL, a (not-yet-built) admin UI, or a future MCP tool. For verification I seeded a deny rule manually:

```sql
INSERT INTO policies (id, project_id, name, is_active) VALUES ('p_demo', '__global__', 'demo deny .env.production', 1);
INSERT INTO policy_rules (id, policy_id, priority, match_event_type, match_tool_name, match_path_glob, decision, reason)
  VALUES ('pr_demo', 'p_demo', 100, 'PreToolUse', 'Write', '**/.env.production', 'deny', 'production secrets must not be edited by the agent');
```

After seeding, the deny path works correctly (verified in T4.3 of the same verification run).

**Path to unblock:** ship a default-deny seed list for a stranger install — at minimum:
- Deny Write to `**/.env.production` and `**/.env.*.production` (production secrets)
- Deny Bash for `rm -rf /`-shaped commands
- Deny Write to `.git/**` (don't let the agent corrupt the index)

These are universal-safe deny rules. They live in `init.ts` as a hardcoded seed (or in a `deny-rules.json` fixture under `packages/db/drizzle/seeds/` that init applies after migrations).

**Verification status:** caught in T4.3 of the 2026-05-02 cold-install verification. Lower-priority than the strict-schema finding above. Workaround for verification: hand-seeded one deny rule. Real fix: ship a default-deny fixture in init. P2 follow-up.

## ✅ 2026-05-02 14:55 — `seedFeaturePack` seeds only spec.md — RESOLVED by Phase 3 Fix C

**Audit 2026-05-04 (M04 pre-S1 review):** `packages/cli/src/lib/init/feature-pack-seed.ts:99-109` seeds all four files (`meta.json`, `spec.md`, `implementation.md`, `techstack.md`) per Phase 3 Fix C (2026-05-02), with an in-code citation of this very blocker entry. `apps/mcp-server/src/lib/feature-pack.ts::readPackFromDisk:139-144` still does `Promise.all([readFile(...), readFile(...), readFile(...), readFile(...)])` (fail-fast on any missing file), so a manually-created pack with only spec.md would still throw `handler_threw` — but that case no longer occurs through the supported `coodra init` path, so it's a latent fragility rather than a blocker. Reserved as M04 S11 cleanup (mirror the bridge's `readMaybe` pattern in mcp-server) for symmetry; not a pre-M04 PR concern.

---

**Original entry (preserved for context):**



**Blocks:** the MCP tool path of `get_feature_pack` on a freshly init'd project throws `ENOENT` on `implementation.md`. Bridge-side SessionStart injection works (the slim loader tolerates missing optional files), but any agent that calls `get_feature_pack` mid-session (e.g. on a module switch) gets `{ ok: false, error: 'handler_threw' }`. Verified in T5.3.

**Cause:** contract mismatch between two readers of the same on-disk pack:
- `apps/mcp-server/src/lib/feature-pack.ts:139-144` does `Promise.all([readFile(spec.md), readFile(implementation.md), readFile(techstack.md), readFile(meta.json)])` — fails fast on any missing file.
- `apps/hooks-bridge/src/lib/feature-pack-loader.ts` reads spec.md (required) + implementation.md and techstack.md (optional, via `readMaybe`).
- `packages/cli/src/lib/init/feature-pack-seed.ts` writes only `spec.md` + `meta.json` for a freshly seeded pack.

**Reproduction (T5.3 of the 2026-05-02 verification):**
```
SDK Client → call_tool get_feature_pack { projectSlug: 'stranger-app' }
→ { ok: false, error: 'handler_threw',
    message: "ENOENT: no such file or directory, open '<proj>/docs/feature-packs/stranger-app/implementation.md'" }
```

**Path to unblock:** two equivalent fixes, pick whichever matches the team's design intent:
- (a) Make `seedFeaturePack` write empty placeholder `implementation.md` and `techstack.md` files at init time. Symmetric with how `meta.json` is seeded.
- (b) Soften `apps/mcp-server/src/lib/feature-pack.ts::readPackFromDisk` to tolerate missing implementation.md / techstack.md the same way `feature-pack-loader.ts` does — pin spec.md as required, others optional. Mirror the bridge.

(b) is the cleaner architectural choice (one rule for both readers); (a) is the easier patch.

**Verification status:** caught in T5.3 of the 2026-05-02 cold-install verification. The bridge SessionStart auto-inject is unaffected (handles the missing-file case). The MCP-tool surface is broken for fresh installs but recovers as soon as the user fills in implementation.md + techstack.md. P2 follow-up.






