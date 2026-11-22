-- COOD-105 revision 2 moved native telemetry from run_events (phase = 'telemetry') into
-- native_telemetry_events. Carry forward anything stored by revision 1, preserving the row id
-- (replay identity) and the original receipt time, then remove the legacy rows so they are no
-- longer counted as hook/tool activity. Idempotent: INSERT OR IGNORE on id.
-- Legacy rows whose Run is gone (run_id NULL) cannot satisfy the NOT NULL run_id and are dropped.
-- Queued legacy `run_event` jobs are converted by the outbox dispatcher, not here.
INSERT OR IGNORE INTO `native_telemetry_events` (
	`id`, `org_id`, `project_id`, `run_id`, `harness`, `source`, `event_name`,
	`source_time_unix_nano`, `source_time_ms`, `session_id`, `app_version`, `tool_use_id`, `tool_name`,
	`request_id`, `client_request_id`, `prompt_id`, `agent_id`, `parent_agent_id`, `model`, `success`,
	`event_sequence`, `duration_ms`, `status_code`, `attempt`, `input_tokens`, `output_tokens`,
	`cache_read_tokens`, `cache_creation_tokens`, `tool_input_size_bytes`, `tool_result_size_bytes`,
	`cost_usd_micros`, `cost_kind`, `content_policy`, `attributes_json`, `received_at`
)
SELECT
	e.`id`, e.`org_id`, r.`project_id`, e.`run_id`,
	json_extract(e.`tool_input`, '$.output.harness'),
	COALESCE(json_extract(e.`tool_input`, '$.output.source'), 'otlp_logs'),
	json_extract(e.`tool_input`, '$.output.eventName'),
	CAST(json_extract(e.`tool_input`, '$.output.sourceTimeUnixNano') AS TEXT),
	CAST(json_extract(e.`tool_input`, '$.output.sourceTimeUnixNano') AS INTEGER) / 1000000,
	json_extract(e.`tool_input`, '$.output.sessionId'),
	json_extract(e.`tool_input`, '$.output.attributes."app.version"'),
	json_extract(e.`tool_input`, '$.output.attributes.tool_use_id'),
	json_extract(e.`tool_input`, '$.output.attributes.tool_name'),
	json_extract(e.`tool_input`, '$.output.attributes.request_id'),
	json_extract(e.`tool_input`, '$.output.attributes.client_request_id'),
	json_extract(e.`tool_input`, '$.output.attributes."prompt.id"'),
	json_extract(e.`tool_input`, '$.output.attributes.agent_id'),
	json_extract(e.`tool_input`, '$.output.attributes.parent_agent_id'),
	json_extract(e.`tool_input`, '$.output.attributes.model'),
	json_extract(e.`tool_input`, '$.output.attributes.success'),
	json_extract(e.`tool_input`, '$.output.attributes."event.sequence"'),
	json_extract(e.`tool_input`, '$.output.attributes.duration_ms'),
	json_extract(e.`tool_input`, '$.output.attributes.status_code'),
	json_extract(e.`tool_input`, '$.output.attributes.attempt'),
	json_extract(e.`tool_input`, '$.output.attributes.input_tokens'),
	json_extract(e.`tool_input`, '$.output.attributes.output_tokens'),
	json_extract(e.`tool_input`, '$.output.attributes.cache_read_tokens'),
	json_extract(e.`tool_input`, '$.output.attributes.cache_creation_tokens'),
	json_extract(e.`tool_input`, '$.output.attributes.tool_input_size_bytes'),
	json_extract(e.`tool_input`, '$.output.attributes.tool_result_size_bytes'),
	COALESCE(
		json_extract(e.`tool_input`, '$.output.attributes.cost_usd_micros'),
		CASE WHEN json_extract(e.`tool_input`, '$.output.attributes.cost_usd') IS NOT NULL
			THEN CAST(ROUND(json_extract(e.`tool_input`, '$.output.attributes.cost_usd') * 1000000) AS INTEGER) END
	),
	json_extract(e.`tool_input`, '$.output.costKind'),
	'excluded',
	COALESCE(json_extract(e.`tool_input`, '$.output.attributes'), '{}'),
	e.`created_at`
FROM `run_events` e
JOIN `runs` r ON r.`id` = e.`run_id`
WHERE e.`phase` = 'telemetry'
	AND e.`id` GLOB 'native_telemetry_*'
	AND json_valid(e.`tool_input`)
	AND json_extract(e.`tool_input`, '$.output.harness') IS NOT NULL
	AND json_extract(e.`tool_input`, '$.output.eventName') IS NOT NULL
	AND json_extract(e.`tool_input`, '$.output.sourceTimeUnixNano') IS NOT NULL
	AND json_extract(e.`tool_input`, '$.output.sessionId') IS NOT NULL
	AND json_extract(e.`tool_input`, '$.output.costKind') IS NOT NULL;
--> statement-breakpoint
DELETE FROM `run_events` WHERE `phase` = 'telemetry' AND `id` GLOB 'native_telemetry_*';
