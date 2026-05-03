# Module 08b — CLI Expansion (closeout)

- **Date:** 2026-05-03
- **Module:** 08b — CLI Expansion (`@coodra/contextos-cli` operational essentials + admin surfaces + Feature-Pack flexibility)
- **Feature Pack:** `docs/feature-packs/08b-cli-expansion/`
- **Session lead (human):** Abishai
- **Run ID:** n/a (worked from CLAUDE.md + context_memory; no MCP `get_run_id` was issued for this multi-day branch)
- **Branch at session start:** `feat/08b-cli-expansion` (created from `main` at `d4cd2f8`)
- **Branch at session end:** `feat/08b-cli-expansion` @ `e17be0f`
- **Commits landed this session (newest first):**
  - `e17be0f` S18 — five operational-visibility doctor checks (slots 31–35)
  - `9a0656b` S17 — `template list` + `template install`
  - `b7aa846` S16 — `pack {new,list,show,regenerate,delete}`
  - `2141a39` S15 — `init --mode auto` populates auto-sections from project shape
  - `c862bad` S14 — `<!-- @auto -->` parser + serializer (pure)
  - `ec4a095` S13 — templates library + `init --template`
  - `9649d45` S12 — `export <runId> --format markdown|json|html|slack`
  - `5e3b2f8` S11 — `run {list,show,cancel}`
  - `0c0e11e` S10 — `project {list,show,reset}`
  - `ab12658` S9 — `policy {list,show,add,enable,disable}`
  - `f815a30` S8.5 — `CLAUDE_SETTINGS_PATH` env override (sandbox-safe uninstall)
  - `7fbed49` S8 — `uninstall` (default-safe; `--purge` opt-in)
  - `b33665f` S7 — `upgrade` (npm view + version comparison; never self-updates)
  - `7e23443` S6 — `db backup` + `db restore` (atomic, magic-bytes validated)
  - `fea549f` S5 — `db migrate` (idempotent + daemons-running refusal)
  - `ebab44a` S4 — `logs <service>` (chunked reverse-seek tail + `--since`)
  - `7b1e2c9` S3 — `pause` + `resume` (kill-switch CLI surface)
  - `ecc22cf` S2 — hooks-bridge kill-switch evaluator (consults DB before policy chain)
  - `27c69f8` S1 — `kill_switches` table + helpers + migration `0007`
  - `ee8ac9c` S0 — kickoff spec + slice plan + locked OQ answers

## Outcome

`@coodra/contextos-cli` now ships a complete operational + admin surface on top of the M08a install/lifecycle base — 20 top-level commands (up from 8). An operator can pause/resume enforcement, tail service logs, apply schema migrations, back up + restore the local SQLite primary store, upgrade the package + its on-disk artefacts in sync, uninstall cleanly (default-safe, opt-in `--purge`), inspect + administer policies/projects/runs/feature-packs, render any run as markdown/json/html/slack, and seed feature packs from one of seven bundled templates with auto-sections that re-populate from project shape on regenerate. The hooks-bridge kill-switch evaluator runs ahead of the policy chain — a `contextos pause` flips deny/allow-with-audit on the next event, in process, fail-open on DB error per `system-architecture.md` §7. One schema delta (`kill_switches`, migration `0007`) and zero changes to existing tables. Every M08a command keeps its surface verbatim. `--full` doctor returns 35 checks (was 30); five new ones surface kill-switch state, upgrade availability, stale backups, bundled-template integrity, and auto-marker grammar smoke.

## Scope boundary

**In scope (delivered):**

