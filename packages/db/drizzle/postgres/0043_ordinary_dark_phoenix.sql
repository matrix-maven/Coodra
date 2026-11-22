CREATE TABLE "native_telemetry_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"harness" text NOT NULL,
	"source" text NOT NULL,
	"event_name" text NOT NULL,
	"source_time_unix_nano" text NOT NULL,
	"source_time_ms" bigint NOT NULL,
	"session_id" text NOT NULL,
	"app_version" text,
	"tool_use_id" text,
	"tool_name" text,
	"request_id" text,
	"client_request_id" text,
	"prompt_id" text,
	"agent_id" text,
	"parent_agent_id" text,
	"model" text,
	"success" boolean,
	"event_sequence" integer,
	"duration_ms" integer,
	"status_code" integer,
	"attempt" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_creation_tokens" integer,
	"tool_input_size_bytes" integer,
	"tool_result_size_bytes" integer,
	"cost_usd_micros" integer,
	"cost_kind" text NOT NULL,
	"content_policy" text DEFAULT 'excluded' NOT NULL,
	"attributes_json" text DEFAULT '{}' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "native_telemetry_events" ADD CONSTRAINT "native_telemetry_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_telemetry_events" ADD CONSTRAINT "native_telemetry_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "native_telemetry_events_run_time_idx" ON "native_telemetry_events" USING btree ("run_id","source_time_ms");--> statement-breakpoint
CREATE INDEX "native_telemetry_events_run_tool_idx" ON "native_telemetry_events" USING btree ("run_id","tool_use_id");--> statement-breakpoint
CREATE INDEX "native_telemetry_events_received_idx" ON "native_telemetry_events" USING btree ("received_at");