DROP INDEX "idx_preview_session_repo_status";--> statement-breakpoint
ALTER TABLE "preview_session" ALTER COLUMN "repo_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "preview_session" ADD COLUMN "project_id" text;--> statement-breakpoint
CREATE INDEX "idx_preview_session_project_status" ON "preview_session" USING btree ("project_id","status");