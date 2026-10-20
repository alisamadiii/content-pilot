ALTER TABLE "preview_session" ALTER COLUMN "repo_id" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "preview_session" ADD COLUMN "source" text DEFAULT 'github' NOT NULL;