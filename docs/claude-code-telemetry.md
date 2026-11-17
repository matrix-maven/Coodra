# Native telemetry: first COOD-105 slice

The shared observation envelope includes a harness discriminator for Claude Code and Codex. Only the Claude Code logs adapter is implemented in this slice. Codex remains in scope for a subsequent adapter, with its own documented signals and verified fixtures; its telemetry is not enabled or accepted as Claude Code data.

| Surface | Status |
| --- | --- |
| Claude Code OTLP HTTP/JSON logs | Receiver/queue/readback verified with synthetic fixtures; live CLI export unverified |
| Codex telemetry | Adapter not implemented; do not assume Claude event names or fields |
| OTLP protobuf, gRPC, metrics and traces | Not implemented in this slice |
| Cross-channel reconciliation and checkpoint coverage | Subsequent work; data collection alone establishes neither |

## Implementation boundary

The persistent MCP daemon accepts selected native log metadata at `POST /telemetry/claude_code/<project-slug>/v1/logs`. This is opt-in and solo/local only. It uses existing `pending_jobs`, the `run_event` dispatcher, and `run_events`; there is no new database, collector process or model provider. Native observations have phase `telemetry`, event name as `tool_name`, native tool-use ID when available, and an observation envelope under `tool_input.output`. Existing Run detail/CLI event readback can inspect these records; no aggregate cost dashboard is implemented.

Accepted events are `claude_code.tool_result`, `claude_code.api_request` and `claude_code.api_error`. The allowlist preserves bounded identifiers, execution status, token/cache counts, timing, attempts and reported cost estimates where supplied. Missing fields stay absent; unavailable cost is explicit. Do not sum request-event costs with future metric counters, or treat provider estimates as subscription billing.

The project must exist, and its stored Run must match the exact native session ID and `claude_code` harness. Exporter retries can bridge a late Run creation; Coodra does not fabricate a Run or bind by timing, cwd, MCP transport session, or an unrelated history filter. A validated database join establishes record association, not independent authentication of the native producer. Source child/parent IDs are retained only when supplied; no inferred agent genealogy or Decision authority is added.

Source nanosecond timestamps are retained separately from receipt time. Replay identity hashes the normalized metadata with project/Run/session scope and source time, excluding receipt time and content. Repeated sequence numbers after a resume therefore do not collapse different source-time occurrences. Exact replay does not inflate event counts. With no unique occurrence identity, identical metadata at the exact same nanosecond remains indistinguishable; this is not a complete source ledger.

## Opt-in setup

Run the updated MCP server in HTTP mode with `COODRA_TELEMETRY_ENABLED=1` in its process environment. For a repository development instance, after building dependencies:

```sh
COODRA_TELEMETRY_ENABLED=1 MCP_SERVER_HOST=127.0.0.1 MCP_SERVER_PORT=4318 \
  pnpm --filter @coodra/mcp-server exec tsx src/index.ts --transport http
```

Use a free port for an isolated instance; do not launch a second daemon over an existing listener. This slice does not change the installed CLI or restart the user's running daemon.

In the shell launching Claude Code, select the intended project slug and daemon port:

```sh
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:4318/telemetry/claude_code/coodra/v1/logs
export OTEL_METRICS_INCLUDE_SESSION_ID=true
export OTEL_METRICS_INCLUDE_VERSION=true
export OTEL_LOG_USER_PROMPTS=0
export OTEL_LOG_ASSISTANT_RESPONSES=0
export OTEL_LOG_TOOL_DETAILS=0
export OTEL_LOG_TOOL_CONTENT=0
export OTEL_LOG_RAW_API_BODIES=0
export OTEL_LOGS_EXPORT_INTERVAL=1000
claude
```

For a logs-only test, leave metric and trace exporters unset, or explicitly disable them in that shell if previously configured. Check managed settings and existing exporter destinations before changing your own launch environment. Repository `.claude/settings.json` is not used for this setup. No global settings are modified by Coodra's implementation.

The user-provided [Agent SDK observability guide](https://code.claude.com/docs/en/agent-sdk/observability) explains that the SDK delegates export to the CLI. The [Claude Code monitoring reference](https://code.claude.com/docs/en/monitoring-usage) defines the CLI log signals and exporter configuration. The other supplied [API OpenTelemetry guide](https://platform.claude.com/docs/en/manage-claude/opentelemetry) covers API/SDK tracing, a distinct integration. No SDK wrapper or API tracing integration is needed here.

## Privacy, durability and limits

The receiver rejects requests from non-loopback peers or requests with an Origin header. It accepts uncompressed JSON only, capped at 1 MiB and 256 log records per export. It does not share native telemetry to Postgres. Unknown content-bearing attributes, the OTLP body, prompts, tool inputs/results, account attributes and free-text errors are discarded before durable queueing, even if the producer enables content collection. Names/IDs allowed as metadata are bounded but are still user data.

HTTP 200 means all supported records were durably enqueued or were retries of already accepted records. It does not mean the destination write has completed. Unsupported events, missing source identity and expired/future source timestamps receive OTLP `partialSuccess` with a rejection count. Invalid envelopes return 400; oversized exports 413; unsupported encodings/protocols 415. Missing Runs, capacity limits and storage failures return 503 with Retry-After. A failed batch can have earlier durable writes; full replay is safe. Native export itself can drop data before Coodra receives it, so absent telemetry is not proof that no operation occurred.

Local evidence and its retained queue payloads expire after seven days of receipt. The enabled persistent daemon prunes on boot and hourly, reporting pruned rows or maintenance failures in its logs. It admits at most 10,000 distinct retained native event identities across the destination and queue, applying retryable backpressure rather than deleting recent accepted evidence to admit more. This is an initial engineering budget, not a measured production-volume recommendation. Queue/dead-letter diagnostics remain available through existing outbox tooling. Retention removes evidence, including expired dead letters; it does not establish successful capture or semantic coverage.

## Validation and remaining proof

Integration tests exercise real loopback HTTP, in-memory SQLite, the production outbox dispatcher and Run readback. They cover privacy before queueing, execution failure separate from policy, exact replay, source-time ordering, unavailable/mismatched Run identity, rejection, enqueue failure, request limits and retention.

The `claude` executable was not on PATH in the implementation environment. Pin and record the actual CLI version and surface before claiming native compatibility: start an authorized project session, perform a harmless permitted tool call and a failed call, inspect the queued/persisted event IDs and compare them with hooks. Confirm shutdown flushing, interruption loss, managed-setting effects and retry behavior on that version. These live observations, Codex collection, metrics/traces and cross-channel reconciliation remain open.
