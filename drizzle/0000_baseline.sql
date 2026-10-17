CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "app_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preview_attachment" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"message_id" integer,
	"original_name" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"staged_path" text NOT NULL,
	"placed_path" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preview_event" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"message_id" integer,
	"type" text NOT NULL,
	"data" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preview_message" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"context" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"commit_sha" text,
	"error" text,
	"error_detail" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" double precision,
	"started_at" timestamp,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preview_session" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_id" integer NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"branch" text NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"provider" text DEFAULT 'gemini' NOT NULL,
	"port" integer,
	"pid" integer,
	"claude_session_id" text,
	"claude_cost_usd" double precision,
	"error" text,
	"requested_by" text,
	"last_activity_at" timestamp DEFAULT now() NOT NULL,
	"idle_warned_at" timestamp,
	"reset_requested_at" timestamp,
	"cancel_requested_at" timestamp,
	"closed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_preview_attachment_session" ON "preview_attachment" USING btree ("session_id","message_id");--> statement-breakpoint
CREATE INDEX "idx_preview_event_session" ON "preview_event" USING btree ("session_id","id");--> statement-breakpoint
CREATE INDEX "idx_preview_message_session" ON "preview_message" USING btree ("session_id","id");--> statement-breakpoint
CREATE INDEX "idx_preview_session_repo_status" ON "preview_session" USING btree ("repo_id","status");