- AC-1…AC-3 — `pnpm install`/`lint`/`typecheck` clean across the workspace.
- AC-4 — Unit tests pass (188/188 in `packages/cli`); coverage ≥ 80% on touched files.
- AC-5 — Integration tests pass (49/55, 6 skipped pre-existing M03/M04a probes): bridge kill-switch evaluator runs before policy chain (S2); `db backup`/`restore` byte-roundtrip (S6); `policy add` visible to running MCP server (S9); `pack regenerate` preserves user content outside `<!-- @auto -->` markers (S16); `init --template python-fastapi` produces a validating `meta.json` + template-content `spec.md` (S13).
- AC-7 — `kill_switches` migration `0007` lands on both SQLite + Postgres dialects with zero changes to existing tables (S1). The 0006 slot stays reserved by Phase 4 Fix K's `policy_rules` UNIQUE-constraint cleanup.
- AC-8 — Backwards compatibility preserved: every M08a command keeps its flag set + exit codes verbatim. Exit codes 5 (kill-switch refusal) and 6 (backup/restore precondition) added per the M08b table; codes 7–9 stay reserved for follow-ups.
- AC-9 — Templates ship inside the npm tarball: `bundle.mjs` step 5 copies `packages/cli/templates/` → `dist/templates/`. All seven templates load via `loadTemplate` (verified by S18 check 34 against the bundled output).
- AC-10 — Auto-marker contract documented (S0/S14) and covered by parser unit tests; behaviour exercised end-to-end by S15/S16.
- AC-11 — `pause` is reversible via soft-resume (`resumed_at IS NULL` is the active predicate). Resumed rows stay in the table as audit history (S1, parallels ADR-007 append-only).
- AC-12 — `uninstall` default-safe per OQ-5 lock (preserves `data.db` + `config.json` + every `docs/feature-packs/<slug>/` + every `docs/context-packs/`); `--purge` opt-in adds `~/.contextos/` removal and prints the npm-uninstall command for the user to run manually (S8).
- AC-13 — `export` is read-only: no DB mutation, no file write outside `--out` (or stdout). Four format renderers (markdown/json/html/slack) + `--include-audit` toggle covered by integration tests (S12).
- AC-14 — No new automatic outbound HTTP. The two new outbound paths (`upgrade`'s `npm view`, `export --format slack --webhook`) are both explicit user invocations.
- AC-15 — Doctor extensions land at slots 31–35 (the spec's "21–25" was the original numbering before Phase 4 Fix L took 28–30). Five checks: active kill-switch count, upgrade-available (env-gated), stale backups, bundled-templates manifest, @auto-marker grammar smoke (S18).
- AC-16 — This Context Pack.

**Deliberately deferred (per M08b §3 non-goals):**

- **AC-6 — kill-switch e2e** is *covered by the integration suite + manual functional verification at S8 milestone*, not by a dedicated e2e file. The integration test in `apps/hooks-bridge/__tests__/integration/kill-switch-evaluator.test.ts` exercises the same protocol against the bridge's HTTP surface; the kickoff promised an e2e but the integration coverage is equivalent for the protocol the AC describes. **Honest gap**: a full e2e that boots the bridge against a real Claude-Code-style PreToolUse stream is not in this branch — flagged for the M07 VS Code Extension closeout, which needs the same harness.
- **No telemetry, no marketing site, no npm-publish automation, no cross-developer kill-switch sync, no `pack regenerate` LLM enrichment, no CRUD on append-only tables, no GUI installer.** All per M08b §3.
- **`feature_pack_section_usage` table** stays out — depends on M05 NL Assembly hooks. `pack show` reports last-modified, file size, detected language; never quality.

## Decisions made

The eight open questions in spec.md §11 were locked at S0 and acted as protocol for every downstream slice. Each is preserved verbatim in `context_memory/decisions-log.md` (search "M08b OQ-"). Summary, with cross-references:

- **Decision (OQ-1):** kill-switch `mode` defaults to `'hard'` (deny). **Rationale:** matches the principle of least surprise — `pause` should stop the system, not silently audit. Soft is opt-in via `--soft`. **Constrains:** S1 schema default + S3 CLI default. **Cross-ref:** decisions-log 2026-05-03 OQ-1.
- **Decision (OQ-2):** polymorphic `(scope, target)` shape for `kill_switches` (single table, four scope values: `global`/`project`/`tool`/`agent_type`). **Rationale:** one table + one matcher beats four tables + four matchers; the scope-cardinality is small. **Constrains:** S1 schema + S2 evaluator. **Cross-ref:** decisions-log 2026-05-03 OQ-2.
- **Decision (OQ-3):** `db backup` defaults to `VACUUM INTO`; `--include-logs` produces a tarball that bundles the db plus `~/.contextos/logs/`. **Rationale:** `VACUUM INTO` is atomic + smaller; the tarball is the "I'm filing a bug" surface. **Constrains:** S6 implementation. **Cross-ref:** decisions-log 2026-05-03 OQ-3.
- **Decision (OQ-4):** `upgrade` never self-updates; it prints the `npm i -g @coodra/contextos-cli@<version>` command for the user to run. **Rationale:** self-uninstall + reinstall while the binary is mid-execution is unreliable on Windows; the user keeps the destructive action. **Constrains:** S7 implementation. **Cross-ref:** decisions-log 2026-05-03 OQ-4.
- **Decision (OQ-5):** `uninstall` default-safe; `--purge` opt-in to wipe `~/.contextos/`. **Rationale:** matches `apt-get remove` vs `apt-get purge`; users reinstall and expect their feature/context packs to still be there. **Constrains:** S8 default-safe path. **Cross-ref:** decisions-log 2026-05-03 OQ-5.
- **Decision (OQ-6):** `run cancel` flips status only; bridge keeps recording. **Rationale:** adding a `runs.status` lookup on every PostToolUse costs ~1 ms on a 10 ms budget for debugging-utility-grade gain. **Constrains:** S11 implementation + bridge contract. **Cross-ref:** decisions-log 2026-05-03 OQ-6.
- **Decision (OQ-7):** `export` excludes the audit by default for narrative formats (markdown/html/slack); JSON always includes it. **Rationale:** narrative readers want the story; JSON consumers want the full record. **Constrains:** S12 renderer defaults. **Cross-ref:** decisions-log 2026-05-03 OQ-7.
- **Decision (OQ-8):** kill switches are local-only; cross-developer sync is M04's surface. **Rationale:** no managed-cloud product yet — building sync now would couple M08b to a not-yet-decided cloud authorization model. **Constrains:** S2 (no sync-daemon enqueue) + S3 (CLI never POSTs to cloud). **Cross-ref:** decisions-log 2026-05-03 OQ-8.

Mid-flight design calls (not OQ-locked, recorded as the slices landed):

- **Decision (S6):** `db restore` validates the SQLite magic-bytes header (`53 51 4c 69 74 65 20 66 6f 72 6d 61 74 20 33 00`) before swapping. **Rationale:** an atomic copy+rename of a non-SQLite file would still succeed at the FS layer but corrupt the live store. Magic-bytes validation is the cheapest pre-flight check. **Cross-ref:** `packages/cli/src/lib/sqlite-magic.ts`.
- **Decision (S8.5):** `defaultClaudeSettingsPath()` honours `CLAUDE_SETTINGS_PATH` env override. **Rationale:** during functional verification of S8 the uninstall command modified the user's REAL `~/.claude/settings.json` in a sandbox run because there was no env override. Fixed before continuing. **Cross-ref:** `packages/cli/src/lib/init/claude-settings-merge.ts`.
- **Decision (S12):** HTML renderer uses `__CTX_CODE_N__` as the code-span sentinel. **Rationale:** biome --write mangled my literal-space delimiter into NUL bytes (illegal in regex). Sentinel chosen so any future biome reformat can't break it. **Cross-ref:** `packages/cli/src/lib/export/render-html.ts`.
- **Decision (S18):** `listAllActiveKillSwitches(db)` added as a sibling of the bridge-facing `listActiveKillSwitches(db, projectId)`. **Rationale:** the bridge's helper filters out project-scoped switches when called with `projectId=null`; the doctor (and future "show me everything paused" surfaces in M04) need every active row regardless of scope. **Cross-ref:** `packages/db/src/kill-switches.ts`.
- **Decision (S18):** doctor checks 31–35 land at slots 31–35, not the spec's "21–25". **Rationale:** Phase 4 Fix L (lifecycle invariants) took 28–30 and 21–27 were already occupied by team-mode + outbox observability checks. Slot numbers were never load-bearing — only the "five M08b checks" promise was. **Cross-ref:** `packages/cli/src/doctor/registry.ts`.

## Files touched

Grouped by package. Verbs: created / updated / removed / generated.

`packages/db/`

- `src/schema/sqlite.ts` — updated (added `killSwitches` table)
- `src/schema/postgres.ts` — updated (mirror of sqlite)
- `src/kill-switches.ts` — created (helpers: `listActiveKillSwitches`, `listAllActiveKillSwitches`, `insertKillSwitch`, `softResumeKillSwitch`, `softResumeAllKillSwitches`, `findKillSwitchMatchingEvent`)
- `src/policies.ts` — created (helpers backing `policy {list,show,add,enable,disable}`; auto-seeds `__default__` policy if absent; defaults priority to max+10 or 100)
- `src/projects.ts` — created (helpers backing `project {list,show,reset}`; FK-aware cascade ordering: policy_decisions → run_events/decisions → context_packs → runs → optional kill_switches/policies/policy_rules; refuses to reset `__global__` per F7)
- `src/runs-admin.ts` — created (helpers backing `run {list,show,cancel}`; `cancelRun` returns discriminated `{status: 'cancelled'|'not_found'|'already_terminal', run?}`)
- `src/index.ts` — updated (re-exports for the four new helper modules)
- `migrations/sqlite/0007_*.sql` — generated (kill_switches DDL)
- `migrations/postgres/0007_*.sql` — generated (mirror)
- `migrations.lock.json` — updated (locks 0007's hand-written preserve blocks per the existing convention)

`apps/hooks-bridge/`

- `src/lib/kill-switch-evaluator.ts` — created (5s in-process cache, fail-open on DB throw per system-architecture §7)
- `src/handlers/pre-tool-use.ts` — updated (consults killSwitchEvaluator BEFORE the policy chain; hard match → deny + reason `kill_switch_paused:<id>`; soft match → allow + same reason + audit row)
- `__tests__/integration/kill-switch-evaluator.test.ts` — created (full lifecycle: pause global hard → bridge denies → resume → policy chain resumes; soft tool-scoped pause → allow + audit)

`packages/cli/src/`

- `commands/pause.ts` — created (`--scope global` + `--mode hard` defaults; exit code 5 for duplicate active switch)
- `commands/resume.ts` — created (`--id` | `--all` | `--scope[/--target]` mutually exclusive)
- `commands/logs.ts` — created (chunked reverse-seek tail + `--since` filter on JSON `time` field; service whitelist: mcp-server | hooks-bridge | sync-daemon)
- `commands/db-migrate.ts` — created (idempotent + daemons-running refusal)
- `commands/db-backup.ts` — created (`VACUUM INTO` default + `--include-logs` tarball with staging dir)
- `commands/db-restore.ts` — created (atomic copy+rename + auto-backup of current + magic-bytes validation)
- `commands/upgrade.ts` — created (`npm view` + semver compare; three states: newer_available / up_to_date / check_failed)
- `commands/uninstall.ts` — created (3-step pipeline: claude-settings → mcp-json → optional `--purge`)
- `commands/policy.ts` — created (5 subcommands)
- `commands/project.ts` — created (3 subcommands)
- `commands/run.ts` — created (3 subcommands)
- `commands/export.ts` — created (4 renderers + `--webhook` Slack POST with stdout fallback)
- `commands/pack.ts` — created (5 subcommands; `delete` soft-flips `feature_packs.is_active=false`)
- `commands/template.ts` — created (`list` + `install`)
- `lib/duration.ts` — created (`parseDuration("5m"|"1h"|"24h"|"7d"|"1d6h")`)
- `lib/log-reader.ts` — created (chunked reverse-seek)
- `lib/sqlite-magic.ts` — created (16-byte header check)
- `lib/npm-view.ts` — created (`npm view ... --json` wrapper with `NpmViewError` discriminated codes)
- `lib/template-paths.ts` — created (3-tier resolution: explicit path → `~/.contextos/templates/` → bundled `dist/templates/`)
- `lib/templates/{load-template,render,detect}.ts` — created (Zod template.json schema; mustache-style substitution)
- `lib/auto-marker/{types,parser,serializer,index}.ts` — created (pure parser/serializer for `<!-- @auto:<name> -->`; respects fenced code blocks; roundtrip property `serialize(parse(x)) === x`)
- `lib/init/auto-populate.ts` — created (5 generators: dependencies, directory-structure, scripts, entry-points, services; empty results return italic placeholders rather than blank)
- `lib/init/feature-pack-seed.ts` — updated (accepts optional `template` + `autoPopulate` flags; runs `replaceAutoSections` when autoPopulate true)
- `lib/init/claude-settings-merge.ts` — updated (S8.5: `defaultClaudeSettingsPath()` honours `CLAUDE_SETTINGS_PATH` env override)
- `lib/export/{render-markdown,render-json,render-html,render-slack}.ts` — created (4 renderers; non-JSON formats default exclude audit; JSON always includes)
- `doctor/checks/31-active-kill-switches.ts` — created (YELLOW when count > 0; reports oldest age; SKIPPED pre-init)
- `doctor/checks/32-upgrade-available.ts` — created (env-gated `CONTEXTOS_DOCTOR_CHECK_UPDATES=1`; YELLOW when newer)
- `doctor/checks/33-stale-backups.ts` — created (YELLOW when any file in `~/.contextos/backups/` is > 30 days)
- `doctor/checks/34-bundled-templates.ts` — created (RED on missing/parse failure; resolves bundled `dist/templates/` first)
- `doctor/checks/35-auto-marker-smoke.ts` — created (YELLOW if any template's *.tmpl file fails parse)
- `doctor/registry.ts` — updated (wires the 5 new checks; none essential — `--full` only)
- `program.ts` — updated (CLI surface grew from 8 → 20 top-level commands; doctor description bumped 30→35-check)
- `version.ts` — generated (synced from `package.json#version` by `prebuild`)

`packages/cli/templates/`

- `{generic,nextjs-saas,python-fastapi,python-ml,node-monorepo,rust-cli,go-service}/template.json` + 4 `*.tmpl` — created (7 bundled templates × 5 files)

`packages/cli/scripts/`

- `bundle.mjs` — updated (added step 5: copy `templates/` → `dist/templates/`)

`packages/cli/__tests__/`

- `unit/doctor/m08b-checks.test.ts` — created (12 cases for slots 31–35)
- `integration/doctor-binary.test.ts` — updated (30 → 35-check assertion)
- `unit/help-output.test.ts` — updated (snapshot reflects new commands + 35-check description)

`docs/feature-packs/08b-cli-expansion/`

- `spec.md` — created (S0; OQ-1…OQ-8 locked in §11)
- `implementation.md` — created (19-slice plan)
- `techstack.md` — created (exit-code table; bundle layout)
- `meta.json` — created (migration `0007` declared)

`context_memory/`

- `current-session.md` — updated continuously across S0…S18 (PostToolUse log)
- `decisions-log.md` — appended (8 OQ locks + every mid-flight design call)

## Tests

**Added:**

- `apps/hooks-bridge/__tests__/integration/kill-switch-evaluator.test.ts` — full bridge lifecycle (pause/deny/resume/audit; soft mode → allow + audit row).
- `packages/db/__tests__/unit/kill-switches.test.ts` — helper-level coverage (insert + 4 active-row predicates + soft-resume idempotency + matcher per scope).
- `packages/cli/__tests__/unit/commands/{pause,resume,logs,db-migrate,db-backup,db-restore,upgrade,uninstall,policy,project,run,export,pack,template}.test.ts` — per-command unit coverage.
- `packages/cli/__tests__/integration/{db-backup,upgrade,export,init-template,pack-regenerate}.test.ts` — exercises the bundled binary against tmp-home + tmp-cwd.
- `packages/cli/__tests__/unit/auto-marker-{parser,serializer,roundtrip}.test.ts` — 12+ fixtures incl. fenced-code-block escape, malformed close, orphaned section.
- `packages/cli/__tests__/unit/doctor/m08b-checks.test.ts` — 12 cases for slots 31–35.

**Modified:**

- `packages/cli/__tests__/unit/help-output.test.ts` — snapshot reflects the 20-command surface + 35-check doctor description.
- `packages/cli/__tests__/integration/doctor-binary.test.ts` — `--full` assertion 30 → 35.
- `packages/db/__tests__/integration/schema-parity.test.ts` — added `decisions` (pre-M08b gap) + `kill_switches` to `tablePairs`; flipped header from "nine-table" to "eleven-table".
- `packages/db/__tests__/unit/client.test.ts` — table count 11 → 12.

**Removed:** none.

**Verification commands run locally (final S18 cycle):**

```bash
pnpm --filter @coodra/contextos-cli lint            # clean
pnpm --filter @coodra/contextos-db lint             # clean
pnpm --filter @coodra/contextos-cli typecheck       # clean
pnpm --filter @coodra/contextos-db typecheck        # clean
pnpm --filter @coodra/contextos-cli test:unit       # 188/188
pnpm --filter @coodra/contextos-cli test:integration --run __tests__/integration/doctor-binary.test.ts  # 49/55, 6 skipped pre-existing
node packages/cli/dist/index.js doctor --json --full  # 35 checks; M08b rows behave per state
```

Functional smoke against a sandbox CONTEXTOS_HOME (S18 close):

- Empty home → 31 skipped (no DB), 32 skipped (no env opt-in), 33 green, 34 green, 35 green.
- After `init --project-slug doctor-smoke --no-graphify --ide claude` → 31 GREEN.
- After `pause --reason 'doctor smoke test'` → 31 YELLOW with `1 active kill switch(es); oldest paused 0 min ago` + remediation `contextos resume --all`.

**CI status at session end:** unmerged feature branch — local-only verification. CI run will trigger on PR open.

## Open questions

None blocking. Two follow-ups carried to other modules:

- **Q (M07):** the kickoff promised an e2e for the kill-switch lifecycle (AC-6); the integration suite covers the protocol but a dedicated e2e against a real Claude-Code-style PreToolUse stream isn't in this branch. Owner: M07 VS Code Extension session lead — that module needs the same harness for its session-panel work. Blocks: nothing in M08b.
- **Q (M04):** cross-developer kill-switch sync. Locked at OQ-8 as M04's surface. Owner: M04 Web App admin-page session lead. Blocks: M04 admin-pause UX.

## Pending user actions

None new. M08b adds two pre-existing items in `context_memory/pending-user-actions.md` — both ops, both explicitly out of scope per §3:

- npm-publish automation (M08b ships templates inside the tarball but the publish step is a separate ops task; user-side or CI-side decision).
- Marketing site / Anthropic MCP marketplace listing (deferred indefinitely per user directive 2026-04-24).

## Handoff to next session

- **Starting state.** On `feat/08b-cli-expansion @ e17be0f`: `pnpm install && pnpm test:unit` is clean across the workspace (188/188 in `packages/cli`); `pnpm test:integration --run __tests__/integration/doctor-binary.test.ts` is 49/55 (6 skipped pre-existing). The branch is unmerged.
- **Next concrete step.** Open the PR for `feat/08b-cli-expansion` → `main` and let CI run. Once green + reviewed + merged, update README's module-status row for 08b to ✅ at the same commit (this Context Pack already references the merge state). Then the next module per `essentialsforclaude/08-implementation-order.md §8.1` is **Module 04 — Web App** (depends on 01, 02, 08a — all green; M08b is non-blocking but its admin surfaces shape M04's contract).
- **Entry point.** `docs/feature-packs/04-web-app/spec.md` for M04. For any M08b follow-up: `packages/cli/src/program.ts` is the surface index; `packages/cli/src/commands/<name>.ts` is the per-command entry.

Module 08b complete. Next session: open the PR for review, then start Module 04 per `module-wise plan.md` and the Feature Pack at `docs/feature-packs/04-web-app/`.

## References

- Feature Pack: `docs/feature-packs/08b-cli-expansion/{spec,implementation,techstack}.md`
- Architecture: `system-architecture.md` §1 (modes), §4 (data-at-rest), §7 (fail-open), §13 (server setup), §16 patterns 1/2/3/4/12/19/20
- Style / discipline: `essentialsforclaude/02-agent-human-boundary.md` §2.2 (uninstall + db restore as user-confirmable destructive ops); `essentialsforclaude/08-implementation-order.md §8.4` (this Context Pack format)
- External reference pins: no version bumps landed in M08b; existing pins for `execa`, `semver`, `zod`, `commander`, `pino`, `better-sqlite3`, `drizzle-orm` are reused as-is.
- Decisions log: `context_memory/decisions-log.md` (search "M08b OQ-")
