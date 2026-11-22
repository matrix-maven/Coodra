ALTER TABLE "native_telemetry_events" ADD COLUMN "hook_event" text;--> statement-breakpoint
ALTER TABLE "native_telemetry_events" ADD COLUMN "hook_name" text;--> statement-breakpoint
ALTER TABLE "native_telemetry_events" ADD COLUMN "hook_count" integer;--> statement-breakpoint
ALTER TABLE "native_telemetry_events" ADD COLUMN "hook_success_count" integer;--> statement-breakpoint
ALTER TABLE "native_telemetry_events" ADD COLUMN "hook_blocking_count" integer;--> statement-breakpoint
ALTER TABLE "native_telemetry_events" ADD COLUMN "hook_error_count" integer;--> statement-breakpoint
ALTER TABLE "native_telemetry_events" ADD COLUMN "hook_cancelled_count" integer;--> statement-breakpoint
ALTER TABLE "native_telemetry_events" ADD COLUMN "connection_status" text;--> statement-breakpoint
ALTER TABLE "native_telemetry_events" ADD COLUMN "transport_type" text;--> statement-breakpoint
ALTER TABLE "native_telemetry_events" ADD COLUMN "server_scope" text;--> statement-breakpoint
ALTER TABLE "native_telemetry_events" ADD COLUMN "plugin_id_hash" text;