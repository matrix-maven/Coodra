# Native telemetry: first COOD-105 slice (implementation reference)

Status: implemented in commit `279abd4`, validated against Claude Code 2.1.325 (see [Validation](#validation)). This document is the full implementation reference for the slice: contract, data model, receiver behaviour, setup, limits and what remains open.

The shared observation envelope has a harness discriminator for Claude Code and Codex. Only the Claude Code logs adapter exists. Codex needs its own adapter with its own documented signals and verified fixtures; it is not accepted as Claude Code data.

| Surface | Status |
| --- | --- |
| Claude Code OTLP HTTP/JSON logs | Verified live on 2.1.325: `tool_result` (success and failure), `api_request`, `api_error` |
| Codex telemetry | Adapter not implemented; do not assume Claude event names or fields |
| OTLP protobuf, gRPC, metrics, traces | Not implemented |
| Hook vs telemetry reconciliation, checkpoint coverage | Not implemented; collecting data establishes neither |

## Architecture

```
Claude Code CLI ──OTLP/HTTP JSON──▶ POST /telemetry/claude_code/<slug>/v1/logs
                                    (mcp-server daemon, src/transports/http.ts)
                                         │ validate peer/headers/auth, parse
                                         ▼
                              createNativeTelemetryReceiver (src/lib/native-telemetry.ts)
                                allowlist → resolve Run → hash identity → admission check
                                         │ scheduleDurableWrite (queue "run_event")
                                         ▼
                                 pending_jobs  ──outbox worker/dispatcher──▶  run_events
                                                                              (phase = 'telemetry')
```

There is no new process, database, migration or table. The slice reuses the persistent MCP daemon, the durable outbox and canonical SQLite storage.

### Files

| File | Role |
| --- | --- |
| `apps/mcp-server/src/lib/native-telemetry.ts` | Envelope type, allowlist, receiver, identity hashing, retention pruning |
| `apps/mcp-server/src/transports/http.ts` | Route, loopback/Origin/content-type/encoding checks, auth, status mapping |
| `apps/mcp-server/src/index.ts` | Opt-in wiring (`COODRA_TELEMETRY_ENABLED=1`, solo only), hourly retention pass, outbox kick |
| `apps/web-v2/lib/queries/roi.ts` | `countRunEvents` excludes `phase = 'telemetry'` so telemetry does not inflate tool-invocation counts |
| `apps/mcp-server/__tests__/integration/lib/native-telemetry.test.ts` | Integration tests (real loopback HTTP, in-memory SQLite, production dispatcher) |

## Database tables

**No tables, columns, indexes or migrations were added.** Native telemetry is stored in three existing tables. All are SQLite-only in this slice; a non-SQLite handle gets 503 `local_storage_required`.

### `projects` (read)
The URL slug is resolved with `lookupProjectBySlug`. Unknown slug returns 404 `project_not_found`.

### `runs` (read)
Association is by exact match on `project_id`, `session_id` (the native `session.id`) and `agent_type = 'claude_code'`; the unique index `runs_project_session_idx (project_id, session_id)` backs the lookup. Coodra never creates a Run from telemetry and never binds by time, cwd or MCP transport session.

### `pending_jobs` (write, transient)
The durable outbox. Columns: `id` (PK), `queue`, `payload`, `attempts`, `status` (default `pending`), `run_after`, `created_at`, `picked_at`, `failed_at`, `last_error`, `org_id`, `project_id`, `run_id`. Indexes: `pending_jobs_poll_idx (queue, status, run_after)`, `pending_jobs_picked_idx (status, picked_at)`.

Telemetry rows use `queue = 'run_event'` and `id = native_telemetry_<sha256>`. The payload is a `RunEventPayloadV1` with `resolution: { kind: 'pre_resolved', runId }`. Dead-lettered telemetry jobs stay visible here until retention removes them. No `sync_to_cloud` job is enqueued, so native telemetry is not shared to Postgres.

### `run_events` (write, durable evidence)
Columns: `id` (PK), `run_id` (FK to `runs`, `ON DELETE SET NULL`), `phase`, `tool_name`, `tool_use_id`, `tool_input`, `outcome`, `created_at`, `org_id`, `project_id`. Index: `run_events_run_created_idx (run_id, created_at)`.

How a native observation maps onto a row:

| Column | Value |
| --- | --- |
| `id` | `native_telemetry_<sha256 hex>` (replay identity, below) |
| `phase` | `telemetry` (hook phases are `pre`/`post`, so the two channels never collide) |
| `tool_name` | Native event name, e.g. `claude_code.tool_result` |
| `tool_use_id` | Native `tool_use_id` when supplied, else the row `id` |
| `tool_input` | JSON `{ "input": {}, "output": <observation envelope> }` |
| `outcome` | `null` (execution status lives in the envelope, not in the policy verdict) |

Because the row id is the primary key, an exact replay is a no-op at both the queue and the destination, so counts are not inflated.

## Observation envelope

Stored under `tool_input.output`:

```ts
interface NativeTelemetryObservation {
  version: 1;
  harness: 'claude_code' | 'codex';      // only 'claude_code' is produced today
  source: 'otlp_logs';
  eventName: string;
  sourceTimeUnixNano: string;            // producer time, kept separate from receipt time
  receivedAt: string;                    // ISO, excluded from identity
  projectId: string;
  runId: string;
  sessionId: string;                     // native harness session, not the MCP transport session
  attributes: Record<string, string | number | boolean>;
  content: 'excluded';                   // constant marker: no prompt/tool/error text is stored
  costKind: 'provider_estimate' | 'unavailable';
}
```

- `content: 'excluded'` is always set. It records that the content-bearing attributes were discarded before queueing.
- `costKind` is `provider_estimate` only for `claude_code.api_request` carrying `cost_usd` or `cost_usd_micros`. Every other event is `unavailable`. Costs are provider estimates, not billing; never sum them with future metric counters.

## Accepted events and attribute allowlist

Only three events are kept. Everything else is counted as rejected.

| Event | Meaning |
| --- | --- |
| `claude_code.tool_result` | A tool call finished; carries `success`, timing and size metadata |
| `claude_code.api_request` | A model request; carries model, token counts, timing, cost estimate |
| `claude_code.api_error` | A failed model request; carries model, status, attempt, timing (no error text) |

Allowlisted identifiers (strings, max 256 chars, no control characters): `session.id`, `app.version`, `tool_use_id`, `request_id`, `client_request_id`, `prompt.id`, `agent_id`, `parent_agent_id`, `model`, `tool_name`.

Allowlisted numbers (non-negative, finite, accepted as JSON numbers or numeric strings): `event.sequence`, `duration_ms`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`, `cost_usd_micros`, `attempt`, `status_code`, `tool_input_size_bytes`, `tool_result_size_bytes`.

Allowlisted boolean: `success`.

Everything else is dropped before the queue, including the OTLP body, prompts and `prompt_text`, tool inputs and results, free-text `error`, `user.email`, `user.id`, account and organization IDs. Missing fields stay absent. Child-agent identity is kept only when the source supplies `agent_id` / `parent_agent_id`; no parentage is inferred.

### Events that are rejected
Observed in a real 2.1.325 startup: `hook_registered`, `mcp_server_connection`, `plugin_loaded`, `hook_execution_start`, `hook_execution_complete`, `managed_settings_resolved`, `user_prompt`. A batch is also rejected per record when the session ID is missing, or the source timestamp is older than seven days or more than five minutes in the future. Rejections return OTLP `partialSuccess` with a count.

## Receiver behaviour

**Route:** `POST /telemetry/claude_code/<project-slug>/v1/logs`. Enabled only when `COODRA_TELEMETRY_ENABLED=1` and `COODRA_MODE=solo`; otherwise the path falls through to a 404.

**Request checks, in order:** loopback peer only (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) and no `Origin` header (403 `local_telemetry_only`); method must be POST (405); `Content-Type: application/json` and no `Content-Encoding` (415); the transport's auth layer; JSON body of at most 1 MiB.

**Parsing:** OTLP/JSON `resourceLogs[].scopeLogs[].logRecords[]`, at most 32 × 32 groups and 256 records per export. Attribute values are read from `stringValue`, `boolValue`, `intValue` or `doubleValue`; resource attributes are merged under record attributes. The event name comes from the record `eventName`, else the body string, else the `event.name` attribute, and is normalised to the `claude_code.` prefix.

**Run resolution:** exact project + native session + `claude_code`. A missing Run returns 503 `run_not_available_retry`, so exporter retries can bridge a Run that is created slightly later. A validated database join establishes record association, not authentication of the native producer.

**Admission:** requests are serialised. The receiver counts distinct retained native identities across `run_events` and `pending_jobs`; above 10,000 it returns 503 `telemetry_capacity_exceeded` rather than deleting recent evidence.

**Writes:** each accepted record goes through `scheduleDurableWrite` on queue `run_event`, then the outbox worker is kicked.

### Replay identity
`id = native_telemetry_ + sha256(JSON(observation without receivedAt))`. The hash covers project, Run, session, event name, source nanosecond time and the allowlisted attributes, so:
- exact replays collapse to one row;
- repeated `event.sequence` values after a session resume do not collide, because the source time differs;
- two events with identical metadata at the exact same nanosecond remain indistinguishable. This is not a complete source ledger.

### Status codes

| Code | Meaning |
| --- | --- |
| 200 | All supported records durably enqueued or already accepted. May include `partialSuccess.rejectedLogRecords`. Does **not** mean the `run_events` write has completed |
| 400 | Invalid JSON or invalid OTLP envelope |
| 401 | Auth layer rejected the request |
| 403 | Non-loopback peer or `Origin` present |
| 404 | Unknown project slug, or receiver not enabled |
| 405 | Not POST |
| 413 | Body over 1 MiB or over 256 records |
| 415 | Not uncompressed `application/json` |
| 503 | Run not found yet, capacity exceeded, or storage failure; sent with `Retry-After: 5`. A failed batch can have earlier durable writes; replaying the full batch is safe |

## Retention and limits

- Evidence and queue payloads expire seven days after receipt, including dead letters. `pruneNativeTelemetry` deletes `run_events` rows with `phase = 'telemetry'` and `pending_jobs` rows whose id matches `native_telemetry_*`, scoped by that id prefix so no other rows are touched.
- The enabled daemon prunes on boot and hourly, logging `native_telemetry_retention` (with the pruned count) or `native_telemetry_retention_failed`.
- 10,000 distinct retained identities is an initial engineering budget, not a measured production recommendation.
- Retention removes evidence; it does not establish successful capture or semantic coverage.

## Setup

Telemetry is opt-in.

### Daemon
The daemon process needs `COODRA_TELEMETRY_ENABLED=1`. For a repository dev instance on a free port (do not start a second daemon over an existing listener):

```sh
COODRA_TELEMETRY_ENABLED=1 COODRA_MODE=solo MCP_SERVER_HOST=127.0.0.1 MCP_SERVER_PORT=4318 \
  pnpm --filter @coodra/mcp-server exec tsx src/index.ts --transport http
```

For the installed launchd daemon (macOS), add the variable to `~/Library/LaunchAgents/com.coodra.mcp-server.plist` under `EnvironmentVariables`, then reload it with `launchctl bootout` followed by `launchctl bootstrap` (`kickstart -k` does not re-read the plist). `coodra start` or a reinstall may regenerate the plist and drop the variable. There is not yet a CLI flag for this.

### Claude Code
In the shell that launches `claude`, choose the project slug and daemon port:

```sh
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT="http://127.0.0.1:3100/telemetry/claude_code/<project-slug>/v1/logs"
export OTEL_LOG_USER_PROMPTS=0
export OTEL_LOG_TOOL_DETAILS=0
export OTEL_LOG_TOOL_CONTENT=0
export OTEL_LOG_RAW_API_BODIES=0
export OTEL_LOG_ASSISTANT_RESPONSES=0
export OTEL_LOGS_EXPORT_INTERVAL=1000
claude
```

Leave metrics and trace exporters unset for a logs-only setup. Repository `.claude/settings.json` is not used and no global settings are changed by Coodra. The privacy flags are belt and braces: the receiver discards content regardless of what the producer sends.

References: [Agent SDK observability](https://code.claude.com/docs/en/agent-sdk/observability) (the SDK delegates export to the CLI), [Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage) (log signals and exporter configuration), and [API OpenTelemetry](https://platform.claude.com/docs/en/manage-claude/opentelemetry) (a distinct API/SDK tracing integration, not used here).

## Readback

Native observations are ordinary `run_events` rows with `phase = 'telemetry'`, so existing Run detail and CLI event readback show them. Example query:

```sql
SELECT tool_name, tool_use_id, json_extract(tool_input, '$.output.attributes') AS attrs
FROM run_events
WHERE phase = 'telemetry' AND run_id = :run
ORDER BY created_at;
```

The ROI dashboard excludes `phase = 'telemetry'` rows from its run-event count, because telemetry corroborates hook operations and is not an extra tool invocation. No aggregate cost dashboard exists.

## Validation

Integration tests (9 in `native-telemetry.test.ts`) use real loopback HTTP, in-memory SQLite, the production outbox dispatcher and Run readback. They cover content removal before queueing, execution failure separate from policy, exact replay, source-time ordering, unavailable and mismatched Run identity, rejection, enqueue failure, request limits and retention.

Live validation on Claude Code **2.1.325** (macOS, arm64), logs only, against an isolated daemon with its own `COODRA_HOME`:
- A real 35-record startup export was accepted: 1 `api_error` persisted, 34 rejected as unsupported.
- One successful and one failing `Read` produced two `tool_result` rows (`success: true` with input and result sizes; `success: false` without a result size and without error text) and two `api_request` rows with token counts and `cost_usd` / `cost_usd_micros`. All carried the seeded native session ID, distinct `tool_use_id`s and no prompt, path or error text.
- Real OTLP attributes arrive typed (integers as JSON numbers, booleans); the receiver handles both these and the string-valued attributes used in fixtures.

Not yet verified: a live session against the installed daemon; comparison against hook events from the same session; shutdown flushing and loss on interruption; managed-setting effects; exporter retry behaviour; any CLI version other than 2.1.325.

## Out of scope and remaining work

Codex adapter; OTLP protobuf and gRPC; metrics and traces; hook-versus-telemetry reconciliation (`matched`, `hook-only`, `telemetry-only`, `awaiting arrival`, `not comparable`); a Run-view panel for evidence, queue state and correlation limits; CLI support for enabling the receiver; automatic checkpoint authoring, Stop enforcement, semantic coverage validation and Decision authority changes. Absent telemetry is not proof that no operation occurred: native export can drop data before Coodra receives it, and a hook response or Run completion cannot establish durable acceptance or checkpoint success on its own.
