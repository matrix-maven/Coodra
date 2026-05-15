# Module 08b — CLI Expansion — Implementation Plan

> Follow top-to-bottom. Each slice is one commit on `feat/08b-cli-expansion`. Each commit that bumps a package version amends `External api and library reference.md` in the same commit (amendment B). Slice count: **19**. The eight open questions from `spec.md §11` MUST be locked before S1 starts; OQ-1, OQ-2 constrain the schema (S1) and bridge wiring (S2); OQ-3, OQ-4 constrain S6 (db backup/restore); OQ-5 constrains S8 (uninstall); OQ-6 constrains S11 (run cancel); OQ-7 constrains S12 (export); OQ-8 constrains S2 + S3 (kill-switch sync surface).

## Prerequisites (one-time, before S1)

- M08a squash-merged on `main` at the SHA from its closeout pack. CI green.
- M03 squash-merged + the auto-pack-save / auto-feature-pack-injection hooks are reachable (`apps/hooks-bridge/src/handlers/{session-start,session-end}.ts`).
- M04a squash-merged (sync-daemon present) so `coodra logs sync-daemon` has a real log file to read.
- Eight open questions from `spec.md §11` answered. The answers land as a same-commit edit to spec.md §11 in **S0** (this slice).

## Slice sequence

### S0 — M08b feature pack docs + locked open-question answers (this commit)

**Scope:** publish `spec.md`, `implementation.md`, `techstack.md`, `meta.json` for `docs/feature-packs/08b-cli-expansion/`. Same commit edits `spec.md §11` from "Open questions" to "Locked design decisions" with the user's chosen answer recorded under each OQ subsection (template: question, decision, why, constrains).

**Files:** `docs/feature-packs/08b-cli-expansion/{spec.md,implementation.md,techstack.md,meta.json}`, `context_memory/decisions-log.md` (append M08b kickoff entry + the eight OQ answers), `context_memory/current-session.md` (rewrite for M08b — goal-line, files loaded, next-action pointing at S1).

**Reference updates in the same commit:** none. M08b's deps land in their slices — `npm view` / `tar` / a Slack-format helper / etc. Pinning happens at install time.

**Commit:** `docs(08b-cli-expansion): kickoff spec + slice plan + locked OQ answers`.

---

### S1 — `kill_switches` schema + migration 0007 + ensure helper

Schema delta the rest of M08b depends on. Lands the table on both SQLite and Postgres dialects, generates migration `0007_*` via `pnpm --filter @coodra/db db:generate`, sha-locks any hand-written preserve blocks (none anticipated for this delta) in `migrations.lock.json`, ships `packages/db/src/kill-switches.ts` with the helper functions every other slice imports.

> **Migration-number note (2026-05-03):** the original spec drafted at S0 named this migration `0006_*`. Between draft and lock, Phase 4 Fix K (commit `92e37a6`) landed on `main` claiming the 0006 slot for the `policy_rules` UNIQUE-constraint cleanup. M08b's kill_switches table therefore lands as `0007_*` on both dialects. Drizzle-kit will pick the next-free integer prefix automatically; this note exists so that the diff between spec/implementation and what shows up on disk is explained.

