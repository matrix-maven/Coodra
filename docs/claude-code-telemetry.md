# Native telemetry: COOD-105 (implementation reference)

Status: implemented on branch `codex/cood-105-telemetry`. Revision 2 moved telemetry out of `run_events` into its own table, `native_telemetry_events`; revision 2.1 fixed two issues found in independent review (upgrade path and queued-job ownership); revision 3 makes the Run optional so evidence is kept even when hooks never created one; revision 4 adds Coodra hook and MCP-server health events. This document is the implementation reference and the review checklist for an independent validator (see [Reviewer checklist](#reviewer-checklist)).

The shared envelope carries a `harness` discriminator for Claude Code and Codex. Only the Claude Code OTLP logs adapter exists. Codex needs its own adapter with its own documented signals and verified fixtures; it is not accepted as Claude Code data.

| Surface | Status |
| --- | --- |
| Claude Code OTLP HTTP/JSON logs | Verified live: `tool_result` (success and failure), `api_request`, `api_error` |
| Codex telemetry | Adapter not implemented; do not assume Claude event names or fields |
| OTLP protobuf, gRPC, metrics, traces | Not implemented |
| Hook vs telemetry reconciliation, checkpoint coverage, Run-view panel | Not implemented; collecting data establishes none of them |

## Change history

| Rev | Change |
| --- | --- |
| 1 (`279abd4`) | Receiver, allowlist, replay identity, retention. Stored in `run_events` with `phase = 'telemetry'`. No schema change |
| 2 | **New table `native_telemetry_events`** (SQLite + Postgres schema, migrations `sqlite/0041`, `postgres/0043`), new outbox queue `native_telemetry`, dispatcher branch, `insertNativeTelemetryEvent`, project-delete wiring, tests. Receiver and retention moved to the new table. The ROI query filter added in rev 1 was reverted because `run_events` no longer holds telemetry |
| 4 | **Hook and MCP events.** Two more events are accepted: `claude_code.hook_execution_complete` and `claude_code.mcp_server_connection`. New nullable typed columns (SQLite `0044`, Postgres `0045`, `ADD COLUMN` only): `hook_event`, `hook_name`, `hook_count`, `hook_success_count`, `hook_blocking_count`, `hook_error_count`, `hook_cancelled_count`, `connection_status`, `transport_type`, `server_scope`, `plugin_id_hash`. Purpose: measure Coodra's own hooks and MCP server as Claude Code observed them (outcome counts, duration, connection health) |
| 3 | **Run is optional.** `run_id` is nullable with `ON DELETE SET NULL` (SQLite migration `0043` rebuilds the table, Postgres `0044` drops NOT NULL), plus index `native_telemetry_events_session_idx (project_id, session_id)`. The receiver no longer returns 503 for a missing Run: it stores the row unattached. Replay identity no longer includes the Run. Unattached rows are attached when a Run appears (at dispatch, or when `insertRun` creates it). Unattached evidence expires after 24 hours and has its own capacity budget (2,000) |
| 2.1 | **Upgrade path:** SQLite migration `0042_backfill_native_telemetry.sql` copies rev-1 `run_events` telemetry rows into the new table (id and receipt time preserved) and deletes the legacy rows; the outbox dispatcher reroutes still-queued rev-1 `run_event` telemetry jobs to the new table; retention and capacity now match `native_telemetry_*` ids regardless of queue. **Deletion:** queue rows are stamped with `project_id`/`run_id` (`scheduleDurableWrite` gained optional `orgId`/`projectId`/`runId`), and project delete also removes `native_telemetry` jobs by payload `projectId`, so no job outlives its project |

Why separate: `run_events` is the hook/MCP audit trail read by ~40 files (sync daemon, dashboards, ROI, run-diff, auto-context-pack, doctor, team-migrate). Telemetry has a different clock, wants typed and indexed numeric fields for reconciliation and cost rollups, needs time-based retention, and must be removed with its Run. Mixing them risked silent leakage into every `run_events` reader.

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
| `harness` | text | text | no | `claude_code` today; `codex` reserved |
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
- `runs` (read): exact match on `project_id`, `session_id` (native `session.id`) and `agent_type = 'claude_code'`, backed by `runs_project_session_idx`. Coodra never creates a Run from telemetry and never binds by time, cwd or MCP transport session. A Run of a different harness for the same session is not claimed.
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

**Run resolution and attachment:** exact project + native session + `claude_code`.
- Run found at receipt: `run_id` is set.
- No Run: the record is accepted (200) and stored unattached (`run_id` NULL). No Run is created and nothing is retried against the exporter. It is attached later by `attachNativeTelemetryToRun`, which runs (a) in the dispatcher when a still-unattached job is written, and (b) inside `insertRun` when a Run is created for that project, session and harness. Both are idempotent, never overwrite an existing association, and match the harness.
- Because the Run is not part of replay identity, the same event is one row whether or not a Run existed when it arrived.

Association by this join establishes record linkage, not authentication of the native producer. Dropping the previous "Run must exist" check makes forged unattached rows cheaper (any loopback client can submit a session ID), which is why unattached evidence is short-lived and separately bounded.

**Admission:** requests are serialised. The receiver counts distinct retained identities across `native_telemetry_events` and queued jobs; above 10,000 it returns 503 `telemetry_capacity_exceeded`, and above 2,000 unattached identities it returns 503 `telemetry_unattached_capacity_exceeded`, rather than deleting recent evidence. Replays of identities already counted do not consume budget.

**Write:** each accepted record goes through `scheduleDurableWrite` on queue `native_telemetry`, then the outbox worker is kicked.

### Replay identity
`id = native_telemetry_ + sha256(JSON(observation without receivedAt))`, covering project, Run, session, event name, source nanosecond time, the allowlisted attributes, `content` and `costKind`. Exact replays collapse to one row; repeated `event.sequence` values after a resume do not collide because source time differs. Two events with identical metadata at the exact same nanosecond are indistinguishable. This is not a complete source ledger.

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
- 10,000 distinct retained identities (and 2,000 unattached) are initial engineering budgets, not measured recommendations. A heavy user's API requests and tool calls could exceed 10,000 within seven days; revisit with real volume before relying on the cap for long-running sessions.
- Retention removes evidence; it does not establish successful capture or semantic coverage.

## Setup

Telemetry is opt-in.

### Daemon
The daemon process needs `COODRA_TELEMETRY_ENABLED=1`. For a repository dev instance on a free port (never start a second daemon over an existing listener):

```sh
COODRA_TELEMETRY_ENABLED=1 COODRA_MODE=solo MCP_SERVER_HOST=127.0.0.1 MCP_SERVER_PORT=4318 \
  pnpm --filter @coodra/mcp-server exec tsx src/index.ts --transport http
```

For the installed launchd daemon (macOS), add the variable to `~/Library/LaunchAgents/com.coodra.mcp-server.plist` under `EnvironmentVariables` and reload with `launchctl bootout` then `launchctl bootstrap` (`kickstart -k` does not re-read the plist). `coodra start` or a reinstall may regenerate the plist and drop the variable. There is no CLI flag for this yet. The migration is applied by the daemon at boot from `COODRA_MIGRATIONS_DIR`, so the installed `drizzle/` directory must contain `0041_overconfident_mongu.sql` and its journal entry.

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

## Readback

Query the table directly; there is no Run-view panel or CLI command yet.

```sql
SELECT event_name, tool_name, tool_use_id, success, model,
       input_tokens, output_tokens, cache_read_tokens, cost_usd_micros, cost_kind
FROM native_telemetry_events
WHERE run_id = :run
ORDER BY source_time_ms;
```

Hook-versus-telemetry comparison will join on `(run_id, tool_use_id)`; that join is not implemented. Coodra hook health, for example:

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

Results at revision 4: db unit 175 passed; delete-project integration 5 passed (stamped and unstamped queued jobs, and an unattached row); outbox unit 24 passed; mcp-server integration 374 passed (49 files, including the 21 in `native-telemetry.test.ts`); `check:migration-lock` ok; `tsc` clean for db, cli, mcp-server and web-v2; biome clean on touched packages. Postgres was verified against a throwaway `pgvector/pgvector:pg16` container (Docker, port 55432, removed afterwards): all Postgres migrations through `0045` applied cleanly (97 of 97 integration tests, new columns present); `insertNativeTelemetryEvent` round-trips typed values (`bigint` source time, boolean `success`, null cost) and an exact replay is a no-op; a non-existent Run id raises the foreign-key error (`23503`); a NULL `run_id` is accepted; deleting a Run sets `run_id` to NULL; `deleteProject` on Postgres (verified at revision 2.1) removes the project's telemetry and queued jobs. The full db integration suite run with `DATABASE_URL` set passes (97 of 97). It initially had one failure, `postgres-migrate.test.ts > creates the canonical migration table set`, which pre-dated this work: its `SCHEMA_TABLES` list was out of query order (`run_events` before `run_diffs`). That list is now alphabetical (with a comment saying it must stay so) and includes `native_telemetry_events`. This verifies the schema and write path on Postgres only; no runtime code writes telemetry to Postgres (see Architecture).

`native-telemetry.test.ts` uses real loopback HTTP, in-memory SQLite and the production outbox dispatcher. It covers: content removal before queueing and in the table; typed columns and cost micros; separation of tool `success` from any policy verdict; hook `run_events` untouched; exact replay; source-time ordering and repeated sequence numbers; unavailable and mismatched Run identity; partial rejection; enqueue failure not acknowledged as accepted; opt-in endpoint, Origin, protocol and size limits; capacity bound and replay at capacity; retention of rows and queue payloads; 24-hour expiry for unattached rows versus seven days for attached; `run_id` set to NULL when a Run is deleted; missing Run kept unattached without creating a Run and without claiming a Run of another harness; late attachment on `insertRun` without duplicates; attachment at dispatch; separate unattached capacity; hook execution metadata arriving before the Run exists and attaching when the Run is created; MCP connection metadata without server or plugin names; other hook and plugin lifecycle events still rejected; malformed queued job dead-lettered without a partial row; queue rows stamped with project and run; rev-1 backfill by running migration `0042`; legacy queued `run_event` job rerouted.

Live validation (logs only, isolated daemon with its own `COODRA_HOME`). Revision 3 run on Claude Code 2.1.330 with a project but **no Run** for the session: the successful and failing `Read` and both `api_request` events (4 rows) were stored with `run_id` NULL, and no Run was created. Revision 4 run on 2.1.330 (no Run seeded): `hook_execution_complete` was captured for `SessionStart` (1 hook, 0 success, 1 non-blocking error, 2 ms, because the Coodra plugin MCP server was unavailable in `-p` mode) and `UserPromptSubmit` (2 hooks, 2 success, 116 ms), and 12 `mcp_server_connection` rows (connected, plus 2 `failed` over `http`), all stored unattached. No `SessionEnd` hook completion was exported, so end-of-session flushing is still unverified. Earlier runs below used a seeded Run:
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
9. Confirm there is no sync path: no `sync_to_cloud` job is enqueued and `SyncTableName` does not list the table.

## Open design question: long-term storage in Postgres

Proposal under discussion: keep SQLite as the short-lived local buffer (7 days) and add an exporter or sync path so team-mode Postgres holds telemetry for 30 days or more, because the purpose is to validate Coodra's own performance (hook calls, context delivery) over time. Not implemented. Notes so far:
- The existing shape already fits: the local outbox is the durable, offline-tolerant buffer and a sync dispatcher would push rows to Postgres. Writing straight to Postgres from the receiver would put a network dependency on the hot path and lose data when offline.
- Needs before building: the receiver enabled outside solo mode with its own auth decision; actor identity on rows (Epic 1); a Postgres-side retention job; a Postgres row budget based on measured volume.
- The 10,000-row local cap is likely too small for this purpose and should be replaced by a measured, time-based budget.
- For validating Coodra itself, hook execution and MCP connection events were added in revision 4 (see above); they describe the combined hook chain and an unnamed server, so Coodra-specific attribution still needs reconciliation with Coodra's own hook records.
- Raw rows versus daily rollups for long retention is undecided; `memory_access_events` is the precedent (raw stays local, rollups sync).

## Out of scope and remaining work

Postgres runtime use (sync or long-term storage of this table) is not implemented and is under discussion: see the Postgres note in this document's history of decisions below.

Codex adapter; OTLP protobuf and gRPC; metrics and traces; hook-versus-telemetry reconciliation (`matched`, `hook-only`, `telemetry-only`, `awaiting arrival`, `not comparable`); a Run-view panel for evidence, queue state and correlation limits; CLI support for enabling the receiver; Postgres export; automatic checkpoint authoring, Stop enforcement, semantic coverage validation and Decision authority changes. Absent telemetry is not proof that no operation occurred: native export can drop data before Coodra receives it, and a hook response or Run completion cannot establish durable acceptance or checkpoint success on its own.
