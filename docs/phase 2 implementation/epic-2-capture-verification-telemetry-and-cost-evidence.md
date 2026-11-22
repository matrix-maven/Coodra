# Epic 2: Capture verification, telemetry and cost evidence

Implementation reference for [COOD-105](https://matrixmaven.atlassian.net/browse/COOD-105).

Status: implemented on branch `codex/cood-105-telemetry`. Revision 2 moved telemetry out of `run_events` into its own table, `native_telemetry_events`; revision 2.1 fixed two issues found in independent review (upgrade path and queued-job ownership); revision 3 makes the Run optional so evidence is kept even when hooks never created one; revision 4 adds Coodra hook and MCP-server health events; revision 5 adds hook-versus-telemetry reconciliation and the Agent telemetry page; revision 6 adds the Raw events view; revision 7 adds the Codex adapter, a `coodra telemetry` command, a Run-view panel, measured capacity limits and exporter behaviour findings. This document is the implementation reference and the review checklist for an independent validator (see [Reviewer checklist](#reviewer-checklist)).

The shared envelope carries a `harness` discriminator for Claude Code and Codex. Both OTLP HTTP/JSON logs adapters exist, with separate event allowlists and exact harness identity checks. Revision 8 verifies Codex inner exec operations against hooks and fixes startup attachment through the normal MCP Run creation path.

| Surface | Status |
| --- | --- |
| Claude Code OTLP HTTP/JSON logs | Verified live: `tool_result` (success and failure), `api_request`, `api_error` |
| Codex telemetry | OTLP logs adapter implemented and verified live on codex-cli 0.171.0-alpha.13 (see Codex adapter); CLI exec/patch/local-MCP native IDs verified; desktop export and resumed Run identity verified, desktop native hooks unresolved |
| OTLP protobuf, gRPC, metrics, traces | Not implemented |
| Hook vs telemetry reconciliation | Implemented for tool operations (see Reconciliation); verified with fixtures and an isolated live paired Codex session; other tool coverage remains explicitly limited |
| Agent telemetry page | Implemented (`/telemetry`); empty state verified in a browser; populated rendering not yet viewed in a browser |
| Run-view panel | Implemented (panel on each Run page) |
| Checkpoint coverage | Not implemented |

## Revision 8 validation (22 November 2026)

Independent verification found the Codex adapter, CLI controls, usage queries and Run panel already present. The remaining implementation gaps were blanket `not_comparable` classification and startup rows missing attachment through MCP `get_run_id`. Both are fixed without new storage or migrations.

Focused checks: 20 reconciliation tests, 49 MCP telemetry/Run identity integration tests, 11 web telemetry-query tests and 31 CLI telemetry/help/program tests passed. Shared, CLI, MCP server and web typechecks passed. The repeat live paired capture accepted nine events, with zero left unattached after Run creation; two inner exec operations had matching Pre/Post native IDs. Outer wrapper counts can vary with the harness's grouping and are never counted as missing hooks. These checks do not repeat the earlier Postgres/container or populated-browser validation. Changes remain in the working tree; no installed daemon or user configuration was modified during this validation.

## Delivery tracking — COOD-105

As reviewed on 22 November 2026, the local native telemetry slice is implemented; the full Epic 2 remains open because its published scope also includes checkpoint diagnostics and broader harness coverage. Epic 1 / COOD-104 is unchanged. No scope was silently removed to close the epic.

| Story | Outcome | Delivery state |
| --- | --- | --- |
| [COOD-119](https://matrixmaven.atlassian.net/browse/COOD-119) | Safe database/outbox persistence, migration, privacy, replay and retention | Implemented |
| [COOD-120](https://matrixmaven.atlassian.net/browse/COOD-120) | Claude Code native logs, usage and hook-health capture | Implemented |
| [COOD-121](https://matrixmaven.atlassian.net/browse/COOD-121) | Codex adapter, paired CLI IDs, desktop export and Run association | Implemented within documented coverage |
| [COOD-122](https://matrixmaven.atlassian.net/browse/COOD-122) | Reconciliation, Agent telemetry/raw-event views and Run panel | Implemented; populated-browser revalidation pending |
| [COOD-123](https://matrixmaven.atlassian.net/browse/COOD-123) | CLI opt-in persistence, status and harness configuration output | Implemented |
| [COOD-116](https://matrixmaven.atlassian.net/browse/COOD-116) | Retest desktop hooks against current installed runtime/plugin; shutdown/resume and UI checks | Pending testing/diagnosis; installed-version cause unproven |
| [COOD-117](https://matrixmaven.atlassian.net/browse/COOD-117) | Checkpoint capture/recovery diagnostics using Epic 1 evidence | Pending implementation/integration |
| [COOD-118](https://matrixmaven.atlassian.net/browse/COOD-118) | Broader harness/version/surface matrix and attributable usage/cost evidence | Pending implementation/verification |

Final pre-commit verification: 113 focused tests passed (22 shared reconciliation, 49 MCP telemetry/Run identity integration, 11 web telemetry-query and 31 CLI telemetry/help/program). Shared, CLI, MCP server and web typechecks passed. Existing database schema/migration work is in earlier commits; this commit adds no migration. Earlier broader test and Postgres results below are historical evidence, not rerun results for this review. No installed runtime redeployment is implied by committing source.

## Change history

| Rev | Change |
| --- | --- |
| 1 (`279abd4`) | Receiver, allowlist, replay identity, retention. Stored in `run_events` with `phase = 'telemetry'`. No schema change |
| 2 | **New table `native_telemetry_events`** (SQLite + Postgres schema, migrations `sqlite/0041`, `postgres/0043`), new outbox queue `native_telemetry`, dispatcher branch, `insertNativeTelemetryEvent`, project-delete wiring, tests. Receiver and retention moved to the new table. The ROI query filter added in rev 1 was reverted because `run_events` no longer holds telemetry |
| 8 | **Codex capture verification.** Live paired CLI/hooks evidence, native-ID reconciliation for inner exec operations, explicit outer-wrapper exclusions, and startup attachment on MCP Run creation/reuse. No schema change |
| 7 | **Codex, CLI, Run panel, limits.** (a) Codex adapter on `POST /telemetry/codex/<slug>/v1/logs`, no schema change. (b) `coodra telemetry enable|disable|status|env`, persisted in `<COODRA_HOME>/.env`. (c) A telemetry panel on each Run page. (d) Local caps now default to 50,000 retained and 5,000 unattached rows (measured), configurable by env. (e) Live findings on exporter flush, retry and signal handling |
| 6 | **Raw events view.** `/telemetry/events` (no schema change): a filterable, newest-first list of every accepted event with expandable rows, plus an optional live tail. Query `listTelemetryEvents` in `apps/web-v2/lib/queries/telemetry.ts` |
| 5 | **Reconciliation and UI.** No schema change. New pure module `packages/shared/src/telemetry-reconciliation.ts` (`reconcileToolOperations`), query layer `apps/web-v2/lib/queries/telemetry.ts`, pages `/telemetry` and `/telemetry/<projectId>/<sessionId>`, and an **Agent telemetry** link in the left navigation (hidden on a hosted team server, because telemetry is local-only) |
| 4 | **Hook and MCP events.** Two more events are accepted: `claude_code.hook_execution_complete` and `claude_code.mcp_server_connection`. New nullable typed columns (SQLite `0044`, Postgres `0045`, `ADD COLUMN` only): `hook_event`, `hook_name`, `hook_count`, `hook_success_count`, `hook_blocking_count`, `hook_error_count`, `hook_cancelled_count`, `connection_status`, `transport_type`, `server_scope`, `plugin_id_hash`. Purpose: measure Coodra's own hooks and MCP server as Claude Code observed them (outcome counts, duration, connection health) |
| 3 | **Run is optional.** `run_id` is nullable with `ON DELETE SET NULL` (SQLite migration `0043` rebuilds the table, Postgres `0044` drops NOT NULL), plus index `native_telemetry_events_session_idx (project_id, session_id)`. The receiver no longer returns 503 for a missing Run: it stores the row unattached. Replay identity no longer includes the Run. Unattached rows are attached when a Run appears (at dispatch, or when `insertRun` creates it). Unattached evidence expires after 24 hours and has its own capacity budget (2,000) |
| 2.1 | **Upgrade path:** SQLite migration `0042_backfill_native_telemetry.sql` copies rev-1 `run_events` telemetry rows into the new table (id and receipt time preserved) and deletes the legacy rows; the outbox dispatcher reroutes still-queued rev-1 `run_event` telemetry jobs to the new table; retention and capacity now match `native_telemetry_*` ids regardless of queue. **Deletion:** queue rows are stamped with `project_id`/`run_id` (`scheduleDurableWrite` gained optional `orgId`/`projectId`/`runId`), and project delete also removes `native_telemetry` jobs by payload `projectId`, so no job outlives its project |

Why separate: `run_events` is the hook/MCP audit trail read by ~40 files (sync daemon, dashboards, ROI, run-diff, auto-context-pack, doctor, team-migrate). Telemetry has a different clock, wants typed and indexed numeric fields for reconciliation and cost rollups, needs time-based retention, and can arrive before its Run exists. Mixing them risked silent leakage into every `run_events` reader.

## Architecture

```
Claude Code CLI ──OTLP/HTTP JSON──▶ POST /telemetry/claude_code/<slug>/v1/logs
                                    (mcp-server daemon, src/transports/http.ts)
                                         │ validate peer/headers/auth, parse
                                         ▼
                              createNativeTelemetryReceiver (src/lib/native-telemetry.ts)
                                allowlist → resolve Run → hash identity → admission check
                                         │ scheduleDurableWrite (queue "native_telemetry")
                                         ▼
                              pending_jobs ──OutboxWorker / dispatcher──▶ native_telemetry_events
```

No new process, collector or database. The daemon, durable outbox and canonical SQLite store are reused.

### Files

| File | Role |
| --- | --- |
| `apps/mcp-server/src/lib/native-telemetry.ts` | Allowlist, receiver, identity hashing, retention pruning, queue payload construction |
| `apps/mcp-server/src/transports/http.ts` | Route, loopback/Origin/content-type/encoding checks, auth, status mapping |
| `apps/mcp-server/src/index.ts` | Opt-in wiring (`COODRA_TELEMETRY_ENABLED=1`, solo only), hourly retention pass, outbox kick |
| `packages/cli/src/lib/outbox/types.ts` | `native_telemetry` queue kind, added to `AUDIT_QUEUE_KINDS` so the mcp-server and bridge workers claim it |
| `packages/cli/src/lib/outbox/dispatcher.ts` | `NativeTelemetryPayloadV1` and the `native_telemetry` dispatch branch |
| `packages/db/src/schema/sqlite.ts`, `schema/postgres.ts` | `nativeTelemetryEvents` table (both dialects) |
| `packages/db/src/destinations.ts` | `insertNativeTelemetryEvent` (idempotent on `id`) |
| `packages/db/src/projects.ts` | `native_telemetry_events` added to the project-delete dependent tables |
| `packages/db/drizzle/sqlite/0041_overconfident_mongu.sql`, `drizzle/postgres/0043_ordinary_dark_phoenix.sql` | Migrations (create table and indexes only) |
| `packages/db/drizzle/sqlite/0042_backfill_native_telemetry.sql` | SQLite-only data migration: backfill rev-1 telemetry from `run_events`, then delete the legacy rows. No Postgres counterpart (the receiver is SQLite-only, so Postgres never held telemetry) |
| `packages/db/src/schedule-durable-write.ts` | Optional ownership stamps on queued jobs |
| `apps/mcp-server/__tests__/integration/lib/native-telemetry.test.ts` | 14 integration tests |
| `packages/db/__tests__/unit/schema-parity.test.ts`, `unit/client.test.ts`, `integration/delete-project.test.ts` | Parity, table list and count, delete coverage |

## Database

### New table: `native_telemetry_events`
Append-only, local-only (no `sync_to_cloud` job, so nothing reaches Postgres at runtime; the Postgres schema exists for dialect parity). `id` is a replay-identity hash, so an exact replay or outbox retry is `ON CONFLICT DO NOTHING`.

| Column | SQLite | Postgres | Null | Notes |
| --- | --- | --- | --- | --- |
| `id` | text PK | text PK | no | `native_telemetry_<sha256>` (see Replay identity) |
| `org_id` | text | text | yes | Unused in solo |
| `project_id` | text FK `projects.id` | same | no | |
| `run_id` | text FK `runs.id` **ON DELETE SET NULL** | same | **yes** | NULL = unattached: no Run was known for the session. Attached later; a Run delete leaves the evidence unattached |
| `harness` | text | text | no | `claude_code` or `codex` |
| `source` | text | text | no | `otlp_logs` |
| `event_name` | text | text | no | e.g. `claude_code.tool_result` |
| `source_time_unix_nano` | text | text | no | Producer clock in ns; text because it exceeds 2^53 |
| `source_time_ms` | integer | bigint (number) | no | Same instant in ms, for ordering and indexing |
| `session_id` | text | text | no | Native harness session, not the MCP transport session |
| `app_version` | text | text | yes | From `app.version` when supplied |
| `tool_use_id` | text | text | yes | Correlation key against hook rows; null when not supplied |
| `tool_name` | text | text | yes | |
| `request_id` / `client_request_id` / `prompt_id` | text | text | yes | |
| `agent_id` / `parent_agent_id` | text | text | yes | Only when the source supplies them; parentage is never inferred |
| `model` | text | text | yes | |
| `success` | integer (boolean) | boolean | yes | Tool execution status, separate from any policy verdict; null when not reported |
| `event_sequence`, `duration_ms`, `status_code`, `attempt` | integer | integer | yes | |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens` | integer | integer | yes | |
| `tool_input_size_bytes`, `tool_result_size_bytes` | integer | integer | yes | Sizes only; no content |
| `cost_usd_micros` | integer | integer | yes | Provider estimate in micro-USD; null means unavailable, never zero. Taken from `cost_usd_micros`, else `round(cost_usd * 1e6)` |
| `cost_kind` | text | text | no | `provider_estimate` or `unavailable` |
| `content_policy` | text default `excluded` | same | no | Evidence that content was dropped before queueing |
| `attributes_json` | text default `{}` | same | no | Full allowlisted attribute set, for fidelity with the source |
| `received_at` | integer (unix s) | timestamptz | no | Receipt time, independent of source time |

Indexes: `native_telemetry_events_run_time_idx (run_id, source_time_ms)`, `native_telemetry_events_run_tool_idx (run_id, tool_use_id)`, `native_telemetry_events_session_idx (project_id, session_id)` (attachment), `native_telemetry_events_received_idx (received_at)` (retention).

### Existing tables used
- `projects` (read): slug lookup via `lookupProjectBySlug`; unknown slug returns 404.
- `runs` (read): exact match on `project_id`, `session_id` (native `session.id`) and `agent_type` matching the adapter harness, backed by `runs_project_session_idx`. Coodra never creates a Run from telemetry and never binds by time, cwd or MCP transport session. A Run of a different harness for the same session is not claimed.
- `pending_jobs` (write, transient): durable outbox, `queue = 'native_telemetry'`, `id = native_telemetry_<sha256>`, payload `NativeTelemetryPayloadV1`, stamped with `project_id` and `run_id`. Dead-lettered jobs stay visible here until retention removes them.

### Not used
`run_events` is **not** written by this feature. Hook and MCP activity there is unchanged, and no `run_events` reader needs a telemetry filter. Rev-1 rows are removed from it by migration `0042` (see Upgrade from revision 1).

## Queue payload and dispatch

`NativeTelemetryPayloadV1` carries the typed columns above plus `rowId`, `receivedAt` (ISO) and `attributesJson`. The dispatcher validates the required fields (`rowId`, `projectId`, `runId`, `harness`, `source`, `eventName`, `sourceTimeUnixNano`, `sourceTimeMs`, `sessionId`, `costKind`, `attributesJson`, a parseable `receivedAt`); a malformed payload is a permanent failure and the job is dead-lettered with no partial row. Optional fields degrade to null individually. A foreign-key failure (Run missing) throws and is retried by the worker as transient.

## Upgrade from revision 1

Revision 1 stored telemetry in `run_events` (`phase = 'telemetry'`, `id` prefixed `native_telemetry_`) and queued it on `run_event`. On upgrade:

- **Stored rows:** migration `0042` inserts each valid legacy row into `native_telemetry_events` (`INSERT OR IGNORE` on id), preserving the row id (replay identity) and the original receipt time (`run_events.created_at` becomes `received_at`). Project comes from the Run; typed columns are extracted from the stored envelope; cost micros are `round(cost_usd * 1e6)` when only `cost_usd` was present. It then deletes all legacy telemetry rows from `run_events`, so they stop counting as tool activity (this is why the ROI filter could be reverted). Legacy rows with no Run (`run_id` NULL after a Run delete) cannot satisfy `run_id NOT NULL` and are dropped; rows with a malformed envelope are skipped and then deleted.
- **Queued jobs:** a still-pending or retried `run_event` job with `phase = 'telemetry'` and a `native_telemetry_` row id is converted by the dispatcher (`legacyTelemetryRow`) and written to the new table with its original receipt time, never to `run_events`. A job already dead-lettered is not re-dispatched automatically; retention still expires it, because retention and capacity match the id prefix, not the queue name.
- **Idempotency:** both paths are keyed on the same row id, so running the migration and draining a legacy job for the same event cannot duplicate it.

Verified by an integration test (backfill preserves id, source time, receipt time, project, typed columns; hook rows untouched; legacy job rerouted) and by applying migrations `0041` and `0042` to a copy of a real 20,180-event local database carrying a revision-1 telemetry row: the row moved, `run_events` kept every other row, and `project_id` came from the Run.

## Accepted events and allowlist

Only five events are kept; every other record is counted as rejected.

| Event | Meaning |
| --- | --- |
| `claude_code.tool_result` | A tool call finished; carries `success`, timing and size metadata |
| `claude_code.api_request` | A model request; carries model, token counts, timing, cost estimate |
| `claude_code.api_error` | A failed model request; carries model, status, attempt, timing (no error text) |
| `claude_code.hook_execution_complete` | One hook event finished, as seen by the harness: how many hooks ran, how many succeeded, blocked, errored non-blockingly or were cancelled, and total duration. No hook command, output or content |
| `claude_code.mcp_server_connection` | An MCP server connected, failed or disconnected: status, transport, scope, duration |

Allowlisted identifiers (strings, max 256 chars, no control characters): `session.id`, `app.version`, `tool_use_id`, `request_id`, `client_request_id`, `prompt.id`, `agent_id`, `parent_agent_id`, `model`, `tool_name`, `hook_event`, `hook_name`, `hook_source`, `status`, `transport_type`, `server_scope`, `plugin_id_hash`.

Allowlisted numbers (non-negative, finite; JSON numbers or numeric strings): `event.sequence`, `duration_ms`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`, `cost_usd_micros`, `attempt`, `status_code`, `tool_input_size_bytes`, `tool_result_size_bytes`, `num_hooks`, `num_success`, `num_blocking`, `num_non_blocking_error`, `num_cancelled`, `total_duration_ms`, `stdout_chars`, `additional_context_chars`, `system_message_chars`, `initial_user_message_chars`, `num_outputs_persisted`. Booleans (also accepted as `'true'`/`'false'` strings): `success`, `is_plugin`, `managed_only`, `safe_mode`. The hook and MCP fields beyond the typed columns are kept only in `attributes_json`; `duration_ms` is filled from `duration_ms` or, for hooks, `total_duration_ms`.

Everything else is dropped before the queue: the OTLP body, prompts and `prompt_text`, tool inputs and results, free-text `error`, `user.email`, `user.id`, account and organization IDs. Missing fields stay null.

### Events that are rejected
Seen in a real startup export and still rejected: `hook_registered`, `plugin_loaded`, `hook_execution_start` (its completion event carries the same counts plus duration), `managed_settings_resolved`, `user_prompt`. A record is also rejected when its session ID is missing, or its source time is older than seven days or more than five minutes in the future. Rejections are reported through OTLP `partialSuccess`.

## Receiver behaviour

**Route:** `POST /telemetry/claude_code/<project-slug>/v1/logs`, enabled only when `COODRA_TELEMETRY_ENABLED=1` and `COODRA_MODE=solo`; otherwise 404.

**Checks, in order:** loopback peer and no `Origin` header (403 `local_telemetry_only`); POST (405); `Content-Type: application/json` with no `Content-Encoding` (415); the transport auth layer; JSON body up to 1 MiB.

**Parsing:** OTLP/JSON `resourceLogs[].scopeLogs[].logRecords[]`, at most 32 × 32 groups and 256 records per export. Attribute values come from `stringValue`, `boolValue`, `intValue` or `doubleValue`; resource attributes are merged beneath record attributes. The event name comes from the record `eventName`, else the body string, else `event.name`, normalised to the `claude_code.` prefix.

**Run resolution and attachment:** exact project + native session + adapter harness (`claude_code` or `codex`).
- Run found at receipt: `run_id` is set.
- No Run: the record is accepted (200) and stored unattached (`run_id` NULL). No Run is created and nothing is retried against the exporter. It is attached later by `attachNativeTelemetryToRun`, which runs (a) in the dispatcher when a still-unattached job is written, and (b) inside `insertRun` when a Run is created, and (c) through `get_run_id` on creation, reuse and race recovery. Attachment failure is logged without breaking Run identity; a later identity call retries. These paths are idempotent, never overwrite an existing association, and match the harness.
- Because the Run is not part of replay identity, the same event is one row whether or not a Run existed when it arrived.

Association by this join establishes record linkage, not authentication of the native producer. Dropping the previous "Run must exist" check makes forged unattached rows cheaper (any loopback client can submit a session ID), which is why unattached evidence is short-lived and separately bounded.

**Admission:** requests are serialised. The receiver counts distinct retained identities across `native_telemetry_events` and queued jobs; above the retained budget (default 50,000) it returns 503 `telemetry_capacity_exceeded`, and above the unattached budget (default 5,000) it returns 503 `telemetry_unattached_capacity_exceeded`, rather than deleting recent evidence. Replays of identities already counted do not consume budget.

**Write:** each accepted record goes through `scheduleDurableWrite` on queue `native_telemetry`, then the outbox worker is kicked.

### Replay identity
`id = native_telemetry_ + sha256(JSON(observation without receivedAt))`, covering project, harness, session, event name (excluding Run linkage), source and, source nanosecond time, the allowlisted attributes, `content` and `costKind`. Exact replays collapse to one row; repeated `event.sequence` values after a resume do not collide because source time differs. Two events with identical metadata at the exact same nanosecond are indistinguishable. This is not a complete source ledger.

### Status codes

| Code | Meaning |
| --- | --- |
| 200 | All supported records durably enqueued or already accepted; may include `partialSuccess.rejectedLogRecords`. Does **not** mean the table write has completed |
| 400 | Invalid JSON or OTLP envelope |
| 401 | Auth layer rejected the request |
| 403 | Non-loopback peer or `Origin` present |
| 404 | Unknown project slug, or receiver not enabled |
| 405 | Not POST |
| 413 | Body over 1 MiB or over 256 records |
| 415 | Not uncompressed `application/json` |
| 503 | Capacity exceeded (total or unattached) or storage failure; sent with `Retry-After: 5`. A failed batch can have earlier durable writes; replaying the full batch is safe |

## Retention, deletion and limits

- Attached rows and queue payloads expire seven days after receipt; **unattached rows (`run_id` NULL) expire after 24 hours** (so a row whose Run is later deleted also ages out within a day of receipt): `pruneNativeTelemetry` deletes `native_telemetry_events` where `received_at` is older than seven days, or `run_id IS NULL` and older than 24 hours, and `pending_jobs` whose id starts `native_telemetry_` and whose `created_at` is older, including dead letters and rev-1 jobs. No other rows are touched.
- The enabled daemon prunes on boot and hourly, logging `native_telemetry_retention` (with the count) or `native_telemetry_retention_failed`.
- Deleting a Run sets `run_id` to NULL on its telemetry (the evidence is kept as unattached and expires per above). Deleting a project removes its telemetry in the dependent-tables phase of `deleteProject` (`native_telemetry_events` is in `DEPENDENT_PROJECT_TABLES`). Queued jobs go with it: they are stamped with `project_id` (cleared by the existing `pending_jobs` sweep), and `deleteProject` additionally deletes `native_telemetry` jobs whose payload `projectId` matches, so an unstamped or older job cannot survive and dead-letter on a missing foreign key.
- Capacity budgets are sized from measured use. The busiest day in a real local database had 1,028 tool calls (average 185 on active days), and each call produces roughly four telemetry rows (tool result, a model request, and a hook completion on each side), so a sustained peak week is about 29,000 rows. Defaults: **50,000** retained identities and **5,000** unattached (a 24 hour peak day), about 30 MB at roughly 0.6 KB a row. Override with `COODRA_TELEMETRY_MAX_EVENTS` and `COODRA_TELEMETRY_MAX_UNATTACHED` (positive integers; anything else falls back to the default). These are still estimates from one machine's history.
- Retention removes evidence; it does not establish successful capture or semantic coverage.

## Setup

Telemetry is opt-in.

### Daemon
The daemon process needs `COODRA_TELEMETRY_ENABLED=1`. For a repository dev instance on a free port (never start a second daemon over an existing listener):

```sh
COODRA_TELEMETRY_ENABLED=1 COODRA_MODE=solo MCP_SERVER_HOST=127.0.0.1 MCP_SERVER_PORT=4318 \
  pnpm --filter @coodra/mcp-server exec tsx src/index.ts --transport http
```

For the installed launchd daemon (macOS), add the variable to `~/Library/LaunchAgents/com.coodra.mcp-server.plist` under `EnvironmentVariables` and reload with `launchctl bootout` then `launchctl bootstrap` (`kickstart -k` does not re-read the plist). Prefer the command below, which persists the choice in `<COODRA_HOME>/.env` so it survives `coodra start`, reinstall and reboot. The migration is applied by the daemon at boot from `COODRA_MIGRATIONS_DIR`, so the installed `drizzle/` directory must contain `0041_overconfident_mongu.sql` and its journal entry.

### `coodra telemetry`

```sh
coodra telemetry enable            # writes COODRA_TELEMETRY_ENABLED=1 to ~/.coodra/.env (created 0600 if new)
coodra stop && coodra start        # the daemon reads it at boot; `start` alone is a no-op when already running
coodra telemetry status            # persisted setting vs what the running daemon mounts
coodra telemetry env --project <slug> [--harness claude|codex]
coodra telemetry disable
```

`enable` and `disable` edit only that one `.env` line (other lines, comments and secrets are untouched) and say a restart is needed. `status` probes the daemon: a mounted receiver answers an unknown project slug with `project_not_found`, an unmounted one with the generic 404, so it can report "enabled in config, daemon needs a restart" or "running with telemetry on, but not persisted (set by hand)". `env` prints the Claude Code exports and the Codex `config.toml` fragment with the daemon port and project slug. The flag is a machine-level key: a project `.env` cannot override it. It forwards into the daemon unit env because every `COODRA_*` key does. Verified on the installed daemon: after `enable` and `coodra stop && coodra start` the launchd unit carries the variable and `status` reports enabled and persisted.

### Claude Code

```sh
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:3100/telemetry/claude_code/<project-slug>/v1/logs
export OTEL_LOG_USER_PROMPTS=0
export OTEL_LOG_TOOL_DETAILS=0
export OTEL_LOG_TOOL_CONTENT=0
export OTEL_LOG_RAW_API_BODIES=0
export OTEL_LOG_ASSISTANT_RESPONSES=0
export OTEL_LOGS_EXPORT_INTERVAL=1000
claude
```

Leave metric and trace exporters unset for a logs-only setup. Repository `.claude/settings.json` is not used and Coodra changes no global settings. The privacy flags are belt and braces: the receiver discards content regardless.

References: [Agent SDK observability](https://code.claude.com/docs/en/agent-sdk/observability), [Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage) (log signals and exporter configuration), and [API OpenTelemetry](https://platform.claude.com/docs/en/manage-claude/opentelemetry) (a distinct API/SDK tracing integration, not used here).

## Codex adapter

`POST /telemetry/codex/<project-slug>/v1/logs` (same receiver, checks and limits). Verified by running the real `codex exec` (codex-cli 0.171.0-alpha.13, bundled in the ChatGPT app) against a local sink and against an isolated daemon. Codex config (also printed by `coodra telemetry env --harness codex`):

```toml
[otel]
environment = "dev"
log_user_prompt = false
exporter = { otlp-http = { endpoint = "http://127.0.0.1:<port>/telemetry/codex/<slug>/v1/logs", protocol = "json" } }
```

**Identity.** `conversation.id` is the session (it has the same id shape as Coodra's Codex Runs); the Run lookup uses `agent_type = 'codex'`, so a Claude Code Run with the same id is never claimed. **Time.** Codex sends `timeUnixNano` as `"0"`; the receiver takes the instant from `observedTimeUnixNano`, then from the ISO `event.timestamp` attribute, and rejects a record with none. **Event names** come from the `event.name` attribute (the record `eventName` is a Rust source location).

| Codex event | Stored as | Fields kept |
| --- | --- | --- |
| `codex.tool_result` | `codex.tool_result` | call id (`tool_use_id`), tool name, namespace, `success`, `duration_ms`, `output_truncated`, agent name, MCP server name |
| `codex.sse_event` with `event.kind = response.completed` | `codex.response_completed` | model, input, output, cached (`cache_read_tokens`), cache write, reasoning and tool token counts |
| `codex.tool_decision` | `codex.tool_decision` | tool name, call id, `decision` (for example `approved`), `decision_source` (for example `Config`) |
| `codex.conversation_starts` | `codex.conversation_starts` | model, app version, approval policy, sandbox policy, reasoning effort |

Not collected: `codex.user_prompt`, streaming `codex.sse_event` deltas, `codex.websocket_*`, `codex.startup_phase`, `codex.turn_ttft`, `codex.api_request` (it carries no session id) and non-event records. Typed columns reuse the existing ones; the Codex-only fields live in `attributes_json`. Codex reports no cost, so `cost_kind` is `unavailable`.

**Privacy finding.** Codex exports the tool call `arguments` and `output` in `codex.tool_result` even with `log_user_prompt = false`, together with the account email and id and the host name. The adapter is an explicit allowlist and reads none of them (a test asserts they never reach the queue or the table). Any other exporter configured for Codex would still receive them.

**Reconciliation (revision 8).** A paired capture on Codex CLI 0.171.0-alpha.13 verified that the inner `exec_command` event's `exec-<uuid>` ID equals the `tool_use_id` recorded by the native Bash PreToolUse/PostToolUse hooks. These operations now reconcile by exact native ID. One-sided inner exec operations use the normal arrival grace window. Outer `exec` wrapper events have separate `call_...` IDs and no corresponding hook; they remain `not_comparable` with reason `codex_outer_tool_without_hook`. Other tool families require an exact ID match in both channels or their own verified coverage before one-sided absence is classified.

**Success semantics.** Both a successful command and a command exiting 3 reported `success=true`: this is tool invocation success, not shell exit status. Codex does not inherit Claude's `post_hook_after_failure` disagreement rule. No shell status is inferred from excluded output.

**Paired verification boundary.** The test used an ephemeral read-only Codex CLI session, temporary inline native hooks forwarding sanitized envelopes to the real lifecycle handler, real SQLite migrations/Run recorder/outbox/receiver, and an always-allow policy fixture. It verifies capture, IDs and storage, not production policy enforcement or installed plugin provisioning. Startup telemetry arrived before SessionStart; revision 8 attaches it when the normal MCP path creates the Run. The desktop app and other Codex tool families remain unverified.

## Revision 9: additional Codex tools and desktop handoff

Verified on 22 November 2026 with Codex CLI 0.171.0-alpha.13, in temporary projects using real lifecycle handlers, migrations, Run recording, receiver and outbox, with an always-allow Coodra policy fixture:

| Tool | Observed paired behavior | Reconciliation boundary |
| --- | --- | --- |
| `apply_patch` | Successful file creation: Pre + Post and `success=true`. Update of nonexistent file: Pre only and `success=false`. Native `exec-<uuid>` IDs match | Exact-ID matching and one-sided absence classification enabled |
| Local stdio MCP `probe` | Hook name `mcp__capture_fixture__probe`, telemetry name `probe`; same native `exec-<uuid>` ID. Success: Pre + Post. MCP `isError=true`: Pre only and `success=false` | Exact-ID matching works despite different names. One-sided arbitrary MCP tools remain unverified; no guess from bare tool name |
| `write_stdin` | Its own telemetry ID, separate from originating exec command; no Pre/Post hook observed | `not_comparable`, reason `codex_poll_without_hook`; not a missing hook |
| Outer `exec` | Separate `call_...` ID and no hook of its own | `not_comparable`, reason `codex_outer_tool_without_hook` |

The first MCP attempt was approval-rejected before reaching the fixture server. It is not counted as successful MCP execution. A second invocation explicitly approved only the local fixture `probe`, then verified actual success and a controlled MCP error. User approval policies were unchanged.

Sanitized captured IDs, names, phases and booleans are checked in at `packages/shared/__tests__/fixtures/codex-paired-tools.json`; they contain no arguments, results, account fields, paths or session IDs. Reconciliation regression tests consume this fixture. Fixture captures from separate sessions are combined only for these independent operation-level assertions, not session identity assertions. Subagents, remote MCP transport, other tool families and desktop lifecycle remain unverified.

### Desktop verification: export verified; hooks unresolved

The user approved a temporary user-level OTel configuration. `~/.codex/config.toml` now points to `http://127.0.0.1:3100/telemetry/codex/coodra/v1/logs`, with environment `coodra-desktop-verification`, prompts/responses/guardian text disabled, and tool-result text capped at zero bytes. Original backup: `~/.codex/config.toml.pre-coodra-telemetry-20261122-172634` (mode 0600). TOML parsing and the installed Codex config loader succeeded. Empty-envelope endpoint probes returned 200 for project `coodra` and `project_not_found` for an unknown project; no telemetry rows were created by those probes.

Focused revision-9 validation: 22 shared reconciliation tests and 11 web database-query tests passed; shared/web typechecks and formatting checks passed. A read-only desktop baseline at 2026-11-22 11:58:50 UTC found zero Codex telemetry rows for this chat in `~/.coodra/data.db`; details are saved in `/private/tmp/coodra-desktop-telemetry-baseline.json`.

Desktop export was verified after the user restarted the app and resumed this chat on 22 November 2026. A read-only snapshot at 17:14:01 UTC (22:44:01 IST) contained **30 accepted events** for the original session `01a1e8f9-b72c-7fb0-9086-c1a35604e14f`: one conversation start, nine completed responses, seven tool decisions and thirteen tool results. All reported Codex `0.171.0-alpha.13`; **zero were unattached**, and the native telemetry queue was empty. Tool results included `exec_command`, `check_policy`, `get_run_id`, `codegraph_explore` and outer `exec` wrappers. Input/output token counts were present. Counts are a point-in-time snapshot, not final session totals or billing figures.

The native session ID remained the same across the desktop restart/resume. The Coodra `get_run_id` MCP call returned the original Run created on 17 November, and telemetry linked to that exact Run. The pre-restart baseline contained zero Codex events for this session; the new receipt timestamps establish desktop delivery rather than reuse of earlier CLI fixtures. Snapshot: `/private/tmp/coodra-desktop-telemetry-verified.json`.

**Hook boundary:** there were zero `pre`/`post` rows for this Run. User configuration enables `coodra@coodra`; the cached plugin contains PreToolUse/PostToolUse definitions matching `Bash|apply_patch|Edit|Write|mcp__.*`, but their presence does not establish runtime execution. The root cause (loading, trust, invocation or delivery) is not established. Desktop hook-versus-telemetry reconciliation therefore remains unverified. The isolated CLI paired tests remain valid and distinct. Do not mark desktop hooks healthy or treat `mcp_call` instrumentation as a native hook substitute.

**Still to verify:** desktop hook execution/delivery, normal shutdown flush and another resume cycle with active capture. This run establishes one restart/resume identity check, not flush completeness. No desktop hook policy/trust settings were changed to force execution.

**Configuration state:** the temporary OTel block remains enabled, sending to the local `coodra` project endpoint. It is a user-level fixed-project exporter, so it should be removed or reconfigured before using it to attribute another project's sessions. Roll back by removing only the block between `BEGIN COODRA DESKTOP CAPTURE VERIFICATION` and its matching END marker from `~/.codex/config.toml`, then restart. This preserves intervening config edits. The full private backup remains available if no later edits need preserving.

The installed daemon was not redeployed during these checks; working-tree reconciliation/UI changes require a later normal build/install. OpenAI documents user-level telemetry configuration and desktop OTel support: [advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#observability-and-telemetry), [managed desktop support](https://learn.chatgpt.com/docs/enterprise/managed-configuration#enforce-opentelemetry-settings).

## Exporter behaviour (Claude Code 2.1.330, `-p` mode, local sink)

- **Flush at exit.** With a 60 second export interval a short session still delivered everything (61 records, including the final hook and MCP events) in one batch as the process exited.
- **Retry.** When the receiver answered 503 twice, the exporter resent the same 37-record batch after about 1 s and 1.5 s and succeeded; later batches followed. Retries resend identical records, which the replay identity makes harmless.
- **Signals.** `SIGINT` flushed the pending batch (48 records); `SIGKILL` lost the whole pending batch (nothing delivered). Telemetry is best effort across crashes and force-kills, consistent with the limitation stated above.
- Managed-settings effects were not tested (they need an administrator-managed environment).

## Reconciliation

`reconcileToolOperations` (shared package, pure, no I/O or clock) compares the tool operations Coodra's hooks recorded with the harness-specific tool-result telemetry rows for the same session.

**Join key.** One native tool-use id. Harness hook rows are stored with `tool_use_id = lifecycle_event:<harness>:<session>:<Event>:<tool>:<native id>`; the native id is the final segment (`nativeToolUseIdFromHookKey`, which returns null for any key that does not have that exact shape). Telemetry carries the native id in `tool_use_id`. Session or time proximity never produces a match. An operation with no usable id is reported as not comparable with a reason; it is never merged into another.

**Inputs.** Hook side: `run_events` rows with `phase` `pre` or `post` for the Run (the `mcp_call` phase is Coodra's own MCP instrumentation and is excluded). Telemetry side: `tool_result` rows for the project and session, attached or not. Plus: the count of all telemetry events for the session, whether a Run exists, whether the Run ended, and the current time.

**Statuses**

| Status | Meaning |
| --- | --- |
| `matched` | Both channels saw the operation. Agreement is reported separately |
| `hook_only` | Hooks saw it, no telemetry result, and the grace window (120 s) has passed or the Run ended |
| `telemetry_only` | Telemetry saw it, no hook records, and the grace window has passed (or there is no Run) |
| `awaiting_arrival` | One side is missing but still inside the grace window and the Run is still open |
| `not_comparable` | Reasons: `hook_key_without_native_id`, `telemetry_without_tool_use_id`, `telemetry_channel_not_observed` (the session has hook rows but no telemetry at all, so it is a missing channel, not a disagreement), `harness_telemetry_unsupported` (unsupported harness), `harness_id_scheme_unverified` (unmatched Codex tools outside verified coverage), `codex_outer_tool_without_hook` (Codex outer wrapper), `codex_poll_without_hook` (command polling) |

**Disagreements on matched operations.** `post_hook_missing` (telemetry says success, hooks have a PreToolUse and no PostToolUse), `post_hook_after_failure` (Claude Code only: telemetry says failure, a PostToolUse was recorded), `pre_hook_missing` (PostToolUse without a PreToolUse). A failed tool with only a PreToolUse hook is consistent, not a disagreement. If telemetry did not report `success`, no status check is made. A tool-name difference between channels is shown as information and not counted as disagreement. Repeated telemetry rows for one id are kept visible as occurrences, not collapsed.

**Limitations always shown with a result.** Native export is best effort, so a missing telemetry row is not proof the operation did not run; hooks record policy outcomes, not execution results, so execution status comes only from telemetry; sessions with no Run have nothing to compare against; sessions with no telemetry suggest the channel is disabled or unreachable; and hook rows without a native id are listed separately.

**Evidence.** Each reconciled operation carries the contributing `run_events.id` values and the `native_telemetry_events.id`, shown on the session page.

**Known gaps.** Claude Code fires a `PostToolUseFailure` hook for a failed tool (seen in live telemetry as a `hook_execution_complete` for `PostToolUseFailure`), but Coodra's recorded hook rows only have `pre` and `post` phases, so a failed tool normally shows only a PreToolUse; that is treated as consistent with `success = false`, and it also means Coodra records no failure event of its own. In real data about 220 of roughly 9,600 PreToolUse rows have no PostToolUse, which is the kind of disagreement this view is meant to surface once live paired sessions exist. Grace window and the hook-row read limit (50,000 per Run) are engineering defaults, not measured values.

## Agent telemetry page

Left navigation entry **Agent telemetry** (`/telemetry`), shown in the Workspace group after Memory and hidden on a hosted team server. It is distinct from **Memory**, which reports what Coodra surfaced.

- **Overview:** events received (total and last 24 hours, newest receipt), harness and version, model requests and tokens, estimated cost (shown as "unavailable", never $0, when no request reported one), and collection health (queued and dead-lettered jobs, sessions without a Run).
- **Capture verification:** counts of matched, hook-only, telemetry-only, awaiting-arrival and not-comparable operations across the 40 most recent sessions that have a Run, with channel disagreements called out.
- **Sessions:** attached and unattached, linking to the known Run and to the session page.
- **Coverage:** what each harness collects, which versions it was verified on, and what is not verified or not collected (including the verified Codex inner exec profile and unverified tool families).
- **Session page** (`/telemetry/<projectId>/<sessionId>`): usage by model, the operation-level reconciliation table with reasons and evidence references, hook health, MCP connections, queue state and the newest 300 evidence rows.
- **Run page panel.** Each Run page (`/runs/<id>`) shows a strip between the summary and the event list: operations by status with disagreement count, model requests with tokens and estimated cost, hook errors reported by the harness, queued and dead-lettered jobs, and links to the session page and raw events. It appears only on machines that have received telemetry at all, and says so when this particular Run has none. It reads the Run's own project and session, so a Codex Run shows Codex totals.
- On a Postgres (team-hosted) handle both pages say telemetry is local rather than showing an empty result.

## Raw events view

`/telemetry/events`, reachable from the Agent telemetry page ("Raw events") and from each session page ("open in raw events"). It is the closest thing to a log explorer: every accepted event, newest first, with nothing aggregated.

- **Rows.** Collapsed: source time, event badge (highlighted when it is a problem), a one-line summary, duration, short session id, and an `unattached` marker when no Run exists. Expanded: row id, event, harness and source, project, session (links to the session page), Run (link, or the unattached explanation), source time in ISO and nanoseconds, receipt time and its lag after the source time, cost kind, content policy, every stored typed column that has a value, and the full allowlisted attribute set as pretty-printed JSON.
- **Filters** (a plain GET form, so a filtered view is a shareable URL): event type (with counts), time range (15 minutes, 1 hour, 24 hours, 7 days or all), a text search over tool name, tool-use id, request id, model, hook event and row id, a session id, and "problems only". Problems are failed tools, API errors, hook errors, blocking or cancelled hooks, and MCP connections that are not `connected`. The search escapes `%`, `_` and `\`, so it matches literally.
- **Paging.** The newest 100 by default, doubling with "Show more" up to 500 per page; the matching total is always shown. Older events need narrower filters.
- **Live tail.** A toggle that re-renders the server page every 3 seconds while enabled (`?live=1`). It is polling, not streaming, so each refresh is a fresh read of the local database.
- **What it does not show.** The raw OTLP request bodies are not stored, so prompts, tool inputs and outputs, error text and account attributes cannot be shown; the attribute JSON is the allowlisted subset only. There are no traces or span waterfalls (only logs are ingested) and no SQL box; use SQLite directly for ad hoc queries.
- On a Postgres (team-hosted) handle it reports that telemetry is local, as the other pages do.

## Readback

Use Agent telemetry, the Run-view panel or SQL. `coodra telemetry` configures and diagnoses collection.

```sql
SELECT event_name, tool_name, tool_use_id, success, model,
       input_tokens, output_tokens, cache_read_tokens, cost_usd_micros, cost_kind
FROM native_telemetry_events
WHERE run_id = :run
ORDER BY source_time_ms;
```

Hook-versus-telemetry comparison is implemented within the Run/session and harness, joining the native ID extracted from hook keys to telemetry `tool_use_id`. Coodra hook health, for example:

```sql
SELECT hook_event, count(*) AS runs, sum(hook_error_count) AS errors, sum(hook_blocking_count) AS blocking,
       avg(duration_ms) AS avg_ms, max(duration_ms) AS max_ms
FROM native_telemetry_events
WHERE event_name = 'claude_code.hook_execution_complete'
GROUP BY hook_event;
```

Limits of these two events: the harness reports `hook_execution_complete` per hook **event** (counts across all hooks registered for it, Coodra's and others'), so it measures the combined hook chain, not Coodra's hook alone; `mcp_server_connection` does not name the server (only `server_scope`, `transport_type` and, for plugin servers, an opaque `plugin_id_hash`), so attributing a connection to Coodra needs a known hash, which is not established. Neither reports Coodra-side persistence; that is what the later hook reconciliation is for.

## Validation

Run these to reproduce:

```sh
pnpm --filter @coodra/db exec vitest run                     # 175 unit tests (parity, table list/count)
pnpm --filter @coodra/db exec vitest run --config vitest.integration.config.ts __tests__/integration/delete-project.test.ts
pnpm --filter @coodra/cli exec vitest run __tests__/unit/outbox
pnpm --filter @coodra/mcp-server exec vitest run --config vitest.integration.config.ts   # 49 files, 367 tests
```

Results at revision 7: shared unit 452 passed; web-v2 unit 85 passed (using an in-memory database); cli unit 659 passed (including 10 for `coodra telemetry`); db unit 175 passed; delete-project integration 5 passed (stamped and unstamped queued jobs, and an unattached row); outbox unit 24 passed; mcp-server integration 381 passed (49 files, including the 28 in `native-telemetry.test.ts`, which cover the Codex adapter); `check:migration-lock` ok; `tsc` clean for db, cli, mcp-server and web-v2; biome clean on touched packages. Postgres was verified against a throwaway `pgvector/pgvector:pg16` container (Docker, port 55432, removed afterwards): all Postgres migrations through `0045` applied cleanly (97 of 97 integration tests, new columns present); `insertNativeTelemetryEvent` round-trips typed values (`bigint` source time, boolean `success`, null cost) and an exact replay is a no-op; a non-existent Run id raises the foreign-key error (`23503`); a NULL `run_id` is accepted; deleting a Run sets `run_id` to NULL; `deleteProject` on Postgres (verified at revision 2.1) removes the project's telemetry and queued jobs. The full db integration suite run with `DATABASE_URL` set passes (97 of 97). It initially had one failure, `postgres-migrate.test.ts > creates the canonical migration table set`, which pre-dated this work: its `SCHEMA_TABLES` list was out of query order (`run_events` before `run_diffs`). That list is now alphabetical (with a comment saying it must stay so) and includes `native_telemetry_events`. This verifies the schema and write path on Postgres only; no runtime code writes telemetry to Postgres (see Architecture).

`native-telemetry.test.ts` uses real loopback HTTP, in-memory SQLite and the production outbox dispatcher. It covers: content removal before queueing and in the table; typed columns and cost micros; separation of tool `success` from any policy verdict; hook `run_events` untouched; exact replay; source-time ordering and repeated sequence numbers; unavailable and mismatched Run identity; partial rejection; enqueue failure not acknowledged as accepted; opt-in endpoint, Origin, protocol and size limits; capacity bound and replay at capacity; retention of rows and queue payloads; 24-hour expiry for unattached rows versus seven days for attached; `run_id` set to NULL when a Run is deleted; missing Run kept unattached without creating a Run and without claiming a Run of another harness; late attachment on `insertRun` without duplicates; attachment at dispatch; separate unattached capacity; hook execution metadata arriving before the Run exists and attaching when the Run is created; MCP connection metadata without server or plugin names; other hook and plugin lifecycle events still rejected; malformed queued job dead-lettered without a partial row; queue rows stamped with project and run; rev-1 backfill by running migration `0042`; legacy queued `run_event` job rerouted.

Revision 7 live runs: a real Claude Code 2.1.330 session against the **installed daemon** on port 3100 stored 32 events (tool results with success and failure, API requests, hook completions including `PostToolUseFailure` and `Stop`, MCP connections), all unattached because `-p` mode does not run Coodra's plugin hooks (the test rows were deleted afterwards); a real `codex exec` against an isolated daemon stored 7 events with no tool arguments, output or email in any column. Live validation (logs only, isolated daemon with its own `COODRA_HOME`). Revision 3 run on Claude Code 2.1.330 with a project but **no Run** for the session: the successful and failing `Read` and both `api_request` events (4 rows) were stored with `run_id` NULL, and no Run was created. Revision 4 run on 2.1.330 (no Run seeded): `hook_execution_complete` was captured for `SessionStart` (1 hook, 0 success, 1 non-blocking error, 2 ms, because the Coodra plugin MCP server was unavailable in `-p` mode) and `UserPromptSubmit` (2 hooks, 2 success, 116 ms), and 12 `mcp_server_connection` rows (connected, plus 2 `failed` over `http`), all stored unattached. No `SessionEnd` hook completion was exported, so end-of-session flushing is still unverified. Earlier runs below used a seeded Run:
- **Claude Code 2.1.325 (rev 1, `run_events`):** a real 35-record startup export was accepted, with 34 records rejected as unsupported and the `api_error` persisted.
- **Claude Code 2.1.330 (rev 2, `native_telemetry_events`):** one successful and one failing `Read` produced 2 `tool_result` rows (`success` 1 and 0, distinct `tool_use_id`) and 2 `api_request` rows with model, token counts, `cost_usd_micros` and `cost_kind = provider_estimate`. Every row had `content_policy = excluded`, `run_events` stayed empty, and `pending_jobs` drained.
- Real OTLP attributes arrive typed (integers as JSON numbers); the receiver also handles the string-valued attributes used in fixtures.

Installed daemon (`/opt/homebrew/.../@coodra/cli`, 0.5.14 base): runtime `mcp-server/index.js` and `drizzle/` were replaced with the revision 4 build; the daemon migrated at boot (`0041` to `0044`) and the telemetry route returns 200. Migration `0043` was also applied to a copy of the real database before deploy. The installed database held no rev-1 telemetry rows, so the backfill was exercised on a copy, not on live data. **No live Claude session has been run against the installed daemon**, so end-to-end there is unverified. Backups: `~/.coodra/backup-pre-telemetry/` (rev 1), `~/.coodra/backup-pre-telemetry-table/` (pre-rev-2) and `~/.coodra/backup-pre-telemetry-fix/` (pre-2.1) `~/.coodra/backup-pre-unattached/` (pre-3) and `~/.coodra/backup-pre-hook-events/` (pre-4 `index.js`, `drizzle/`, `data.db`).

Not yet verified: comparison against hook events from the same session; shutdown flushing and loss on interruption; managed-setting effects; exporter retry behaviour; any CLI version other than 2.1.325 and 2.1.330.

## Reviewer checklist

1. Confirm no code path writes telemetry to `run_events` (`grep -n run_events apps/mcp-server/src/lib/native-telemetry.ts` should show nothing).
2. Confirm the two migrations create only `native_telemetry_events` and its three indexes, and that `schema-parity.test.ts` covers both dialects.
3. Confirm `content` never reaches the queue or table: check `safeAttributes` against `IDENTIFIERS` and `NUMBERS`, and the `PRIVATE_` assertions in the test.
4. Confirm `native_telemetry` is in `AUDIT_QUEUE_KINDS` and has a dispatcher branch; a queue without a branch would dead-letter.
5. Confirm `DEPENDENT_PROJECT_TABLES` includes the table and the delete-project test inserts a row.
6. Confirm replay identity excludes `receivedAt` and that capacity and retention count the new table and the `native_telemetry` queue.
7. Confirm the upgrade path: read `0042_backfill_native_telemetry.sql`, the `legacyTelemetryRow` reroute in `dispatcher.ts`, and the two upgrade tests; confirm queue rows carry `project_id`/`run_id` and that `deleteProject` clears unstamped `native_telemetry` jobs.
8. Confirm Run-optional behaviour: `run_id` nullable with `SET NULL` in both dialects and migrations `0043`/`0044`; the receiver no longer throws for a missing Run; identity excludes `runId`; `attachNativeTelemetryToRun` is called from `insertRun` and from the dispatcher; unattached rows expire at 24 hours and have their own cap.
9. Confirm reconciliation: read `telemetry-reconciliation.ts` and its tests; check that no status is derived from time or session proximity, that a missing telemetry channel is `not_comparable` rather than `hook_only`, and that cost is `unavailable` (null), never zero, in `queries/telemetry.ts`.
10. Confirm there is no sync path: no `sync_to_cloud` job is enqueued and `SyncTableName` does not list the table.

## Open design question: long-term storage in Postgres

Proposal under discussion: keep SQLite as the short-lived local buffer (7 days) and add an exporter or sync path so team-mode Postgres holds telemetry for 30 days or more, because the purpose is to validate Coodra's own performance (hook calls, context delivery) over time. Not implemented. Notes so far:
- The existing shape already fits: the local outbox is the durable, offline-tolerant buffer and a sync dispatcher would push rows to Postgres. Writing straight to Postgres from the receiver would put a network dependency on the hot path and lose data when offline.
- Needs before building: the receiver enabled outside solo mode with its own auth decision; actor identity on rows (Epic 1); a Postgres-side retention job; a Postgres row budget based on measured volume.
- The 10,000-row local cap is likely too small for this purpose and should be replaced by a measured, time-based budget.
- For validating Coodra itself, hook execution and MCP connection events were added in revision 4 (see above); they describe the combined hook chain and an unnamed server, so Coodra-specific attribution still needs reconciliation with Coodra's own hook records.
- Raw rows versus daily rollups for long retention is undecided; `memory_access_events` is the precedent (raw stays local, rollups sync).

## Out of scope and remaining work

- **Postgres sync and long-term storage.** Design only; needs a decision (see the open question above): sync raw rows or rollups, receiver outside solo mode, actor identity (Epic 1), a Postgres-side retention job. Not implemented.
- **MCP attribution.** `mcp_server_connection` does not name the server. In one capture the plugin that has both hooks and an MCP server and is the only third-party plugin installed carried the same `plugin_id_hash` as the connecting plugin server, so it is probably Coodra's, but the harness does not say so and the hash algorithm is unknown (sha256, sha1 and md5 of `coodra@coodra` did not match), so no attribution is claimed or stored.
- **Additional Codex tool families, remote MCP and desktop capture** beyond the verified CLI exec/patch/local-MCP profiles; desktop export is verified; desktop native-hook execution and shutdown flush remain unresolved (revision 9).
- **Live hook-versus-telemetry comparison on one Claude Code session.** `-p` mode does not run Coodra's plugin hooks, so a paired session needs an interactive launch with the exports from `coodra telemetry env`.
- **Web deploy.** The installed web dashboard on port 3001 does not yet include the Agent telemetry pages; the dev build does.
- OTLP protobuf and gRPC; metrics and traces; managed-settings effects; checkpoint authoring, Stop enforcement, semantic coverage validation and Decision authority changes. Absent telemetry is not proof that no operation occurred: native export can drop data before Coodra receives it, and a hook response or Run completion cannot establish durable acceptance or checkpoint success on its own.
