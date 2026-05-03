# Current Session — 2026-05-03 (Module 08b — CLI Expansion: kickoff + S0)

## Goal

Build Module 08b (CLI Expansion) end-to-end on `feat/08b-cli-expansion`. 19 slices S0 → S19 per `docs/feature-packs/08b-cli-expansion/implementation.md`, one commit per slice. Strengthen `@coodra/contextos-cli` from "install + lifecycle" (the M08a scope) into a complete operational + admin surface that ships three orthogonal concerns together: (1) operational essentials (logs/migrate/backup/restore/upgrade/uninstall + pause/resume kill switches via the new `kill_switches` table); (2) admin surfaces (`policy/project/run/export`); (3) Feature Pack flexibility (7 bundled templates + `init --template/--mode` + `pack {new,list,show,regenerate,delete}` + `<!-- @auto -->` marker contract).

The single load-bearing AC: `contextos pause` writes a row that the hooks-bridge consults BEFORE the existing policy evaluator on every PreToolUse — hard mode denies, soft mode allows + audits. Local-only in M08b (cross-developer sync is M04's surface).

## Context loaded

- `docs/feature-packs/08b-cli-expansion/{spec.md,implementation.md,techstack.md,meta.json}` — kickoff triplet authored as untracked files; this S0 commit publishes them with the 8 OQs locked + migration number bumped 0006→0007 (Phase 4 Fix K already took 0006).
- `system-architecture.md` §1 (modes), §4 (data-at-rest — `kill_switches` fits §4.3 idempotency-key principle), §7 (fail-open — kill-switch evaluator inherits this), §13 (server setup — `pause/resume` is operational, not policy), §16 patterns 1/2/3/4/12/19/20.
- `essentialsforclaude/02-agent-human-boundary.md` §2.2 (uninstall, db restore are user-confirmable destructive ops).
- Recent prior work on `main`: Phase 4 Fixes A–L (default policy + matcher coverage, SessionEnd registration, auto-pack to filesystem, `query_decisions` tool, orphaned-run cleanup, `policy_rules` UNIQUE constraint, doctor lifecycle checks). The audit at `docs/audit/2026-05-03-product-audit.md` documents the post-Phase-3 state and informed Phase 4 Fix surface.
- `docs/feature-packs/08a-cli/` — every M08b command extends an M08a surface; package, exit codes, daemon manager, runtime-paths resolver, init pipeline, claude-settings-merge are reused verbatim.

## Last completed

**S0 in progress (this commit).** Drafts of spec/implementation/techstack/meta exist on disk; this commit publishes them with:
- §11 of `spec.md` flipped from "Open questions" to "Locked design decisions (signed off 2026-05-03)" — all 8 OQs locked per the spec author's recommendations (see §3.3 below).
- Migration number bumped 0006→0007 in spec.md (4 references), implementation.md (5 references), and meta.json (2 file globs). 0006 was claimed by Phase 4 Fix K (`policy_rules` UNIQUE-constraint cleanup, commit `92e37a6`).
- 9 new entries in `context_memory/decisions-log.md`: M08b kickoff overview + the 8 OQ-by-OQ lock entries.

Verified post-Phase-4 baseline before starting:
- `apps/hooks-bridge/src/handlers/pre-tool-use.ts` — Phase 4 Fix F matcher landed; `Write|Edit|MultiEdit|NotebookEdit|Bash` per-event regex via `claude-settings-merge.ts`.
- `apps/hooks-bridge/src/handlers/session-end.ts` — Pattern 20 auto-Context-Pack save fires fire-and-forget; Phase 4 Fix H materializes to `~/.contextos/packs/<runId>.md`.
- `apps/mcp-server/src/tools/index.ts` — 10 tools registered (ping, get_run_id, get_feature_pack, save_context_pack, search_packs_nl, record_decision, query_run_history, check_policy, query_codebase_graph, query_decisions); Fix I's `query_decisions` is the cross-session decisions read-path the audit flagged.

## Decisions locked at S0 sign-off (2026-05-03)

| OQ | Locked answer |
|---|---|
| 1 | Both modes available; default = `--mode hard` |
| 2 | Polymorphic `(scope text NOT NULL, target text)` schema |
| 3 | Default backup = single-file `.sqlite` (VACUUM INTO); `--include-logs` switches to tarball |
| 4 | Atomic restore + auto-backup-of-current; refuses if daemons running; no escape hatch |
| 5 | Uninstall preserves data + config + feature/context packs by default; `--purge` opts in to wipe |
| 6 | `run cancel` flips `runs.status` only; bridge keeps recording any post events |
| 7 | Non-JSON `export` formats exclude policy_decisions by default; `--include-audit` opts in |
| 8 | Kill switches are local-only in M08b; cross-developer sync is M04's surface |

Each is mirrored in `decisions-log.md` and referenced from the matching `### OQ-X` subsection of `spec.md §11`.

## Next action

**Begin S2 — hooks-bridge kill-switch evaluator wired into pre-tool-use chain.**

1. Author `apps/hooks-bridge/src/lib/kill-switch-evaluator.ts` exporting `createKillSwitchEvaluator(deps: { db: DbHandle; cacheMs?: number; clock?: () => Date }): { check(event): Promise<{ matched, decision } | null> }`. Pure async; fail-open on DB throw.
2. Modify `apps/hooks-bridge/src/handlers/pre-tool-use.ts` to consult the evaluator BEFORE the existing policy chain. Hard-mode match → return deny + `kill_switch_paused:<id>` reason; soft-mode match → return allow + record synthetic `policy_decisions` row with the same reason; no match → fall through to existing policy chain.
3. 5s in-process cache (much shorter than 60s policy cache) to keep pause/resume feeling instant; cache key is `projectId|null`.
4. 5 integration fixtures + 8 unit fixtures per implementation.md S2.
5. Extend `__tests__/e2e/full-session.test.ts` with a kill-switch-deny path; verify the audit row lands.
6. Translate decision in `apps/hooks-bridge/src/lib/translate-decision.ts` so the deny surfaces clearly to Claude Code's permission prompt.

S1 closeout (this commit): `kill_switches` table + migration `0007_*` + 5 helpers shipped on `feat/08b-cli-expansion`. Schema-parity test now covers `decisions` + `kill_switches` (decisions was a pre-M08b gap closed in passing). 9 integration fixtures green; 54/54 unit tests green; biome lint clean; typecheck clean (pre-existing `schedule-audit-write-with-sync.test.ts(66,23)` `JSON.parse(sync?.payload)` type error fixed in passing — was blocking `pnpm --filter @coodra/contextos-db typecheck` on `main`).

## Log (append-only per PostToolUse)

- [HH:mm] verified post-Phase-4 hooks/tools state (matcher fix F, SessionEnd registration G, auto-pack-to-disk H, query_decisions tool I)
- [HH:mm] created branch `feat/08b-cli-expansion` off `main` (HEAD `d4cd2f8`)
- [HH:mm] created 20 TaskCreate tasks for S0–S19 + closeout
- [HH:mm] bumped migration number 0006→0007 across spec.md/implementation.md/meta.json (Phase 4 Fix K already took 0006 on `main`)
- [HH:mm] flipped spec.md §11 Open questions → Locked design decisions; added Decision/Why/Constrains block to each of OQ-1..OQ-8
- [HH:mm] archived prior `current-session.md` (M04a state) to `sessions/2026-04-28-module-04a-sync-daemon.md`
- [HH:mm] wrote fresh `current-session.md` for M08b
- [HH:mm] S0 committed (`ee8ac9c`): kickoff spec + locked OQ answers
- [HH:mm] S1 — added `killSwitches` table to `packages/db/src/schema/{sqlite,postgres}.ts` (polymorphic `(scope, target)` shape per OQ-2)
- [HH:mm] S1 — generated migrations `0007_thick_nightmare.sql` (sqlite) and `0007_bitter_miek.sql` (postgres) via `pnpm --filter @coodra/contextos-db db:generate`; no hand-written preserve blocks needed (clean delta)
- [HH:mm] S1 — wrote `packages/db/src/kill-switches.ts` (5 helpers: `listActiveKillSwitches`, `insertKillSwitch`, `softResumeKillSwitch`, `softResumeAllKillSwitches`, `findKillSwitchMatchingEvent`); re-exports from `packages/db/src/index.ts`
- [HH:mm] S1 — schema-parity test extended to include `kill_switches` AND `decisions` (decisions was a pre-M08b parity-test gap; closed in passing). Heading flipped from "nine-table schema" to "eleven-table schema"
- [HH:mm] S1 — `client.test.ts` table count expectation updated 11→12
- [HH:mm] S1 — fixed pre-existing `schedule-audit-write-with-sync.test.ts(66,23)` `JSON.parse(sync?.payload)` type error blocking `pnpm typecheck` on `main`
- [HH:mm] S1 — wrote `__tests__/integration/kill-switches.test.ts` with 9 fixtures (7 spec + 2 bonus for invariant validation + paused_at ordering); first run failed Fixture 7 (re-resume idempotency) because SQLite `.update()` doesn't return rows — fixed by using `RunResult.changes` to detect zero-row updates
- [HH:mm] S1 — appended `External api and library reference.md` Drizzle subsection: `kill_switches` polymorphic-scope pattern + soft-resume + 5s bridge cache TTL + local-only-in-M08b note
- [HH:mm] S1 — typecheck + lint + 54/54 unit + 9/9 integration green; ready to commit
