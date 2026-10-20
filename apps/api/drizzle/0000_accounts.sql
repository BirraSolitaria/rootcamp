-- Hand-edited after `drizzle-kit generate`: citext must exist before users is created.
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_id" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "email_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "email_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "hearts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 5 NOT NULL,
	"last_regen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hearts_count_range" CHECK ("hearts"."count" BETWEEN 0 AND 5)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "streaks" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"current" integer DEFAULT 0 NOT NULL,
	"best" integer DEFAULT 0 NOT NULL,
	"last_activity_date" date
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"email_verified_at" timestamp with time zone,
	"nick" "citext" NOT NULL,
	"password_hash" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"ban_reason" text,
	"tz" text DEFAULT 'Europe/Moscow' NOT NULL,
	"rank" text DEFAULT 'guest' NOT NULL,
	"total_xp" integer DEFAULT 0 NOT NULL,
	"reminder_enabled" boolean DEFAULT true NOT NULL,
	"reminder_time" time DEFAULT '20:00' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_nick_unique" UNIQUE("nick"),
	CONSTRAINT "users_nick_format" CHECK ("users"."nick"::text ~ '^[a-z0-9_.]{3,20}$')
);
--> statement-breakpoint
CREATE TABLE "xp_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "xp_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"source" text NOT NULL,
	"ref_id" text,
	"day" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_tokens" ADD CONSTRAINT "email_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearts" ADD CONSTRAINT "hearts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "streaks" ADD CONSTRAINT "streaks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "email_log_user_id_idx" ON "email_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "email_tokens_user_id_idx" ON "email_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "xp_events_user_id_day_idx" ON "xp_events" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "xp_events_created_at_idx" ON "xp_events" USING btree ("created_at");--> statement-breakpoint
-- Hand-edited: default settings (Global Constraints); keep in sync with DEFAULT_SETTINGS in packages/db.
INSERT INTO "settings" ("key", "value") VALUES
	('registration_mode', '"open"'::jsonb),
	('max_users', '50'::jsonb)
ON CONFLICT ("key") DO NOTHING;
