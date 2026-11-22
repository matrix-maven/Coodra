ALTER TABLE "native_telemetry_events" DROP CONSTRAINT "native_telemetry_events_run_id_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "native_telemetry_events" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "native_telemetry_events" ADD CONSTRAINT "native_telemetry_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "native_telemetry_events_session_idx" ON "native_telemetry_events" USING btree ("project_id","session_id");