**Files:**
- `packages/db/src/schema/sqlite.ts` — append `killSwitches` table per `spec.md §6`.
- `packages/db/src/schema/postgres.ts` — same shape with native `timestamp` instead of `integer({mode:'timestamp'})`. The schema-parity test in M01 already enforces dialect-only differences.
- `packages/db/drizzle/sqlite/0007_<animal>.sql` (drizzle-kit-generated).
- `packages/db/drizzle/postgres/0007_<animal>.sql` (drizzle-kit-generated).
- `packages/db/src/kill-switches.ts` (NEW) — exports:
  - `listActiveKillSwitches(db: DbHandle, projectId: string | null): Promise<KillSwitch[]>` (the bridge's hot-path query).
  - `insertKillSwitch(db: DbHandle, args: InsertKillSwitchInput): Promise<KillSwitch>` (CLI's `pause`).
  - `softResumeKillSwitch(db: DbHandle, args: { id: string; resumedBySessionId?: string | null }): Promise<KillSwitch | null>` (CLI's `resume`).
  - `softResumeAllKillSwitches(db: DbHandle, filter: { scope?: KillSwitchScope; target?: string | null }): Promise<KillSwitch[]>`.
  - `findKillSwitchMatchingEvent(switches: readonly KillSwitch[], event: { projectId?: string; toolName: string; agentType: string }): KillSwitch | null` (pure function — fast in-memory match for the bridge).
- `packages/db/src/index.ts` — re-export the new helpers.
- `packages/db/__tests__/integration/kill-switches.test.ts` (NEW) — 7 fixtures: insert + active-list, insert two scopes + active-list shape, scope='global' match, scope='project' match, scope='tool' match, scope='agent_type' match, expires_at in past = treated-as-resumed by `listActiveKillSwitches`.

**Acceptance:**
- `pnpm --filter @coodra/db db:generate` produces migration `0007_*` on both dialects.
- `pnpm --filter @coodra/db check:migration-lock` is clean.
- `pnpm --filter @coodra/db test:integration` green (7 new fixtures + every existing test).
- Schema-parity test green (no dialect drift beyond the M02-allowed text-vs-vector).

**Reference updates in the same commit:** `External api and library reference.md` → Drizzle ORM subsection — append "kill_switches table — soft-resume pattern" paragraph noting the polymorphic `(scope, target)` shape and the active-switch index.

**Commit:** `feat(db): kill_switches table + helpers (M08b S1; closes spec.md §6)`.

---

### S2 — Hooks-bridge kill-switch evaluator (consults `kill_switches` BEFORE the policy evaluator)

Wires the new evaluator into the existing pre-tool-use chain in `apps/hooks-bridge/src/handlers/pre-tool-use.ts`. The chain becomes: kill-switch read → match? → if hard, return deny / if soft, return allow with `reason: 'kill_switch_paused:<id>'` AND record a synthetic `policy_decisions` row → if no match, fall through to the existing policy evaluator unchanged. Per OQ-1 the default mode is `hard`.

The bridge's read uses `listActiveKillSwitches(db, projectId)` cached in-process for **5 seconds** (much shorter than the 60s policy cache because pause/resume should feel instantaneous to the operator). Any DB error in the kill-switch read fails-open per `system-architecture.md §7` — the bridge proceeds to the policy evaluator and logs at WARN.

**Files:**
- `apps/hooks-bridge/src/lib/kill-switch-evaluator.ts` (NEW) — `createKillSwitchEvaluator(deps: { db: DbHandle; cacheMs?: number; clock?: () => Date }): { check(event): Promise<{ matched: KillSwitch; decision: 'allow'|'deny' } | null> }`. Pure async function, fail-open on DB throw.
- `apps/hooks-bridge/src/handlers/pre-tool-use.ts` (MODIFIED) — wraps the existing policy evaluator call:
  ```ts
  const switchResult = await killSwitchEvaluator.check(event);
  if (switchResult !== null) {
    recordKillSwitchAudit(deps.db, switchResult.matched, event);  // setImmediate
    return translateKillSwitchDecision(switchResult);
  }
  return existingPolicyChain(event);
  ```
- `apps/hooks-bridge/src/lib/translate-decision.ts` (MODIFIED) — extend the Claude-Code / Windsurf-Cursor translators with a `reason: 'kill_switch_paused:<id>'` shape so denies surface clearly to the agent.
- `apps/hooks-bridge/src/index.ts` (MODIFIED) — construct the evaluator at boot and pass to the handler factory.
- `apps/hooks-bridge/__tests__/integration/kill-switch-pre-tool-use.test.ts` (NEW) — five fixtures: (i) global hard switch denies any tool, (ii) global soft switch allows + records audit, (iii) tool-scoped switch only matches that tool, (iv) project-scoped switch only matches the resolved project, (v) DB throw on switch read fails-open to the policy evaluator (which then evaluates the request normally).
- `apps/hooks-bridge/__tests__/unit/lib/kill-switch-evaluator.test.ts` (NEW) — 8 fixtures covering cache TTL, scope match, expires_at treatment, fail-open on DB throw.

**Acceptance:**
- All five integration fixtures green.
- Pre-tool-use latency budget unchanged (the cache hit is a single Map.get + scan, well within the 50 ms p95).
- `pnpm test:e2e` updated full-session.test.ts asserts kill-switch path lands an audit row.
- `runs` row continues to open at SessionStart per M03 even when subsequent pre-tool-use is kill-switch-denied.

**Reference updates in the same commit:** none (no new dep — pure schema consumer).

**Commit:** `feat(hooks-bridge): kill-switch evaluator wired into pre-tool-use chain (M08b S2)`.

---

### S3 — `coodra pause` + `coodra resume` CLI commands

CLI surface for the kill-switch table. Direct DB writes via `@coodra/db` helpers (no MCP tool, no bridge call needed — same posture as `ensureDefaultPolicy`).

**Files:**
- `packages/cli/src/commands/pause.ts` (NEW) — argument parsing (commander), Zod-validate the `--scope`, resolve target (project slug → projectId via `lookupProject`, tool name passed verbatim, agent_type passed verbatim), call `insertKillSwitch`, print `✓ Paused <scope>=<target> for <duration> (id: <id>)`. JSON output behind `--json`.
- `packages/cli/src/commands/resume.ts` (NEW) — three modes: `--id <id>` (one switch), `--all` (every active), `--scope/--target` (filter). Calls `softResumeKillSwitch` or `softResumeAllKillSwitches`. Reports the resumed-switch count.
- `packages/cli/src/lib/duration.ts` (NEW) — pure parser: `parseDuration("5m" | "1h" | "24h" | "7d" | "1d6h"): { ms: number }`. Unit tests for every supported unit + composite.
- `packages/cli/src/program.ts` (MODIFIED) — wire `program.command('pause')` and `program.command('resume')` per the M08a wiring pattern. Reuse the existing `runPauseCommand`/`runResumeCommand` factory shape so tests can replace the handler.
- `packages/cli/__tests__/unit/commands/pause.test.ts` (NEW) — 6 fixtures including `--scope global` (no target), invalid scope rejected, expires-in parsed correctly.
- `packages/cli/__tests__/unit/commands/resume.test.ts` (NEW) — 4 fixtures.
- `packages/cli/__tests__/unit/lib/duration.test.ts` (NEW) — 10 fixtures.
- `packages/cli/__tests__/integration/pause-resume.test.ts` (NEW) — full roundtrip against a tmpdir SQLite: pause global hard → resume by id → second pause-resume of same scope produces a fresh row (idempotency by-design only when no active row exists at scope).

**Acceptance:**
- All CLI tests green.
- Exit-code contract: 0 ok, 1 invalid scope/target, 5 already-paused-at-this-scope (returns existing row id, prints "already paused").
- `--expires-in 5m` produces `expires_at = now + 5m`; the bridge's `listActiveKillSwitches` skips already-expired rows.

**Commit:** `feat(cli): pause + resume commands backed by kill_switches (M08b S3)`.

---

### S4 — `coodra logs <service>` (tail + read)

Pure file-read command. Reads `<coodraHome>/logs/<service>.log`. `--follow` uses `node:fs::watch` (the same pattern Hono dev tools use) — no `tail` shellout to keep Windows parity. `--since <ISO|relative>` parses with the duration parser from S3.

**Files:**
- `packages/cli/src/commands/logs.ts` (NEW).
- `packages/cli/src/lib/log-reader.ts` (NEW) — chunked-read + last-N-lines via reverse-seek (avoids loading multi-MB files into memory).
- `packages/cli/src/program.ts` (MODIFIED) — `program.command('logs')` wired.
- `packages/cli/__tests__/unit/commands/logs.test.ts` (NEW) — 5 fixtures including unknown service, missing file, last-N read, --since filter.
- `packages/cli/__tests__/integration/logs.test.ts` (NEW) — generates a 100-line test log file and asserts `--lines 10` returns the last 10.

**Acceptance:**
- `--follow` exits cleanly on SIGINT.
- Unknown service exits 1 with remediation listing valid services.
- Missing log file exits 2 (likely the daemon hasn't started yet) with a remediation pointer at `coodra start`.

**Commit:** `feat(cli): logs <service> tail/read command (M08b S4)`.

---

### S5 — `coodra db migrate`

Refactors the existing auto-migrate-at-init code into a standalone command. `init` continues to call the same primitive — no behaviour change there. Adds the standalone surface for upgrade flows (S7) and operator scripting.

**Files:**
- `packages/cli/src/commands/db-migrate.ts` (NEW) — opens local SQLite via `openLocalDb`, calls `migrateSqlite(handle.db)`, reports the number of migrations applied + last-migration timestamp. `--dry-run` calls `getPendingMigrations` (NEW helper in `@coodra/db`) without applying. Refuses to run while daemons are running unless `--with-daemons-running` is set; daemons-running check uses the existing `pid-status.ts` from M08a.
- `packages/db/src/index.ts` (MODIFIED) — export `getPendingMigrations(db: DbHandle): Promise<{ filename: string; appliedAt: Date | null }[]>` (new helper).
- `packages/cli/src/program.ts` (MODIFIED) — `program.command('db').command('migrate')` per the M08a `team` subcommand pattern.
- `packages/cli/__tests__/integration/db-migrate.test.ts` (NEW) — 4 fixtures: clean DB → applies all migrations, applied DB → reports 0 pending, daemons running → exits 1 unless `--with-daemons-running`, dry-run → no schema mutation.

**Acceptance:**
- Re-running `db migrate` is a no-op (idempotent, exits 0).
- Daemons-running detection is based on `~/.coodra/pids/*.pid` per M08a, not by probing the port (a stale pid + dead process must not block the migration).

**Commit:** `feat(cli): db migrate command (M08b S5)`.

---

### S6 — `coodra db backup` + `coodra db restore`

Per OQ-3 the default backup format is single-file `.sqlite` via `VACUUM INTO`; `--include-logs` produces a tarball. Per OQ-4 restore is atomic-replace with auto-backup-of-current; refuses if daemons running.

**Files:**
- `packages/cli/src/commands/db-backup.ts` (NEW) — opens the live SQLite for read, runs `VACUUM INTO ?` against the destination path. Backup path defaults to `~/.coodra/backups/data.db.bak.<ISO-with-colons-replaced>`. `--include-logs` switches to a tarball output via `node:zlib` + `tar-stream` (or `tar` if cleaner — see techstack.md). On `SQLITE_BUSY`, retries with `[100ms, 250ms, 1s]` backoff per spec §9.
- `packages/cli/src/commands/db-restore.ts` (NEW) — checks daemon-running state (refuses if running), validates `<path>` exists + is a SQLite file (magic-bytes check), takes auto-backup of current DB to `<current>.pre-restore-<ISO>`, atomic replaces via temp+rename. `--force` skips the confirmation prompt; `--no-auto-backup` skips the safety copy (warns aloud first).
- `packages/cli/src/lib/sqlite-magic.ts` (NEW) — small helper: read first 16 bytes, verify SQLite header (`53 51 4c 69 74 65 20 66 6f 72 6d 61 74 20 33 00`).
- `packages/cli/src/program.ts` (MODIFIED) — `program.command('db').command('backup')` + `program.command('db').command('restore')`.
- `packages/cli/__tests__/integration/db-backup.test.ts` (NEW) — 5 fixtures: backup → byte-identical roundtrip via restore, --include-logs produces a tarball, dest unwritable → exit 1, SQLITE_BUSY simulated → retries, --out absolute path is honoured.
- `packages/cli/__tests__/integration/db-restore.test.ts` (NEW) — 5 fixtures: restore from a known-good file → daemons must not be running, magic-bytes check rejects a `.txt` file, auto-backup is created by default, `--no-auto-backup` skips it, refuses if daemons running.

**Acceptance:**
- A backup → restore roundtrip yields a byte-identical DB on a quiescent system.
- The auto-backup-of-current is created EVEN when restore is from a fresh-install user — on first restore the current DB is captured for emergency rollback.
- `--include-logs` tarball is structured: `data.db.bak`, `logs/*.log`, `config.json` (if present, mode 0600). `tar -tf` lists all members.

**Reference updates in the same commit:** `External api and library reference.md` → SQLite subsection — append "VACUUM INTO + concurrent-writers gotcha: VACUUM INTO is read-only for the source DB; can run while daemons write".

**Commit:** `feat(cli): db backup + db restore (M08b S6)`.

---

### S7 — `coodra upgrade`

Three phases: (1) check published version vs installed via `npm view @coodra/cli version` (HTTPS GET, ~250ms p95 against `registry.npmjs.org`), (2) if the user has already installed the new version, run `db migrate` + cycle daemons, (3) print the install command for the user when a newer version is detected.

The CLI **does not self-update** — npm cannot reliably overwrite a binary that's currently executing on Windows, and on Linux/macOS the user's `node_modules/.bin/coodra` symlink would point at a half-written file mid-update. The user runs the command; the CLI confirms the result.

**Files:**
- `packages/cli/src/commands/upgrade.ts` (NEW) — orchestration: read installed version from `package.json` shipped with the CLI (already exposed by `version.ts` from M08a), spawn `npm view @coodra/cli version --json` via `execa`, parse, semver-compare. If installed >= published, run `db migrate` + restart daemons via existing `runStopCommand` + `runStartCommand`. If installed < published, print the install command + exit 2.
- `packages/cli/src/lib/npm-view.ts` (NEW) — thin wrapper around `execa('npm', ['view', '@coodra/cli', 'version', '--json'], { timeout: 5_000 })`. Returns parsed version or throws with structured error.
- `packages/cli/src/program.ts` (MODIFIED).
- `packages/cli/__tests__/unit/commands/upgrade.test.ts` (NEW) — 5 fixtures: stub npm-view → newer published, stub npm-view → matching, stub npm-view → throws (registry outage), `--check-only` does not restart, restart phase calls stop+start in order.

**Acceptance:**
- Single outbound HTTPS call to `registry.npmjs.org`. The unit test mocks the helper; an integration smoke test against the real registry (gated by `RUN_NETWORK_TESTS=1` env) confirms the wire shape on CI's main-branch job.
- Exit codes: 0 (already at published, migrations applied, daemons restarted), 1 (npm view failed), 2 (newer version available — user must install).

**Reference updates in the same commit:** `External api and library reference.md` → npm subsection (NEW) — short entry on the `npm view` registry-query wire format + the `--json` flag.

**Commit:** `feat(cli): upgrade command (M08b S7)`.

---

### S8 — `coodra uninstall`

Per OQ-5 the default is conservative — preserve user data + config + feature/context packs unless `--purge`. Removes IDE-side wires (the things M08a init wrote). Prints (does not run) the npm-uninstall command for the user.

**Files:**
- `packages/cli/src/commands/uninstall.ts` (NEW) — reverses M08a's `init` writes, in reverse order:
  1. Stop daemons (`runStopCommand({ uninstall: true })` from M08a — already removes daemon-manager units).
  2. Remove `__coodra__` matcher entries from `~/.claude/settings.json` (re-uses `mergeClaudeSettings` logic, in "remove" mode — new `removeClaudeSettings` helper next to existing `mergeClaudeSettings`).
  3. Remove the `coodra` server entry from `<cwd>/.mcp.json` (new `removeMcpJson` helper next to existing `mergeMcpJson`).
  4. Optionally `--purge`: `rm -rf ~/.coodra/`.
  5. Always: print the `npm uninstall -g @coodra/cli` command for the user.
- `packages/cli/src/lib/init/claude-settings-merge.ts` (MODIFIED) — add `removeClaudeSettings(options): Promise<MergeClaudeSettingsResult>` that finds and drops every entry whose `matcher === '__coodra__'`.
- `packages/cli/src/lib/init/mcp-merge.ts` (MODIFIED) — add `removeMcpJson(options): Promise<WriteOutcome>` that drops the `coodra` key from `mcpServers`.
- `packages/cli/src/program.ts` (MODIFIED).
- `packages/cli/__tests__/integration/uninstall.test.ts` (NEW) — 5 fixtures: removes claude entries, removes mcp entry, default keeps data, `--purge` removes ~/.coodra/, idempotent re-run is exit-0.

**Acceptance:**
- Re-running `uninstall` is exit-0 (idempotent — nothing to remove).
- The npm-uninstall command is printed verbatim; the CLI does not execute it.

**Commit:** `feat(cli): uninstall command (M08b S8)`.

---

### S9 — `coodra policy {list,show,add,enable,disable}`

Admin surface for the `policies` + `policy_rules` tables. Direct DB writes via `@coodra/db` helpers. Same pattern as `ensureDefaultPolicy` (M08a Phase-3 Fix D).

The MCP server's existing `check_policy` tool reads from the same tables; the policy evaluator's 60-second cache means a `policy add` won't be visible to the running bridge for up to a minute. S9 is OK with that — the cache TTL was chosen for read latency, not write propagation. (A future enhancement: `pause` already invalidates the kill-switch cache; `policy add` could optionally invalidate the policy cache via a sentinel file. Out of S9 scope; called out in the slice's "deferred follow-ups" section.)

**Files:**
- `packages/cli/src/commands/policy.ts` (NEW) — five subcommands. Reuses the same project-resolution helper from S3.
- `packages/db/src/policies.ts` (NEW) — admin helpers:
  - `listPolicies(db, projectId | null): Promise<(Policy & { rules: PolicyRule[] })[]>`
  - `getPolicy(db, identifier: string): Promise<...>` (id or name)
  - `addPolicyRule(db, args: { projectId, ...ruleSpec }): Promise<{ policyId, ruleId }>` — auto-creates `__default__` policy if absent (matching `ensureDefaultPolicy` shape).
  - `setPolicyActive(db, identifier, active: boolean): Promise<Policy | null>`.
- `packages/db/src/index.ts` — re-export.
- `packages/cli/__tests__/integration/policy-admin.test.ts` (NEW) — 8 fixtures × 5 subcommands.
- `packages/db/__tests__/integration/policies-admin.test.ts` (NEW) — 6 helper fixtures.

**Acceptance:**
- `policy add` produces a row that the next `policy list` immediately reflects.
- The `__default__` policy from `ensureDefaultPolicy` (M08a Fix D) is preserved — `policy add` always lands rules on the existing `__default__` rather than creating a parallel policy.
- `policy disable` is idempotent — disabling an already-disabled policy is exit-0.

**Commit:** `feat(cli,db): policy admin commands (list, show, add, enable, disable) (M08b S9)`.

---

### S10 — `coodra project {list,show,reset}`

Admin surface for the `projects` table.

**Files:**
- `packages/cli/src/commands/project.ts` (NEW) — three subcommands.
- `packages/db/src/projects.ts` (NEW) — `listProjects(db): Promise<...>` (with run-count + last-run timestamp via join), `getProjectByIdentifier(db, slug | id)`, `resetProject(db, projectId, options: { keepPolicies: boolean }): Promise<{ runsDeleted, eventsDeleted, decisionsDeleted, policyDecisionsDeleted, contextPacksDeleted }>`.
- `packages/cli/__tests__/integration/project-admin.test.ts` (NEW) — 7 fixtures including the destructive `reset` path with confirmation.

**Acceptance:**
- `project reset` without `--force` exits 2 with an explicit "this will delete N rows; pass --force to confirm" message.
- The `__global__` sentinel project is **not** resettable (refused with exit 1) — losing it would break F7 invariants.
- `--keep-policies` (default true) preserves `policies` + `policy_rules` rows.

**Commit:** `feat(cli,db): project admin commands (list, show, reset) (M08b S10)`.

---

### S11 — `coodra run {list,show,cancel}`

Admin surface for the `runs` table. Per OQ-6 cancel is informational — bridge does not block future events.

**Files:**
- `packages/cli/src/commands/run.ts` (NEW) — three subcommands.
- `packages/db/src/runs-admin.ts` (NEW) — `listRunsForProject(db, projectId, filter)`, `getRunWithEverything(db, runId): Promise<{ run, events: RunEvent[], decisions: Decision[], policyDecisions: PolicyDecision[], contextPack: ContextPack | null }>`, `cancelRun(db, runId): Promise<Run | null>` (sets status='cancelled' + ended_at=now()).
- `packages/cli/__tests__/integration/run-admin.test.ts` (NEW) — 6 fixtures.

**Acceptance:**
- `run cancel` on an already-`completed` run exits 2 (already-terminal-state).
- `run show` formats as a human-readable timeline (events sorted by created_at) by default; `--json` emits the structured object verbatim.

**Commit:** `feat(cli,db): run admin commands (list, show, cancel) (M08b S11)`.

---

### S12 — `coodra export <runId>`

Read-only assembler. Per OQ-7 the markdown / html / slack formats default to excluding `policy_decisions`; `--include-audit` opts in. JSON always includes audit.

**Files:**
- `packages/cli/src/commands/export.ts` (NEW) — orchestration + arg parsing + output dispatch.
- `packages/cli/src/lib/export/render-markdown.ts` (NEW) — pure function `renderMarkdown(data: RunWithEverything, options: { includeAudit: boolean }): string`.
- `packages/cli/src/lib/export/render-json.ts` (NEW) — pure JSON serialization (always includes audit).
- `packages/cli/src/lib/export/render-html.ts` (NEW) — wraps the markdown renderer's output in a self-contained HTML doc with embedded CSS (no external assets, single-file artifact).
- `packages/cli/src/lib/export/render-slack.ts` (NEW) — Slack mrkdwn (truncated subset of markdown); `--webhook <url>` POSTs the payload to a Slack incoming-webhook URL via Node's built-in `fetch` (no new dep).
- `packages/cli/__tests__/unit/lib/export/render-markdown.test.ts` (NEW) — golden-file fixtures.
- `packages/cli/__tests__/unit/lib/export/render-json.test.ts` (NEW) — schema validation roundtrip.
- `packages/cli/__tests__/unit/lib/export/render-html.test.ts` (NEW) — DOM smoke test (parses cleanly).
- `packages/cli/__tests__/unit/lib/export/render-slack.test.ts` (NEW) — mrkdwn shape + truncation rules.
- `packages/cli/__tests__/integration/export.test.ts` (NEW) — full happy-path roundtrip per format + the `--webhook` POST against a localhost mock server.

**Acceptance:**
- All four formats produced for the same `runId` are mutually consistent (json shape ⊇ markdown content).
- `--out` writes to disk; without it, output goes to stdout (so `coodra export <runId> --format markdown | pbcopy` works on macOS).
- `--webhook` failure surfaces the format payload to stdout AS WELL — the user never loses content to a network glitch.

**Commit:** `feat(cli): export <runId> --format markdown|json|html|slack (M08b S12)`.

---

### S13 — Templates library scaffold + bundling + `init --template <name|path>`

Adds the seven bundled templates + the `lib/template-paths.ts` resolver + extends `init` with the `--template` flag. The new `--mode` flag is **stubbed** here (accepts the flag, prints a "S15 will populate this" stderr line in `auto`); the real auto-population lands in S15 once the auto-marker parser (S14) exists.

**Files:**
- `packages/cli/templates/{generic,node-monorepo,nextjs-saas,python-ml,python-fastapi,rust-cli,go-service}/` (NEW) — each containing `template.json`, `spec.md.tmpl`, `implementation.md.tmpl`, `techstack.md.tmpl`, `meta.json.tmpl`. Templates ship with explicit `<!-- @auto:* -->` markers in the relevant sections.
- `packages/cli/scripts/bundle.mjs` (MODIFIED) — copy `templates/**` into `dist/templates/**`. Add the templates to the externals-not-bundled allowlist (asset copy, not bundle).
- `packages/cli/src/lib/template-paths.ts` (NEW) — same resolver pattern as `runtime-paths.ts`: bundled-first, `~/.coodra/templates/*` second. Returns `{ name, source: 'bundled'|'user', dir }` or null.
- `packages/cli/src/lib/templates/load-template.ts` (NEW) — reads `template.json`, validates against a Zod schema, returns the template definition.
- `packages/cli/src/lib/templates/render.ts` (NEW) — pure: `renderTemplate(definition, context: { slug, languages, deps }): { 'spec.md': string, 'implementation.md': string, 'techstack.md': string, 'meta.json': string }`. Mustache-style hand-rolled `{{slug}}` substitution.
- `packages/cli/src/lib/templates/detect.ts` (NEW) — `detectTemplate(projectRoot, availableTemplates): TemplateDefinition | null` per the spec.md §7 detection rules.
- `packages/cli/src/lib/init/feature-pack-seed.ts` (MODIFIED) — accepts an optional `template` parameter; when present, calls `renderTemplate` instead of the existing `buildSpecSkeleton/buildImplementationSkeleton/buildTechstackSkeleton` helpers. The existing skeletons remain as the `generic` template's body.
- `packages/cli/src/commands/init.ts` (MODIFIED) — adds `--template` + `--mode` flags; `--mode auto` resolves the template via `detectTemplate`; `--mode minimal|default` keeps M08a behaviour.
- `packages/cli/__tests__/unit/lib/template-paths.test.ts` (NEW) — 5 fixtures.
- `packages/cli/__tests__/unit/lib/templates/load-template.test.ts` (NEW) — 4 fixtures including invalid template.json.
- `packages/cli/__tests__/unit/lib/templates/render.test.ts` (NEW) — 4 fixtures × 4 files = 16 substitution checks.
- `packages/cli/__tests__/unit/lib/templates/detect.test.ts` (NEW) — 9 fixtures (one per template + 2 fallbacks).
- `packages/cli/__tests__/integration/init-with-template.test.ts` (NEW) — 4 fixtures: `init --template nextjs-saas`, `init --template ./local-template-dir`, invalid template name → exit 2, package.json signal triggers detection.

**Acceptance:**
- `npm pack --dry-run` shows every template file under `dist/templates/**` per acceptance criterion #9.
- `init --template generic` produces the same output as M08a's bare `init` (regression check).
- `init --template <path>` accepts a non-bundled local directory.

**Reference updates in the same commit:** `External api and library reference.md` → bundled-asset packaging section (NEW) — note that `dist/templates/**` is co-shipped with the runtime artifacts and resolved via `lib/template-paths.ts`.

**Commit:** `feat(cli): templates library + init --template (M08b S13)`.

---

### S14 — `<!-- @auto -->` parser + serializer (pure, no I/O)

Pure utility used by S15 (`init --mode auto`) and S16 (`pack regenerate`). No I/O, no file writes — operates on strings. Lands here so S15 + S16 share one tested implementation.

**Files:**
- `packages/cli/src/lib/auto-marker/parser.ts` (NEW) — `parseAutoSections(markdown: string): { sections: AutoSection[]; errors: ParseError[] }`. Each section: `{ name, openLine, closeLine, innerLines }`. Parser respects fenced code blocks (\`\`\`).
- `packages/cli/src/lib/auto-marker/serializer.ts` (NEW) — `replaceAutoSections(markdown: string, replacements: { [sectionName: string]: string }, options: { appendNewSections: boolean }): { markdown: string; orphans: string[]; appended: string[] }`. Pure — produces a new string.
- `packages/cli/src/lib/auto-marker/types.ts` (NEW).
- `packages/cli/__tests__/unit/lib/auto-marker/parser.test.ts` (NEW) — 12 fixtures per spec.md §10:
  1. Well-formed single section.
  2. Well-formed multiple sections.
  3. Missing close tag → ParseError.
  4. Nested open tag → ParseError.
  5. Literal `<!-- @auto:foo -->` inside fenced code block → NOT parsed as a marker.
  6. Two same-name sections → ParseError.
  7. Open tag mid-line (not on its own line) → NOT parsed.
  8. Close tag without preceding open → ParseError.
  9. Empty inner content → valid (allowed).
  10. Section name with hyphens → valid.
  11. Section name with uppercase → ParseError (lowercase-only grammar).
  12. CRLF line endings → handled correctly.
- `packages/cli/__tests__/unit/lib/auto-marker/serializer.test.ts` (NEW) — 8 fixtures including orphan handling, append-new-section behaviour, idempotent re-serialization.

**Acceptance:**
- 100% line coverage on the parser + serializer.
- Roundtrip property: `serialize(parse(x)) === x` when no replacements are applied (proven via property-based test using `fast-check` — see techstack.md).

**Commit:** `feat(cli): @auto-marker parser + serializer (M08b S14)`.

---

### S15 — `init --mode auto` populates auto sections from project shape

Combines S13 (templates) + S14 (parser) — `init --mode auto` detects the template, renders it, then walks each generated `<!-- @auto:* -->` section and populates it from the project's shape (deps from package.json / pyproject.toml / Cargo.toml / go.mod, scripts, directory structure to depth 3). The non-auto bodies of `spec.md` / `implementation.md` / `techstack.md` remain the template's static prose.

**Files:**
- `packages/cli/src/lib/init/auto-populate.ts` (NEW) — `populateAutoSections(template, projectRoot, sectionNames): { [sectionName: string]: string }`. Each known section name has a generator function:
  - `dependencies` — reads package.json/pyproject.toml/Cargo.toml/go.mod, formats as a markdown table.
  - `directory-structure` — `ls -R` to depth 3, formatted as a tree.
  - `scripts` — package.json `scripts` field formatted as a list.
  - `entry-points` — heuristic main file detection (`src/index.ts`, `cmd/main.go`, `app/main.py`, etc.).
  - `services` — running daemons detected via M08a's `pid-status.ts` (informational).
- `packages/cli/src/lib/init/feature-pack-seed.ts` (MODIFIED) — when `mode === 'auto'`, calls `populateAutoSections` after `renderTemplate` and stitches results in via the S14 serializer.
- `packages/cli/__tests__/unit/lib/init/auto-populate.test.ts` (NEW) — 6 fixtures × 5 generators = thorough coverage.
- `packages/cli/__tests__/integration/init-mode-auto.test.ts` (NEW) — 3 fixtures: nextjs-saas full roundtrip, python-fastapi full roundtrip, --mode auto on a project with no detectable template falls back to `generic`.

**Acceptance:**
- The four files produced by `init --mode auto` have populated auto-sections + template prose; running `pack regenerate` immediately after on the same project produces a no-op diff.
- Each generator has a "no data" path (e.g., a Rust project's package.json doesn't exist; the dependencies generator returns "_no package.json detected_" rather than crashing).

**Commit:** `feat(cli): init --mode auto populates auto-sections from project shape (M08b S15)`.

---

### S16 — `coodra pack {new,list,show,regenerate,delete}`

Per spec.md §4.3. Reuses S13's templates + S14's parser/serializer + S15's auto-populator.

**Files:**
- `packages/cli/src/commands/pack.ts` (NEW) — five subcommands.
- `packages/cli/src/lib/pack/list.ts` (NEW) — walks `docs/feature-packs/`, joins with `feature_packs` table for isActive flag.
- `packages/cli/src/lib/pack/show.ts` (NEW) — reads + summarizes one pack.
- `packages/cli/src/lib/pack/new.ts` (NEW) — creates the four-file folder, writes a `feature_packs` row (slug + checksum=0 + isActive=true).
- `packages/cli/src/lib/pack/regenerate.ts` (NEW) — reads existing files, parses auto sections, re-renders template + auto-populator, replaces + appends + orphans per spec.md §10. Atomic temp+rename per file.
- `packages/cli/src/lib/pack/delete.ts` (NEW) — removes the directory; flips `feature_packs.is_active=false` (does NOT delete the row — append-only spirit).
- `packages/cli/__tests__/integration/pack-new.test.ts` (NEW) — 4 fixtures.
- `packages/cli/__tests__/integration/pack-regenerate.test.ts` (NEW) — 6 fixtures: refresh sections, append new section, orphan a removed section, --dry-run prints diff, parser-error in existing file → exit 3, idempotent re-run.

**Acceptance:**
- `pack regenerate` is idempotent against an unchanged project (zero-byte diff).
- `pack delete <slug>` does not break MCP `search_packs_nl` for previously-saved context packs in that slug — the `feature_packs` row stays, the MCP server's filter respects `is_active`.

**Commit:** `feat(cli): pack admin commands (new, list, show, regenerate, delete) (M08b S16)`.

---

### S17 — `coodra template {list,install}`

User templates land in `~/.coodra/templates/<name>/` and override bundled templates of the same name. Bundled templates cannot be overwritten.

**Files:**
- `packages/cli/src/commands/template.ts` (NEW) — two subcommands.
- `packages/cli/src/lib/templates/install.ts` (NEW) — copies the source directory to `~/.coodra/templates/<name>/` after validating `template.json` + the four `*.tmpl` files. Refuses to overwrite a bundled-template name (i.e. user can't shadow `generic`).
- `packages/cli/__tests__/integration/template-install.test.ts` (NEW) — 4 fixtures.

**Deferred follow-up (NOT in S17):**
- `template install <git+https://...>` cloning a remote template — call out as a future-slice in the M08b closeout pack.

**Acceptance:**
- `template list` shows bundled (7) + user (N) entries with correct source labels.
- Installing a template with a missing `template.json` exits 1 with a remediation pointing at the spec.md §7 layout.

**Commit:** `feat(cli): template list + install (M08b S17)`.

---

### S18 — Doctor extensions (5 new checks)

Adds checks 21–25 to the doctor registry:

- **21 — Active kill-switch count.** Reads `kill_switches WHERE resumed_at IS NULL` + reports count + age of the oldest active switch. YELLOW if count > 0 (not RED — pause is intentional, but operator should know).
- **22 — Upgrade available.** Only runs with `--check-updates` flag (off by default to keep doctor offline). When on: calls the S7 npm-view helper. YELLOW if newer version available.
- **23 — Stale backup files.** Walks `~/.coodra/backups/`. YELLOW if any file older than 30 days exists; reports total size.
- **24 — Bundled templates manifest.** Asserts every `dist/templates/<name>/template.json` is present + parseable. RED on parse failure (corrupted install).
- **25 — Auto-marker grammar smoke.** Loads each bundled template's `*.tmpl` files, runs the S14 parser; YELLOW if any parse error.

**Files:**
- `packages/cli/src/doctor/checks/kill-switches.ts` (NEW)
- `packages/cli/src/doctor/checks/upgrade-available.ts` (NEW)
- `packages/cli/src/doctor/checks/stale-backups.ts` (NEW)
- `packages/cli/src/doctor/checks/bundled-templates.ts` (NEW)
- `packages/cli/src/doctor/checks/auto-marker-smoke.ts` (NEW)
- `packages/cli/src/doctor/registry.ts` (MODIFIED) — add the five checks.
- `packages/cli/__tests__/unit/doctor/checks/*.test.ts` — one unit test per new check.
- `packages/cli/__tests__/integration/doctor-extended.test.ts` (NEW) — full doctor run with all 25 checks against a controlled scenario.

**Acceptance:**
- M08a's existing 20 checks unchanged.
- `doctor --json` schema unchanged at the top-level (just five new entries in `checks`).
- `doctor --essentials-only` honours M08a's earlier subset behaviour and excludes 21–25 unless the user explicitly opts in.

**Commit:** `feat(cli): doctor checks 21-25 (M08b S18)`.

---

### S19 — M08b closeout context pack + module status update

Write `docs/context-packs/2026-MM-DD-module-08b-cli-expansion.md`:
- What was built (one paragraph per slice group).
- Decisions made (the eight OQ answers, plus any per-slice mid-implementation decisions added to `context_memory/decisions-log.md`).
- Files created or modified (`git diff main...feat/08b-cli-expansion --stat`).
- Tests written (count by type).
- Known issues / deferred follow-ups: M04 admin parity, M05 quality signals, M05 LLM-driven `pack regenerate`, team-mode kill-switch sync, `template install <git+url>`, `policy import/export`.

Update `README.md`'s module status table — M08b ✅ complete; flag M04 / M05 / M07 callouts where M08b's existence simplifies the dependent module.

**Files:** `docs/context-packs/2026-MM-DD-module-08b-cli-expansion.md`, `README.md`.

**Commit:** `docs(08b-cli-expansion): module-08b closeout context pack + module status update`.

---

## Verification (end-to-end smoke before squash-merge)

After all 19 slices land:

1. `pnpm build` — clean compile, all packages green.
2. `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration && pnpm test:e2e` — full repo green.
3. **Manual operator walk-through** on a clean-ish dev box:
   - `npx @coodra/cli@<sha> init --template nextjs-saas --mode auto` in a fresh Next.js repo. Inspect the four files; confirm template prose is present + auto sections populated from `package.json`.
   - `coodra pause --reason "demo"`; start a Claude Code session; confirm the agent's first tool-use is denied with `kill_switch_paused:<id>` reason; `coodra resume --all`; next tool-use evaluates against policy normally.
   - `coodra run list`; `coodra run show <id>`; `coodra export <id> --format markdown` and read the output.
   - `coodra db backup --include-logs --out /tmp/full.tar.gz`; `tar -tf /tmp/full.tar.gz` lists data + logs + config.
   - `coodra pack regenerate <slug>` after editing the auto-section content by hand; confirm the user-edit OUTSIDE markers is preserved and the auto-section content INSIDE markers is replaced.
   - `coodra uninstall`; verify ~/.claude/settings.json has no `__coodra__` matchers; verify ~/.coodra/data.db is preserved; re-run `init` and confirm everything comes back without data loss.
4. CI green on `feat/08b-cli-expansion` for every commit on the branch.
5. Squash-merge to `main` via `gh pr create` then `gh pr merge --squash --delete-branch`.

## Out of scope for this batch (flagged for later)

- **M04 Web App admin parity.** The Web App will eventually expose `policy/project/run/export` parallel to the CLI. M08b's CLI shapes ARE the contract; M04 renders against them. No blocker.
- **M05 NL-Assembly LLM enrichment.** `pack regenerate` is heuristic-only in M08b. M05 adds an `--llm-rewrite` flag that calls the configured Tier-2 LLM (Gemini / Anthropic / Ollama) to refresh prose. Not a blocker.
- **`feature_pack_section_usage` table.** Tracking which sections of a pack the agent referenced needs M05 NL-Assembly hooks. Schema delta deferred to M05.
- **Team-mode kill-switch sync.** Synced kill-switches are M04's surface. M08b is local-only.
- **`template install <git+https://...>`.** Cloning a remote template is a future S17 follow-up. M08b accepts local paths only.
- **`policy import/export <file>`.** Snapshotting / sharing policies between projects. Worth doing once we see real demand.
- **`run replay <id>`.** Replaying a past run's events through the live bridge for testing. Could be useful for regression coverage; out of scope for M08b.
- **`coodra audit <date-range>` SOC2 export.** A flatter `export --format json` over many runs. Useful for compliance reviews; not in M08b.
- **CRUD on `decisions` / `context_packs` from the CLI.** Both tables are append-only by ADR-007. M08b reads them but never deletes/updates rows.
- **Windows daemon-manager parity.** M08a deferred Task Scheduler integration; M08b inherits the same posture.

When any of these surfaces user demand or unblocks a downstream module, schedule a slice in the appropriate module's plan.
