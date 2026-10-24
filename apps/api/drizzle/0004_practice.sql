CREATE TABLE "practice_progress" (
	"user_id" uuid NOT NULL,
	"practice_id" text NOT NULL,
	"hints_revealed" integer DEFAULT 0 NOT NULL,
	"goals_passed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_solved_at" timestamp with time zone,
	"solve_count" integer DEFAULT 0 NOT NULL,
	"xp_awarded" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "practice_progress_user_id_practice_id_pk" PRIMARY KEY("user_id","practice_id")
);
--> statement-breakpoint
CREATE TABLE "practice_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"practice_id" text NOT NULL,
	"content_version" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"resets" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sandbox_usage" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"minutes" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sandbox_usage_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid,
	"container_id" text,
	"image" text NOT NULL,
	"class" text NOT NULL,
	"cpu" numeric(4, 2) NOT NULL,
	"mem_mb" integer NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"test" boolean DEFAULT false NOT NULL,
	"hostname" text NOT NULL,
	"setup_script" text NOT NULL,
	"setup_timeout_sec" integer NOT NULL,
	"ttl_min" integer NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"hard_deadline" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"stop_reason" text,
	"failure_output" text
);
--> statement-breakpoint
ALTER TABLE "practice_progress" ADD CONSTRAINT "practice_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_runs" ADD CONSTRAINT "practice_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_usage" ADD CONSTRAINT "sandbox_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandboxes_one_active_per_user_idx" ON "sandboxes" USING btree ("user_id") WHERE "sandboxes"."state" IN ('queued', 'starting', 'ready');--> statement-breakpoint
CREATE INDEX "sandboxes_state_idx" ON "sandboxes" USING btree ("state");