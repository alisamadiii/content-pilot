CREATE TABLE "live_build" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" bigint NOT NULL,
	"sha" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"log" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "idx_live_build_repo" ON "live_build" USING btree ("repo_id","id");--> statement-breakpoint
CREATE INDEX "idx_live_build_status" ON "live_build" USING btree ("status");