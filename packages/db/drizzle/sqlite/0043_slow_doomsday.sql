PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_native_telemetry_events` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`project_id` text NOT NULL,
	`run_id` text,
	`harness` text NOT NULL,
	`source` text NOT NULL,
	`event_name` text NOT NULL,
	`source_time_unix_nano` text NOT NULL,
	`source_time_ms` integer NOT NULL,
	`session_id` text NOT NULL,
	`app_version` text,
	`tool_use_id` text,
	`tool_name` text,
	`request_id` text,
	`client_request_id` text,
	`prompt_id` text,
	`agent_id` text,
	`parent_agent_id` text,
	`model` text,
	`success` integer,
	`event_sequence` integer,
	`duration_ms` integer,
	`status_code` integer,
	`attempt` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`cache_creation_tokens` integer,
	`tool_input_size_bytes` integer,
	`tool_result_size_bytes` integer,
	`cost_usd_micros` integer,
	`cost_kind` text NOT NULL,
	`content_policy` text DEFAULT 'excluded' NOT NULL,
	`attributes_json` text DEFAULT '{}' NOT NULL,
	`received_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_native_telemetry_events`("id", "org_id", "project_id", "run_id", "harness", "source", "event_name", "source_time_unix_nano", "source_time_ms", "session_id", "app_version", "tool_use_id", "tool_name", "request_id", "client_request_id", "prompt_id", "agent_id", "parent_agent_id", "model", "success", "event_sequence", "duration_ms", "status_code", "attempt", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "tool_input_size_bytes", "tool_result_size_bytes", "cost_usd_micros", "cost_kind", "content_policy", "attributes_json", "received_at") SELECT "id", "org_id", "project_id", "run_id", "harness", "source", "event_name", "source_time_unix_nano", "source_time_ms", "session_id", "app_version", "tool_use_id", "tool_name", "request_id", "client_request_id", "prompt_id", "agent_id", "parent_agent_id", "model", "success", "event_sequence", "duration_ms", "status_code", "attempt", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "tool_input_size_bytes", "tool_result_size_bytes", "cost_usd_micros", "cost_kind", "content_policy", "attributes_json", "received_at" FROM `native_telemetry_events`;--> statement-breakpoint
DROP TABLE `native_telemetry_events`;--> statement-breakpoint
ALTER TABLE `__new_native_telemetry_events` RENAME TO `native_telemetry_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `native_telemetry_events_run_time_idx` ON `native_telemetry_events` (`run_id`,`source_time_ms`);--> statement-breakpoint
CREATE INDEX `native_telemetry_events_run_tool_idx` ON `native_telemetry_events` (`run_id`,`tool_use_id`);--> statement-breakpoint
CREATE INDEX `native_telemetry_events_session_idx` ON `native_telemetry_events` (`project_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `native_telemetry_events_received_idx` ON `native_telemetry_events` (`received_at`);