# Module 08b — CLI Expansion (`@coodra/cli` operational + admin + Feature-Pack flexibility) — Spec

> **Status:** planned (2026-05-02). No slice has landed yet. This spec is the kickoff document; open questions in §11 must be resolved before S1 starts.
> **Depends on:** 01 Foundation (DB), 02 MCP Server (`feature_packs` store, manifest), 03 Hooks Bridge (pre-tool evaluator chain — kill-switch hook attaches here), 08a CLI (every M08b command extends an M08a surface; the package, exit codes, daemon manager, runtime-paths resolver, init pipeline, claude-settings-merge are reused verbatim).
> **Blocks:** No module is hard-blocked on M08b. M04 Web App will *prefer* M08b's structured admin surfaces over hand-coded SQL admin panels but does not require them; M07 VS Code Extension benefits from `coodra logs` + `coodra run list` if it ships the per-session log panel, but can ship without.
> **Aware of:** M04 Web App will eventually expose admin surfaces parallel to `policy/project/run/export` — M08b's CLI shapes ARE the contract those Web App pages render against. M05 NL Assembly will eventually own `feature_pack_section_usage` (deliberately deferred from M08b — see §6).
> **Source of truth:** `system-architecture.md` §1 (modes), §4 (data-at-rest — kill_switches table fits the §4.3 idempotency-key principle), §7 (fail-open — kill-switch evaluator inherits this), §13 (server setup — `pause/resume` is operational, not policy), §16 patterns 1/2/3/4/12/19/20, `essentialsforclaude/02-agent-human-boundary.md` §2.2 (uninstall, db restore are user-confirmable destructive ops), `docs/feature-packs/08a-cli/` (every command).

## 1. What M08b is

M08b strengthens `@coodra/cli` from "install + lifecycle" (the M08a scope) into a **complete operational + admin surface** for Coodra. Three orthogonal concerns ship together because each one is too small for its own module and they share the same packaging, exit-code contract, daemon manager, runtime-paths resolver, and initialisation pipeline.

The three concerns:

