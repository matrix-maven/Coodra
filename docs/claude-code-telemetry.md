# Native telemetry: COOD-105 (implementation reference)

Status: implemented on branch `codex/cood-105-telemetry`. Revision 2 moved telemetry out of `run_events` into its own table, `native_telemetry_events`. This document is the implementation reference and the review checklist for an independent validator (see [Reviewer checklist](#reviewer-checklist)).

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
| `apps/mcp-server/__tests__/integration/lib/native-telemetry.test.ts` | 11 integration tests |
| `packages/db/__tests__/unit/schema-parity.test.ts`, `unit/client.test.ts`, `integration/delete-project.test.ts` | Parity, table list and count, delete coverage |

## Database

### New table: `native_telemetry_events`
Append-only, local-only (no `sync_to_cloud` job, so nothing reaches Postgres at runtime; the Postgres schema exists for dialect parity). `id` is a replay-identity hash, so an exact replay or outbox retry is `ON CONFLICT DO NOTHING`.

| Column | SQLite | Postgres | Null | Notes |
| --- | --- | --- | --- | --- |
| `id` | text PK | text PK | no | `native_telemetry_<sha256>` (see Replay identity) |
| `org_id` | text | text | yes | Unused in solo |
| `project_id` | text FK `projects.id` | same | no | |
| `run_id` | text FK `runs.id` **ON DELETE CASCADE** | same | no | Telemetry is removed with its Run |
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

Indexes: `native_telemetry_events_run_time_idx (run_id, source_time_ms)`, `native_telemetry_events_run_tool_idx (run_id, tool_use_id)`, `native_telemetry_events_received_idx (received_at)` (retention).

### Existing tables used
- `projects` (read): slug lookup via `lookupProjectBySlug`; unknown slug returns 404.
- `runs` (read): exact match on `project_id`, `session_id` (native `session.id`) and `agent_type = 'claude_code'`, backed by `runs_project_session_idx`. Coodra never creates a Run from telemetry and never binds by time, cwd or MCP transport session.
- `pending_jobs` (write, transient): durable outbox, `queue = 'native_telemetry'`, `id = native_telemetry_<sha256>`, payload `NativeTelemetryPayloadV1`. Dead-lettered jobs stay visible here until retention removes them.

### Not used
`run_events` is **not** written by this feature. Hook and MCP activity there is unchanged, and no `run_events` reader needs a telemetry filter.

## Queue payload and dispatch

`NativeTelemetryPayloadV1` carries the typed columns above plus `rowId`, `receivedAt` (ISO) and `attributesJson`. The dispatcher validates the required fields (`rowId`, `projectId`, `runId`, `harness`, `source`, `eventName`, `sourceTimeUnixNano`, `sourceTimeMs`, `sessionId`, `costKind`, `attributesJson`, a parseable `receivedAt`); a malformed payload is a permanent failure and the job is dead-lettered with no partial row. Optional fields degrade to null individually. A foreign-key failure (Run missing) throws and is retried by the worker as transient.

## Accepted events and allowlist

Only three events are kept; every other record is counted as rejected.

| Event | Meaning |
| --- | --- |
| `claude_code.tool_result` | A tool call finished; carries `success`, timing and size metadata |
| `claude_code.api_request` | A model request; carries model, token counts, timing, cost estimate |
| `claude_code.api_error` | A failed model request; carries model, status, attempt, timing (no error text) |

Allowlisted identifiers (strings, max 256 chars, no control characters): `session.id`, `app.version`, `tool_use_id`, `request_id`, `client_request_id`, `prompt.id`, `agent_id`, `parent_agent_id`, `model`, `tool_name`.

Allowlisted numbers (non-negative, finite; JSON numbers or numeric strings): `event.sequence`, `duration_ms`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`, `cost_usd_micros`, `attempt`, `status_code`, `tool_input_size_bytes`, `tool_result_size_bytes`. Boolean: `success`.

Everything else is dropped before the queue: the OTLP body, prompts and `prompt_text`, tool inputs and results, free-text `error`, `user.email`, `user.id`, account and organization IDs. Missing fields stay null.

### Events that are rejected
Seen in a real startup export: `hook_registered`, `mcp_server_connection`, `plugin_loaded`, `hook_execution_start`, `hook_execution_complete`, `managed_settings_resolved`, `user_prompt`. A record is also rejected when its session ID is missing, or its source time is older than seven days or more than five minutes in the future. Rejections are reported through OTLP `partialSuccess`.

## Receiver behaviour

**Route:** `POST /telemetry/claude_code/<project-slug>/v1/logs`, enabled only when `COODRA_TELEMETRY_ENABLED=1` and `COODRA_MODE=solo`; otherwise 404.

**Checks, in order:** loopback peer and no `Origin` header (403 `local_telemetry_only`); POST (405); `Content-Type: application/json` with no `Content-Encoding` (415); the transport auth layer; JSON body up to 1 MiB.

**Parsing:** OTLP/JSON `resourceLogs[].scopeLogs[].logRecords[]`, at most 32 × 32 groups and 256 records per export. Attribute values come from `stringValue`, `boolValue`, `intValue` or `doubleValue`; resource attributes are merged beneath record attributes. The event name comes from the record `eventName`, else the body string, else `event.name`, normalised to the `claude_code.` prefix.

**Run resolution:** exact project + native session + `claude_code`. A missing Run returns 503 `run_not_available_retry` so exporter retries can bridge a late Run. A validated database join establishes record association, not authentication of the native producer.

**Admission:** requests are serialised. The receiver counts distinct retained identities across `native_telemetry_events` and queued `native_telemetry` jobs; above 10,000 it returns 503 `telemetry_capacity_exceeded` rather than deleting recent evidence.

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
| 503 | Run not found yet, capacity exceeded, or storage failure; sent with `Retry-After: 5`. A failed batch can have earlier durable writes; replaying the full batch is safe |

## Retention, deletion and limits

- Rows and queue payloads expire seven days after receipt: `pruneNativeTelemetry` deletes `native_telemetry_events` where `received_at` is older than the cutoff and `pending_jobs` where `queue = 'native_telemetry'` and `created_at` is older, including dead letters. No other rows are touched.
- The enabled daemon prunes on boot and hourly, logging `native_telemetry_retention` (with the count) or `native_telemetry_retention_failed`.
- Deleting a Run cascades to its telemetry. Deleting a project removes its telemetry in the dependent-tables phase of `deleteProject` (`native_telemetry_events` is in `DEPENDENT_PROJECT_TABLES`).
- 10,000 distinct retained identities is an initial engineering budget, not a measured recommendation.
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

Hook-versus-telemetry comparison will join on `(run_id, tool_use_id)`; that join is not implemented.

## Validation

Run these to reproduce:

```sh
pnpm --filter @coodra/db exec vitest run                     # 175 unit tests (parity, table list/count)
pnpm --filter @coodra/db exec vitest run --config vitest.integration.config.ts __tests__/integration/delete-project.test.ts
pnpm --filter @coodra/cli exec vitest run __tests__/unit/outbox
pnpm --filter @coodra/mcp-server exec vitest run --config vitest.integration.config.ts   # 49 files, 364 tests
```

Results at revision 2: db unit 175 passed; delete-project integration 5 passed; outbox unit 24 passed; mcp-server integration 364 passed (including the 11 in `native-telemetry.test.ts`); `tsc` clean for db, cli, mcp-server and web-v2; biome clean on touched packages. The Postgres migration test (`postgres-migrate.test.ts`) was **not run** (needs a Postgres instance).

`native-telemetry.test.ts` uses real loopback HTTP, in-memory SQLite and the production outbox dispatcher. It covers: content removal before queueing and in the table; typed columns and cost micros; separation of tool `success` from any policy verdict; hook `run_events` untouched; exact replay; source-time ordering and repeated sequence numbers; unavailable and mismatched Run identity; partial rejection; enqueue failure not acknowledged as accepted; opt-in endpoint, Origin, protocol and size limits; capacity bound and replay at capacity; retention of rows and queue payloads; cascade on Run delete; malformed queued job dead-lettered without a partial row.

Live validation (logs only, isolated daemon with its own `COODRA_HOME` and a seeded project and Run):
- **Claude Code 2.1.325 (rev 1, `run_events`):** a real 35-record startup export was accepted, with 34 records rejected as unsupported and the `api_error` persisted.
- **Claude Code 2.1.330 (rev 2, `native_telemetry_events`):** one successful and one failing `Read` produced 2 `tool_result` rows (`success` 1 and 0, distinct `tool_use_id`) and 2 `api_request` rows with model, token counts, `cost_usd_micros` and `cost_kind = provider_estimate`. Every row had `content_policy = excluded`, `run_events` stayed empty, and `pending_jobs` drained.
- Real OTLP attributes arrive typed (integers as JSON numbers); the receiver also handles the string-valued attributes used in fixtures.

Installed daemon (`/opt/homebrew/.../@coodra/cli`, 0.5.14 base): runtime `mcp-server/index.js` and `drizzle/` were replaced with this build; the daemon migrated at boot, created the table and indexes, and the telemetry route returns 200. **No live Claude session has been run against the installed daemon**, so end-to-end there is unverified. Backups: `~/.coodra/backup-pre-telemetry/` (rev 1) and `~/.coodra/backup-pre-telemetry-table/` (pre-rev-2 `index.js`, `drizzle/`, `data.db`).

Not yet verified: comparison against hook events from the same session; shutdown flushing and loss on interruption; managed-setting effects; exporter retry behaviour; Postgres migration; any CLI version other than 2.1.325 and 2.1.330.

## Reviewer checklist

1. Confirm no code path writes telemetry to `run_events` (`grep -n run_events apps/mcp-server/src/lib/native-telemetry.ts` should show nothing).
2. Confirm the two migrations create only `native_telemetry_events` and its three indexes, and that `schema-parity.test.ts` covers both dialects.
3. Confirm `content` never reaches the queue or table: check `safeAttributes` against `IDENTIFIERS` and `NUMBERS`, and the `PRIVATE_` assertions in the test.
4. Confirm `native_telemetry` is in `AUDIT_QUEUE_KINDS` and has a dispatcher branch; a queue without a branch would dead-letter.
5. Confirm `DEPENDENT_PROJECT_TABLES` includes the table and the delete-project test inserts a row.
6. Confirm replay identity excludes `receivedAt` and that capacity and retention count the new table and the `native_telemetry` queue.
7. Confirm there is no sync path: no `sync_to_cloud` job is enqueued and `SyncTableName` does not list the table.

## Out of scope and remaining work

Codex adapter; OTLP protobuf and gRPC; metrics and traces; hook-versus-telemetry reconciliation (`matched`, `hook-only`, `telemetry-only`, `awaiting arrival`, `not comparable`); a Run-view panel for evidence, queue state and correlation limits; CLI support for enabling the receiver; Postgres export; automatic checkpoint authoring, Stop enforcement, semantic coverage validation and Decision authority changes. Absent telemetry is not proof that no operation occurred: native export can drop data before Coodra receives it, and a hook response or Run completion cannot establish durable acceptance or checkpoint success on its own.
