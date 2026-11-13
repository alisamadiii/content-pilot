CREATE TABLE "netlify_deploy" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"sha" text DEFAULT '' NOT NULL,
	"site_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"netlify_deploy_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "idx_netlify_deploy_project" ON "netlify_deploy" USING btree ("project_id","id");