1. **Operational essentials** (S1–S8 + S18 doctor extensions) — what an operator needs to keep Coodra running on a developer's machine over weeks: tail logs, apply schema migrations after a CLI upgrade, back up and restore the local SQLite primary store, upgrade the package + its on-disk artifacts in sync, uninstall cleanly, and pause/resume enforcement without flipping the database by hand. Pause/resume introduces the new `kill_switches` table (the *only* schema delta in M08b — migration 0007; the 0006 slot is already occupied by the Phase 4 Fix K `policy_rules` UNIQUE-constraint cleanup that landed on `main` 2026-05-03).
2. **Admin surfaces** (S9–S12) — `policy {list,show,add,enable,disable}`, `project {list,show,reset}`, `run {list,show,cancel}`, `export <runId> --format markdown|json|html|slack`. Today the only way to see or change policy rules, project rows, or run state is to open the SQLite database in the user's editor of choice; M08b makes those surfaces first-class.
3. **Feature Pack flexibility** (S13–S17) — a templates library shipped inside the CLI bundle (seven starter templates: `generic`, `node-monorepo`, `nextjs-saas`, `python-ml`, `python-fastapi`, `rust-cli`, `go-service`); `init --template <name|path>`; `init --mode minimal|default|auto` (auto detects the project's shape via heuristics and selects the right template); `pack {new,list,show,regenerate,delete}`; `template {list,install}`. The new **`<!-- @auto:<section> -->` marker convention** lets `pack regenerate` overwrite generated sections (dependencies, directory structure, scripts) without disturbing user-edited prose.

M08b is **non-blocking for every other module**. Every other module CAN ship without M08b's commands; M08b makes operating Coodra pleasant rather than possible.

## 2. Acceptance criteria

A commit on `feat/08b-cli-expansion` is "complete" when **every** item below holds on a clean checkout:

1. `pnpm install` clean, no peer-dependency warnings escalated to errors.
2. `pnpm lint` — zero Biome findings across new code paths under `packages/cli/src/{commands,lib}/**` + `packages/cli/templates/**` + `packages/db/src/kill-switches.ts` + `apps/hooks-bridge/src/lib/kill-switch-evaluator.ts`.
3. `pnpm typecheck` — `tsc --noEmit` clean across every workspace package.
4. `pnpm test:unit` — every unit test passes. ≥ 80% line coverage on touched files per `essentialsforclaude/06-testing.md §6.4`.
5. `pnpm test:integration` — the new integration tests pass: (a) hooks-bridge pre-tool chain consults `kill_switches` BEFORE the policy evaluator and short-circuits with the configured mode, (b) `db backup`/`db restore` produces a byte-identical SQLite roundtrip, (c) `policy add` creates a row that the running MCP server's `check_policy` tool sees on the next call (no restart needed), (d) `pack regenerate` preserves user-edited content outside `<!-- @auto -->` markers and replaces inner content within them, (e) `init --template python-fastapi` produces a feature-pack folder whose `meta.json` validates and whose `spec.md` contains the template's content.
6. `pnpm test:e2e` — extended e2e adds **kill-switch end-to-end:** `coodra pause --reason "demo"` → start a session → bridge denies (or soft-allows depending on mode) the next PreToolUse → audit row in `kill_switches` is observable via `coodra logs hooks-bridge` → `coodra resume` clears the switch → next PreToolUse evaluates against `policy_rules` again. Locks the protocol described in §3.
7. **Schema delta:** migration `0007_*` adds the `kill_switches` table on both SQLite and Postgres dialects. Zero changes to existing tables. The migration's hand-written preserve-blocks (if any) are SHA-locked in `packages/db/migrations.lock.json` per the existing convention. (0006 is reserved by Phase 4 Fix K — `policy_rules` UNIQUE-constraint cleanup, already merged.)
8. **Backwards compatibility:** every M08a command (`init`, `start`, `stop`, `status`, `doctor`, `cloud-migrate`, `team login`, `team logout`) keeps its current flag set, exit codes, and human-readable output verbatim. M08b extends but never breaks. The exit-code table in `techstack.md` adds two codes (5 = kill-switch refusal, 6 = backup/restore precondition) and reserves codes 7–9 for follow-ups; codes 0–4 + 99 are unchanged from M08a.
9. **Templates ship inside the npm tarball.** `packages/cli/templates/{generic,node-monorepo,nextjs-saas,python-ml,python-fastapi,rust-cli,go-service}/` is bundled into `dist/templates/**` by `scripts/bundle.mjs`. `npm pack --dry-run` lists every template file; the file-list test from M08a S9 expands to assert the templates are present.
10. **Auto-marker contract** is documented in `docs/feature-packs/08b-cli-expansion/spec.md §8` (this file) AND covered by a dedicated parser unit test (`packages/cli/__tests__/unit/auto-marker-parser.test.ts`) with at least 12 fixtures: well-formed single section, well-formed multiple sections, malformed missing close tag, malformed nested marker, content with `<!-- @auto:foo -->` literal inside a fenced code block (must NOT be parsed as a real marker), orphaned section after template change, etc.
11. **`coodra pause` is reversible.** Every kill-switch row is soft-resumed (`resumed_at` set, `resumed_by_session_id` set) — never hard-deleted. A `kill_switches` row that has been resumed remains in the table as audit history. The active-switch query is `WHERE resumed_at IS NULL AND (expires_at IS NULL OR expires_at > now())`.
12. **`coodra uninstall` is conservative by default.** Without `--purge`, it removes the `__coodra__` matcher entries from `~/.claude/settings.json`, the daemon-manager units, and the project-level `.mcp.json` `coodra` entry — but preserves `~/.coodra/data.db`, `~/.coodra/config.json`, every `docs/feature-packs/<slug>/` folder, and every `docs/context-packs/` file. `--purge` adds removal of `~/.coodra/` and prints (does not run) the `npm uninstall -g @coodra/cli` command for the user. See §11 OQ-5.
13. **`coodra export` is read-only.** No mutation of any table, no file write outside the path given by `--out` (or stdout if omitted). Five integration tests cover the four formats × happy-path + the "include audit" toggle.
14. **No new external HTTP outbound from the CLI** other than (a) the existing optional Graphify subprocess from M08a, (b) `coodra upgrade` which calls `npm view @coodra/cli version` (one HTTPS GET to the npm registry), (c) `coodra export --format slack --webhook <url>` if the user passes a webhook URL (POST to that URL only). All three are explicit user actions; none happen automatically.
15. **Doctor extensions:** S18 adds five new check rows to the registry from M08a §4.5: (21) active kill-switch count + active-since timestamps, (22) `npm view` returns a version newer than installed (`upgrade-available` YELLOW only when checked manually with `--check-updates`), (23) `~/.coodra/data.db.bak.<timestamp>` files older than 30 days exist + total size (operator hygiene reminder), (24) bundled templates directory matches expected manifest (catches a corrupted install), (25) auto-marker parser-grammar smoke (every shipped template's `*.tmpl` round-trips through the parser without warnings).
16. **Module 08b Context Pack** saved to `docs/context-packs/YYYY-MM-DD-module-08b-cli-expansion.md` per `essentialsforclaude/08-implementation-order.md §8.4`.

## 3. Non-goals

These are deliberately excluded from M08b and are **not** stubbed (per `01-development-discipline.md §1.1`):

- **No marketing site, no landing page, no Anthropic MCP marketplace listing.** Same posture as M08a. Distribution-channel work remains in `pending-user-actions.md`.
- **No npm-publish automation.** M08a's S9 file-list test extends to cover the new templates dir, but the publish step is still a separate ops task.
- **No cross-agent shared state surface.** Per the user directive accompanying this kickoff: cross-agent shared state surfacing lands in **M04 Web App** (admin can see "this dev's agent edited X 3 minutes ago" in a team) plus a hooks-bridge enrichment that fans out events. M08b's `run list` shows runs the local CLI sees on the local SQLite — local-only.
- **No Context Pack quality signals.** "Quality" (which sections of a pack the agent referenced, which decisions cited it, did the pack predict the actual scope) requires NL Assembly hooks. **Lands in M05.** M08b's `pack show` reports last-modified, file size, and detected language — never quality.
- **No Web UI commands.** No `coodra web open`, no `coodra dashboard`. The Web App is M04's job; M08b stays terminal-only.
- **No `feature_pack_section_usage` table.** Same reason as quality signals: needs M05 to populate. Schema delta in M08b is `kill_switches` only.
- **No `template publish` (push-to-registry) command.** `template install <path>` accepts a local path or a `git+https://...` URL (the latter via a future S17 follow-up — see implementation.md S17). A real registry is post-launch.
- **No team-mode kill-switch sync.** A kill switch flipped on developer A's machine does NOT propagate to developer B. Synced kill-switches are an M04 admin-surface concern (admin flips a global switch from the dashboard, the cloud-sync path replicates to every connected hooks-bridge). M08b is local-only. See §11 OQ-8.
- **No `pack regenerate` LLM enrichment.** M08b's `pack regenerate` is pure-heuristic: it re-runs the template, refreshes auto-marker sections from project detection, and writes the file. LLM-driven enrichment ("rewrite this section with the latest project conventions") is M05.
- **No CRUD on `decisions` or `context_packs` from the CLI.** Both tables are append-only by ADR-007. M08b reads them (`run show`, `export`) but never deletes or updates rows. `pack delete <slug>` deletes the FILE, not any DB rows.
- **No GUI installer, no `.dmg`, no `.exe`.** Same as M08a.
- **No telemetry.** `coodra upgrade` is the ONE outbound network call M08b adds (to `registry.npmjs.org`). It happens only when the user runs `upgrade`, never automatically.

## 4. Commands — the surface

Three slice groups separated for legibility. Every command:
- Is idempotent where the operation has a single intended end-state.
- Prints human output by default and JSON output behind `--json` (where applicable).
- Exits non-zero on any failure that requires user action; never `process.exit(1)` silently.
- Logs to `~/.coodra/logs/<command>-YYYY-MM-DD.log` in addition to stderr (M08a §4 carry-over).
- Never writes secrets to logs.
- Honours the M08a exit-code contract; M08b adds codes 5 (kill-switch refusal) and 6 (backup/restore precondition).

### 4.1 Operational essentials

| Command | Purpose | Exit codes |
|---|---|---|
| `coodra logs <service> [--follow] [--lines <N>] [--since <ISO\|relative>]` | Tail or print recent lines from `~/.coodra/logs/<service>.log`. `<service>` ∈ `{mcp-server, hooks-bridge, sync-daemon}`. Pure file-read + optional `tail -f` semantics; no DB calls. | 0 ok / 1 unknown service / 2 log file absent |
| `coodra db migrate [--dry-run] [--json]` | Apply pending Drizzle migrations to `~/.coodra/data.db`. Idempotent — re-run is a no-op when `__drizzle_migrations` is at head. Refuses to run while daemons are running unless `--with-daemons-running` is set (writers are open; mid-migration is unsafe). | 0 ok / 1 daemons running / 6 lock-file held by another migrator |
| `coodra db backup [--out <path>] [--include-logs] [--json]` | `VACUUM INTO <out>` against the live SQLite (concurrent with running daemons — SQLite WAL allows this). Default `<out>` = `~/.coodra/backups/data.db.bak.<ISO-timestamp>`. `--include-logs` produces a `.tar.gz` containing `data.db.bak` + `logs/` + `config.json` (mode-0600 preserved). See §11 OQ-3. | 0 ok / 1 destination unwritable / 6 disk-full |
| `coodra db restore <path> [--no-auto-backup] [--force] [--json]` | Replace `~/.coodra/data.db` with the file at `<path>`. Refuses if daemons are running. By default takes an automatic backup of the current DB before restore (`<path-of-current>.pre-restore-<ISO>`). `--force` skips the confirmation prompt. See §11 OQ-4. | 0 ok / 1 daemons running / 2 source missing or invalid / 6 backup-of-current failed |
| `coodra upgrade [--check-only] [--no-restart] [--json]` | Calls `npm view @coodra/cli version` (one HTTPS GET) and compares with the installed version. If a newer version is available: print the install command for the user to run (`npm i -g @coodra/cli@<v>`); the CLI **does not self-update**. After the user has installed, re-running `coodra upgrade` notices the version match, runs `db migrate`, and (unless `--no-restart`) cycles `start`/`stop` so the daemon manager re-launches with the new binaries. | 0 ok / 1 npm view failed / 2 user action required (new version available) |
| `coodra uninstall [--purge] [--keep-data] [--keep-config] [--force] [--json]` | Removes `__coodra__` matcher entries from `~/.claude/settings.json`, daemon-manager units (launchd/systemd), the `<cwd>/.mcp.json` `coodra` server entry. Default-safe: `~/.coodra/data.db`, `~/.coodra/config.json`, `docs/feature-packs/`, `docs/context-packs/` are preserved. `--purge` removes `~/.coodra/` and prints the `npm uninstall -g @coodra/cli` command for the user. See §11 OQ-5. | 0 ok / 1 partial removal / 2 user confirmation declined |
| `coodra pause [--scope <s>] [--target <t>] [--mode <m>] [--reason <r>] [--expires-in <duration>]` | Inserts a row into `kill_switches`. `--scope` ∈ `{global, project, tool, agent_type}` (default `global`). `--target` is the scope's value (e.g., `tool=Bash`); ignored when `--scope=global`. `--mode` ∈ `{hard, soft}`; `hard` = bridge denies, `soft` = bridge allows but records `paused` reason in `policy_decisions`. Default mode is OQ-1. `--expires-in` accepts `5m`, `1h`, `24h`, `7d` (none = persists until `resume`). | 0 ok / 1 invalid scope or target / 5 already-paused at this scope (idempotent — returns existing id) |
| `coodra resume [--id <switch-id>] [--all] [--scope <s>] [--target <t>] [--json]` | Soft-resumes (sets `resumed_at` + `resumed_by_session_id`) one or more active kill switches. `--id` resumes the named switch; `--all` resumes every active switch; `--scope/--target` resumes every active switch matching the filter. | 0 ok / 1 no matching active switch |

### 4.2 Admin surfaces

| Command | Purpose | Exit codes |
|---|---|---|
| `coodra policy list [--project <slug>] [--json]` | Print every Policy + Rule, grouped by project, ordered by priority. Replaces the `sqlite3 ~/.coodra/data.db "SELECT * FROM policies …"` workflow. | 0 ok |
| `coodra policy show <policyId\|name> [--json]` | Print one Policy + every Rule attached. Includes the `__default__` rules from `ensureDefaultPolicy`. | 0 ok / 1 not found |
| `coodra policy add --project <slug> --tool <name> --decision <allow\|deny\|ask> [--event-type <pre\|post>] [--path-glob <glob>] [--agent-type <type>] [--priority <n>] [--reason <r>]` | Insert a new rule into the project's `__default__` policy (or create the policy if absent — same shape `ensureDefaultPolicy` produces). Priority defaults to `max(existing) + 10`. | 0 ok / 1 invalid input / 2 project not registered |
| `coodra policy enable <policyId\|name>` | Set `policies.is_active = true`. Idempotent. | 0 ok / 1 not found |
| `coodra policy disable <policyId\|name>` | Set `policies.is_active = false`. The policy stays in the DB; rules are still queryable but the evaluator skips an inactive policy entirely. | 0 ok / 1 not found |
| `coodra project list [--json]` | Print every row in `projects`, including `__global__`. Shows last-run timestamp + total run count from a join. | 0 ok |
| `coodra project show <slug\|id> [--json]` | Prints the project + its policies (if any) + last 5 runs + run-count breakdown by status. | 0 ok / 1 not found |
| `coodra project reset <slug\|id> [--keep-policies] [--force] [--json]` | **Destructive.** Deletes every `runs`, `run_events`, `policy_decisions`, `decisions`, `context_packs` row for the project. Preserves `policies` + `policy_rules` unless `--keep-policies=false`. Refuses without `--force`. | 0 ok / 1 not found / 2 confirmation declined |
| `coodra run list [--project <slug>] [--status <s>] [--limit <n>] [--json]` | Print the last N runs for a project (or all projects), filterable by status. Shows runId, sessionId, agent_type, status, started_at, decision count. | 0 ok |
| `coodra run show <runId> [--json]` | Print one run + every `run_events` row + every `decisions` row + every `policy_decisions` row + the `context_packs` row (if any). The full per-run audit trail. | 0 ok / 1 not found |
| `coodra run cancel <runId> [--force] [--json]` | Sets `runs.status = 'cancelled'` + `runs.ended_at = now()`. Per §11 OQ-6, the bridge does NOT block future events for a cancelled run; cancellation is informational. | 0 ok / 1 not found / 2 already-terminal-state |
| `coodra export <runId> --format <markdown\|json\|html\|slack> [--out <path>] [--include-audit] [--webhook <url>]` | Read-only assembler. Reads `runs`, `run_events`, `decisions`, `policy_decisions` (only when `--include-audit` for non-json formats), `context_packs` for the run, and emits the chosen format. `--webhook` POSTs the slack-format payload to a Slack incoming-webhook URL. See §11 OQ-7. | 0 ok / 1 not found / 2 webhook POST failed |

### 4.3 Feature Pack flexibility

| Command | Purpose | Exit codes |
|---|---|---|
| `coodra init` (extended) `[--template <name\|path>] [--mode <minimal\|default\|auto>]` | M08a's `init` extended with two new flags. `--template <name>` selects a bundled template (`generic`, `node-monorepo`, `nextjs-saas`, `python-ml`, `python-fastapi`, `rust-cli`, `go-service`). `--template <path>` accepts a local directory matching the template-folder layout. `--mode minimal` = M08a's current behavior (`spec.md` skeleton, no auto sections). `--mode default` = M08a's behavior + the `__default__` policy (already on by `ensureDefaultPolicy`). `--mode auto` = scans the project, picks a template via the detection rules in each template's `template.json`, populates `<!-- @auto -->` sections from project shape (deps from `package.json`, scripts, directory tree). All three modes seed all four files (spec, implementation, techstack, meta) — M08a's Phase-3 Fix C invariant. | 0 ok / 1 detection-failed / 2 template not found / 3 path collision (use `--force`) |
| `coodra pack new <slug> [--template <name\|path>] [--parent <slug>] [--mode <minimal\|default\|auto>]` | Create a new feature pack at `docs/feature-packs/<slug>/` with the four-file layout. `--parent <slug>` sets `meta.json::parentSlug` for inheritance per `system-architecture.md §16` pattern 9. Registers a row in `feature_packs` (slug + checksum + isActive=true) so MCP search finds it immediately. | 0 ok / 1 slug already exists / 2 parent slug not found / 3 path collision |
| `coodra pack list [--json]` | List every directory under `docs/feature-packs/`. For each: slug, parentSlug, isActive (from DB), file presence (spec/implementation/techstack/meta), last-modified. Pure read; no DB writes. | 0 ok |
| `coodra pack show <slug> [--json]` | Print the pack's `meta.json` + the first 2KB of each markdown file + last-modified + file size. Detected language summary. Auto-section roster (which `<!-- @auto:* -->` sections exist in each file). | 0 ok / 1 not found |
| `coodra pack regenerate <slug> [--mode <minimal\|default\|auto>] [--dry-run] [--force]` | Rerun the pack's chosen template against the project's current shape, refreshing `<!-- @auto:* -->` sections in all four files; everything outside auto markers is preserved verbatim. `--dry-run` prints the unified diff. Orphaned auto sections (template no longer produces them) get a `(orphaned by template <name>)` marker comment. New auto sections (template added them) are appended at file end under a `## Auto-generated` heading. | 0 ok / 1 pack not found / 2 chosen template not found / 3 parser error in existing file |
| `coodra pack delete <slug> [--force]` | Delete the `docs/feature-packs/<slug>/` directory. Also marks the `feature_packs` row `is_active=false` (does not delete — M02 ADR-007 append-only spirit). Refuses without `--force`. | 0 ok / 1 not found / 2 confirmation declined |
| `coodra template list [--json]` | List bundled templates + every directory under `~/.coodra/templates/` (user-installed). Each row: name, source (`bundled` \| `user`), version (from `template.json`), supported languages, detection rules summary. | 0 ok |
| `coodra template install <path> [--name <override>] [--force]` | Copy a local directory into `~/.coodra/templates/<name>/` for re-use. Refuses to overwrite existing user templates without `--force`. The bundled templates cannot be overwritten. `<path>` must contain a valid `template.json` + the four `*.tmpl` files. | 0 ok / 1 invalid template / 2 name collision |

## 5. The "first 5 minutes" — the experience this spec is buying

Two new flows:

```
$ coodra init --template nextjs-saas --mode auto
✓ Detected project: TypeScript Next.js 15 at /Users/you/work/myapp
✓ Selected template: nextjs-saas (matched next.config.ts + next dep)
✓ Auto-populated:
    docs/feature-packs/myapp/spec.md          (4 auto sections)
    docs/feature-packs/myapp/implementation.md (3 auto sections)
    docs/feature-packs/myapp/techstack.md     (5 auto sections — deps from package.json)
✓ Wrote .mcp.json, .coodra.json, ~/.claude/settings.json
✓ Seeded default policy (deny .env / .git/** / node_modules/** writes; ask before Bash)

Coodra is ready.
```

```
$ coodra pause --scope tool --target Bash --reason "demoing without bash" --expires-in 1h
✓ Paused tool=Bash for 1h (id: ks_a1b2c3...). Until 2026-05-02T18:30:00Z.
  Resume: coodra resume --id ks_a1b2c3...

[user does the demo, runs out, comes back]

$ coodra resume --all
✓ Resumed 1 active switch(es).
```

A user who has never read the M08b docs can complete both. That is the bar.

## 6. Schema deltas

M08b adds **one new table** (`kill_switches`) and **zero changes** to existing tables. Migration `0007_*` adds the table on both SQLite and Postgres dialects. (0006 was claimed by the Phase 4 Fix K `policy_rules` UNIQUE-constraint cleanup that landed on `main` 2026-05-03 — see commit `92e37a6`.)

```ts
// packages/db/src/schema/sqlite.ts (new export — same shape on postgres.ts)
export const killSwitches = sqliteTable(
  'kill_switches',
  {
    id: text('id').primaryKey(),
    // 'global' | 'project' | 'tool' | 'agent_type' (extension via new enum value, no migration needed)
    scope: text('scope').notNull(),
    // null when scope='global'; projectId | toolName | agentType for the others.
    target: text('target'),
    // 'hard' = bridge denies; 'soft' = bridge allows but records `paused` reason in policy_decisions.
    mode: text('mode').notNull().default('hard'),
    reason: text('reason').notNull(),
    pausedAt: integer('paused_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    // null when CLI-initiated (not running in a session); set when the bridge ever flips a switch programmatically (post-M08b).
    pausedBySessionId: text('paused_by_session_id'),
    // null = no auto-expiry; bridge query treats `expires_at < now()` as already-resumed.
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    // null = active; set when `coodra resume` flips it. Audit history preserved (soft delete).
    resumedAt: integer('resumed_at', { mode: 'timestamp' }),
    resumedBySessionId: text('resumed_by_session_id'),
  },
  (t) => [
    // Active-switch lookup is the bridge's hot path (~150 ms budget per pre-tool-use).
    // resumedAt IS NULL filters audit history; (scope,target) drives the per-event match.
    index('kill_switches_active_idx').on(t.resumedAt, t.scope, t.target),
  ],
);
```

Decision-rationale for the polymorphic `(scope, target)` shape vs separate nullable columns: see §11 OQ-2.

`feature_pack_section_usage` was considered for M08b and **rejected**. The table tracks which sections of a feature pack the agent's session actually referenced; populating it requires NL Assembly hooks (M05) to detect section references in agent output. Adding the table without a populator would create an unused schema delta that must later be revisited — a one-shot migration in M05 is cleaner. M08b does not block the eventual table.

The migration is hand-runnable via `pnpm --filter @coodra/db db:generate`; if a hand-edited preserve block is needed (none anticipated for this delta) it gets sha-locked in `migrations.lock.json` per the existing pattern.

## 7. Templates library — directory layout

Bundled templates live under `packages/cli/templates/<name>/`:

```
packages/cli/templates/
  generic/
    template.json              # name, description, detect rules, autoSections list
    spec.md.tmpl               # mustache-style {{slug}} substitution; <!-- @auto:* --> markers
    implementation.md.tmpl
    techstack.md.tmpl
    meta.json.tmpl             # JSON file with substitutions
  node-monorepo/
  nextjs-saas/
  python-ml/
  python-fastapi/
  rust-cli/
  go-service/
```

`scripts/bundle.mjs` copies `packages/cli/templates/**` into `dist/templates/**` so the published tarball ships them. The runtime resolver `lib/template-paths.ts` (new in S13, mirrors `runtime-paths.ts` from M08a) resolves a template name to its on-disk directory, preferring user templates (`~/.coodra/templates/<name>/`) over bundled.

`template.json` shape:

```json
{
  "name": "nextjs-saas",
  "description": "Next.js 15 + React 19 SaaS app — Clerk auth, Postgres via Drizzle, Tailwind",
  "version": "1.0.0",
  "languages": ["typescript"],
  "detect": {
    "files": ["next.config.ts", "next.config.js", "next.config.mjs"],
    "packageJsonDeps": ["next"]
  },
  "autoSections": ["dependencies", "directory-structure", "scripts", "entry-points"]
}
```

**Substitution syntax:** mustache-style `{{slug}}`, `{{date}}`, `{{detectedLanguages}}`, `{{detectedDeps}}`. Hand-rolled string `.replace()` — no template engine dependency. The set of recognised placeholders is fixed and listed in `lib/templates/render.ts`.

**Detection rules:** `init --mode auto` walks templates in this order:
1. User templates in `~/.coodra/templates/*` (alphabetical).
2. Bundled templates in this declaration order: `nextjs-saas` → `python-fastapi` → `python-ml` → `node-monorepo` → `rust-cli` → `go-service` → `generic`.
3. First match wins. `generic` is the always-applicable fallback.

A template matches when **at least one** of:
- Any file in `detect.files` exists at the project root.
- Any `package.json` dep matches `detect.packageJsonDeps`.

## 8. Auto-marker contract

The `<!-- @auto:<section> -->` ... `<!-- /@auto -->` convention is the load-bearing piece for `pack regenerate` to work without destroying user-edited content.

### 8.1 Grammar

```
auto-section := open-tag inner-content close-tag
open-tag     := "<!-- @auto:" section-name " -->"
close-tag    := "<!-- /@auto -->"
section-name := [a-z0-9][a-z0-9-]{0,63}
inner-content := any markdown EXCEPT another open-tag (nesting is forbidden)
```

Whitespace inside the tag is normalized to a single space. Both tags must be on their own line (no inline auto sections in M08b).

### 8.2 Parser semantics

- Sections are matched by `section-name`. Two sections with the same name in one file is a parser error (S14 unit test fixture).
- An open-tag without a matching close-tag is a parser error.
- A close-tag without a preceding open-tag is a parser error.
- Nested open-tag is a parser error.
- A literal `<!-- @auto:foo -->` inside a fenced code block (\`\`\`) is **not** parsed as a marker — the parser respects standard markdown fence semantics. (S14 fixture #5.)
- Everything outside auto sections is **user-edited prose** and `pack regenerate` MUST NOT touch it.

### 8.3 Regeneration semantics

`pack regenerate <slug>` does, in order:

1. Read all four files in `docs/feature-packs/<slug>/`.
2. Parse each file's auto-section roster.
3. Resolve the template (from `meta.json::template` if present, else default to the slug's currently-rendered template by re-detection).
4. Render the template's auto-section bodies against the current project state.
5. For each existing auto section in the on-disk file: replace inner content with the freshly-rendered body. Open-tag and close-tag are unchanged.
6. For each auto section the template produces that does NOT exist in the on-disk file: append at file end under `## Auto-generated (<date>)` heading + the open/close tag pair.
7. For each auto section in the on-disk file that the template no longer produces: leave the section as-is, AND insert a `<!-- @auto:<name> (orphaned by template '<name>' as of <date>) -->` comment line BEFORE the open-tag. Subsequent regenerations leave orphaned sections alone.
8. Write the file via temp-file + rename (atomic).

### 8.4 What an `<!-- @auto -->` section looks like in the wild

```markdown
## 4. Pinned dependencies (and why)

<!-- @auto:dependencies -->

| Library | Version | Purpose |
|---|---|---|
| `next` | `^15.0.0` | Framework — App Router, Server Components |
| `@clerk/nextjs` | `^5.0.0` | Auth |
| `drizzle-orm` | `^0.45.2` | Postgres ORM |

<!-- /@auto -->

The dependency choices above are *committed* — replacing them is an architecture
decision, not a config tweak. Document the reason in `decisions-log.md` first.
```

The text after the close tag is user prose. `pack regenerate` will refresh the table inside the markers; the prose below is left alone. The user can move the prose, edit it, delete it — all preserved across regenerations.

## 9. Failure modes and fail-open posture

| Surface | If broken | Behaviour |
|---|---|---|
| Kill-switch table read at pre-tool-use | DB throws, breaker open, query timeout | **Fail-open** per §7. Bridge proceeds to the policy evaluator. Logs at WARN with `kill_switch_check_unavailable`. The policy evaluator is the second-line defense. Tested under DB-injected failure (S2 unit test). |
| `db migrate` mid-application | Migration step throws, data.db SHM/WAL corrupt | Drizzle's transaction-wrapped migrations roll back to pre-step state. CLI surfaces the error verbatim + suggests `db restore` from the most recent backup. No partial-state corruption. |
| `db backup` during a write storm | SQLite reports `SQLITE_BUSY` | Cockatiel-style retry with `[100ms, 250ms, 1s]` backoff. If still busy after 3 attempts, fails with exit 6 + remediation "wait for write activity to subside". |
| `db restore` while daemons running | data.db open by mcp-server / hooks-bridge | Refuses with exit 1 + "run `coodra stop` first". `--force` does NOT override; daemons-open + restore = silent corruption is not a tradeoff. |
| `upgrade` during npm registry outage | `npm view` 5xx | Exits 1, prints registry response. No fallback ("we have a list of versions cached locally" would be Coodra-as-package-registry, out of scope). Re-run later. |
| `pack regenerate` with malformed existing markers | parser throws | Exits 3, points at the line + column of the parse error, suggests `pack show` to inspect. Does NOT touch the file. |
| `export --webhook <url>` POST fails | network error | Exits 2, prints the format payload to stdout so the user can paste manually. Backup behavior — no data lost. |

The only **intentional block** in M08b is a hard kill switch matching the request. Every other error path either retries, falls open, or exits with structured remediation.

## 10. What "done" hands off

- A clean `main` pointing at the squash-merged M08b commit chain.
- Schema delta `0007_*` (kill_switches) on both dialects, sha-locked if hand-edited blocks were needed.
- The CLI on npm-pack-test produces a tarball with the bundled templates dir under `dist/templates/**`.
- 19 new commands wired through `program.ts` (commander surface), each with `--help`, JSON output where applicable, exit-code contract preserved.
- Doctor extends from 20 checks → 25 checks (S18).
- Hooks-bridge gets one new evaluator (`kill-switch-evaluator.ts`) wired BEFORE the existing policy evaluator in the pre-tool chain.
- M08b Context Pack documents every command, every test, every decision, every deferred item (Web App admin parity, M05 quality signals, team-mode kill-switch sync).
- M04, M07 specs receive a "what M08b changed" appendix update if relevant — likely just a one-line note that admin commands now exist as a CLI surface.

## 11. Locked design decisions (signed off 2026-05-03)

These eight design points were locked on 2026-05-03 per the recommendations originally drafted in this spec. Each subsection retains the original question, options, and rationale below the locked decision so future readers can see what was at stake. The implementation slices that each decision constrains are noted explicitly; no slice may proceed against an interpretation that contradicts these locks. To revisit a locked decision, append a new entry to `context_memory/decisions-log.md` and update the matching `**Decision (locked …)**` block here in the same commit. Mirror entries also live in `context_memory/decisions-log.md` for grep-ability across the project.

### OQ-1 — Default kill-switch mode

**Decision (locked 2026-05-03):** (c) — both `--mode hard` and `--mode soft` are available; default = **hard** when `--mode` is omitted.
**Why:** "Pause" reads as "stop the system" in operator parlance; soft is the rare case where the user wants observability without enforcement. Hard-by-default also matches the deny-by-default posture of the rest of the policy chain.
**Constrains:** S2 (bridge translates a hard-mode match to `deny` and a soft-mode match to `allow + audit`; the policy chain is bypassed in either case) + S3 (CLI `--mode` flag default).

— *Original question + options + recommendation kept below for posterity:*

When `coodra pause` is run with no `--mode` flag, what does Coodra do?

- (a) **Hard** (deny everything until resume) — agent stops working entirely; surfaces clearly to the user via Claude Code's permission prompt.
- (b) **Soft** (allow + record `paused` reason in `policy_decisions`) — agent keeps moving, Coodra tracks but doesn't enforce.
- (c) Both available, default = **hard**.
- (d) Both available, default = **soft**.

Recommendation: **(c)**. "Pause" reads as "stop the system" in operator parlance; soft is the rare case where the user wants observability without enforcement. Constrains S3 (CLI default), S2 (bridge default-decision when mode-column read fails open).

### OQ-2 — Kill-switch scope shape

**Decision (locked 2026-05-03):** (a) — **polymorphic** `(scope, target)` schema. `scope` is `text NOT NULL CHECK (scope IN ('global','project','tool','agent_type'))`; `target` is `text NULL` (null when scope='global').
**Why:** Adding a fifth scope value is a one-line enum addition rather than a schema migration; the bridge's match logic is a 4-row table read either way. The compactness wins for both the schema-parity test and the JSON shape exposed via `coodra run show`.
**Constrains:** S1 (migration shape — single `scope text NOT NULL` column + nullable `target`) + S2 (bridge evaluator's match query is `WHERE scope='global' OR (scope=? AND target=?)`).

— *Original question + options + recommendation kept below for posterity:*

Two designs for the schema:

- (a) **Polymorphic:** `scope text NOT NULL CHECK (scope IN ('global','project','tool','agent_type'))`, `target text` (null when scope='global').
- (b) **Multi-column:** four nullable columns (`project_id`, `tool_name`, `agent_type`), all-null = global.

(a) is more compact (2 cols vs 4); (b) is more straightforward and lets each column have a typed FK (`project_id` references `projects.id`). The bridge match logic differs: (a) is a `(scope, target)` lookup per event; (b) is a single OR'd query.

Recommendation: **(a)**. Adding a fifth scope value is one enum addition, not a schema migration. Match logic is a 4-row table read regardless. Constrains the migration shape + the bridge evaluator's query.

### OQ-3 — `db backup` format

**Decision (locked 2026-05-03):** (c) — **either**. Default backup is single-file `.sqlite` via `VACUUM INTO`; `--include-logs` switches to a tarball (`data.db.bak` + `logs/` + `config.json`, mode-0600 preserved).
**Why:** Single-file is the operator-friendly default — drops cleanly into any backup tool. The tarball is for full-environment reproduction (e.g., reproducing a bug for support). No compression by default — SQLite is already compact and gzip adds restore friction.
**Constrains:** S6 (`db backup` accepts `--include-logs`; the default path doesn't pull in `tar` at all).

— *Original question + options + recommendation kept below for posterity:*

Three options:

- (a) **VACUUM INTO** producing a single self-contained `.sqlite` file (default).
- (b) **Tarball** combining `data.db.bak` + `logs/` + `config.json` (mode-0600 preserved).
- (c) **Either** — `--include-logs` flips to tarball, default is single-file.

Recommendation: **(c)**. Single-file is the operator-friendly default (drop into a backup tool); the tarball is for full-env reproduction (e.g., reproducing a bug for support). No compression by default — SQLite is already compact and gzip adds restore friction.

### OQ-4 — `db restore` semantics

**Decision (locked 2026-05-03):** (a) — **atomic replace** of `~/.coodra/data.db` with auto-backup-of-current taken before swap. Refuses if daemons are running. No `--with-daemons-running` escape hatch.
**Why:** Live import is meaningless for a primary store — merge semantics for `runs.status` transitions, `policy_decisions.idempotency_key` collisions, and the append-only `decisions` table are all ill-defined. Atomic replace + auto-snapshot is the only safe shape; daemons-running + atomic replace is silent corruption (SQLite WAL + concurrent writers).
**Constrains:** S6 (`db restore` daemons-running check refuses; auto-backup-of-current is unconditional).

— *Original question + options + recommendation kept below for posterity:*

- (a) **Atomic replace** with auto-backup-of-current; refuses if daemons running.
- (b) **Live import** that merges rows by id (skip duplicates).
- (c) **Atomic replace** WITH `--with-daemons-running` escape hatch.

Recommendation: **(a)**. Live import is meaningless for a primary store — the merge semantics for `runs.status` transitions, `policy_decisions.idempotency_key` collisions, and the append-only `decisions` table are all ill-defined. `--with-daemons-running` is a footgun: SQLite WAL + concurrent writers + atomic replace is silent corruption. Constrains S6.

### OQ-5 — `uninstall` data-preservation default

**Decision (locked 2026-05-03):** (a) — **default = preserve** data + config + feature packs + context packs. `--purge` adds removal of `~/.coodra/` and prints (does not run) the `npm uninstall -g @coodra/cli` command for the user.
**Why:** Matches the principle of least surprise — `apt-get remove` preserves config by default; `apt-get purge` is the explicit wipe. Users who reinstall expect their feature packs / context packs / kill-switch history to still be there.
**Constrains:** S8 (uninstall default-safe path; `--purge` opt-in).

— *Original question + options + recommendation kept below for posterity:*

- (a) **Default = preserve** data + config + feature packs + context packs. Add `--purge` for full wipe.
- (b) **Default = wipe everything**. Add `--keep-data` / `--keep-config` to opt out.

Recommendation: **(a)**. Matches the principle of least surprise — `apt-get remove` preserves config by default; `apt-get purge` is the explicit wipe. Constrains S8.

### OQ-6 — `run cancel` observability to bridge

**Decision (locked 2026-05-03):** (a) — `coodra run cancel <runId>` only flips `runs.status='cancelled'` + `runs.ended_at=now()`. The bridge keeps recording PostToolUse events for that run if any arrive; cancellation is informational metadata.
**Why:** (b) costs an extra DB lookup on the latency-sensitive PostToolUse path (10 ms p95 budget per M03). Cancellation is informational — once a developer closes a session, no PostToolUse events arrive anyway, and a synthetic forward-event after cancel is a debugging-utility case, not a production case.
**Constrains:** S11 (`coodra run cancel` writes `runs.status` only; bridge handler unchanged).

— *Original question + options + recommendation kept below for posterity:*

When `coodra run cancel <runId>` runs, what does the bridge do for in-flight or future events for that run?

- (a) **Just flip `runs.status`.** Bridge keeps recording PostToolUse events. Cancellation is metadata.
- (b) **Deny future events.** Bridge looks up `runs.status` on every PostToolUse and refuses to record if status='cancelled'.

Recommendation: **(a)**. (b) costs an extra query on the latency-sensitive post-tool path (10ms p95 budget per M03). Cancellation is informational — once a developer closes a session, no PostToolUse events arrive anyway. Constrains S11.

### OQ-7 — `export` audit-trail inclusion

**Decision (locked 2026-05-03):** (a) — non-JSON formats (markdown, html, slack) **exclude** `policy_decisions` rows by default. `--include-audit` opts in. JSON always includes audit (machine-readable consumers want full fidelity).
**Why:** Markdown / HTML / Slack are narrative formats — readers want "what was decided + why", not a 200-row deny audit. JSON consumers (CI export, SOC2 review) need the full audit.
**Constrains:** S12 (`export` renderers default `includeAudit=false` for narrative formats; JSON renderer hard-codes `includeAudit=true`).

— *Original question + options + recommendation kept below for posterity:*

For non-JSON formats (markdown, html, slack), should `policy_decisions` rows be included by default?

- (a) **Default = exclude** for narrative readability. `--include-audit` flag to opt in.
- (b) **Default = include** for SOC2-style review.

Recommendation: **(a)**. Markdown / HTML / Slack are narrative formats — readers want "what was decided + why", not a 200-row deny audit. JSON always includes audit. `--include-audit` for the rare review case. Constrains S12.

### OQ-8 — Team-mode kill-switch sync

**Decision (locked 2026-05-03):** (a) — **local-only in M08b**. Synced kill switches are an M04 admin-surface concern (admin flips a global switch from the dashboard, replicates via the cloud-sync path established in M04a).
**Why:** M08b ships solo + team-mode-self-host but no managed cloud product yet — there is no "the team" to sync to. M04 owns the cross-developer admin surface; building the sync path now would couple M08b to a not-yet-decided cloud authorization model. The local-only kill switch still solves the operator's "stop the system on my machine" problem completely.
**Constrains:** S2 (no sync-daemon enqueue for kill-switch rows) + S3 (CLI never POSTs to cloud) + the M08b closeout pack flags "team-mode kill-switch sync" as deferred to M04.

— *Original question + options + recommendation kept below for posterity:*

A kill-switch flipped on developer A's machine — should it propagate to developer B?

- (a) **Local-only in M08b.** Synced kill-switches are an M04 admin-surface concern (admin flips a global switch from the dashboard, replicates via cloud-sync).
- (b) **Synced from day one** via the existing cloud-sync path.

Recommendation: **(a)**. M08b ships solo + team-mode-self-host but NOT a managed cloud — there's no "the team" yet to sync to. M04 owns the sync surface. M08b's kill-switch is per-machine. Constrains S2 (no sync code), S3 (CLI never POSTs to cloud).

---

**Sign-off:** all eight decisions above were locked on 2026-05-03 by the project lead during the M08b kickoff session on `feat/08b-cli-expansion`. Mirror entries land in `context_memory/decisions-log.md` in the same S0 commit. Any future change to a locked decision requires a new `decisions-log.md` entry and a same-commit edit to the matching `**Decision (locked …)**` block here, plus a recorded re-sign-off.
