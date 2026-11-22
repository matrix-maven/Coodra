ALTER TABLE `native_telemetry_events` ADD `hook_event` text;--> statement-breakpoint
ALTER TABLE `native_telemetry_events` ADD `hook_name` text;--> statement-breakpoint
ALTER TABLE `native_telemetry_events` ADD `hook_count` integer;--> statement-breakpoint
ALTER TABLE `native_telemetry_events` ADD `hook_success_count` integer;--> statement-breakpoint
ALTER TABLE `native_telemetry_events` ADD `hook_blocking_count` integer;--> statement-breakpoint
ALTER TABLE `native_telemetry_events` ADD `hook_error_count` integer;--> statement-breakpoint
ALTER TABLE `native_telemetry_events` ADD `hook_cancelled_count` integer;--> statement-breakpoint
ALTER TABLE `native_telemetry_events` ADD `connection_status` text;--> statement-breakpoint
ALTER TABLE `native_telemetry_events` ADD `transport_type` text;--> statement-breakpoint
ALTER TABLE `native_telemetry_events` ADD `server_scope` text;--> statement-breakpoint
ALTER TABLE `native_telemetry_events` ADD `plugin_id_hash` text;