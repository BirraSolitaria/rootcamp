CREATE TABLE "learning_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"lesson_id" text,
	"content_version" text NOT NULL,
	"state" jsonb NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lesson_completions" (
	"user_id" uuid NOT NULL,
	"lesson_id" text NOT NULL,
	"first_completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"times" integer DEFAULT 1 NOT NULL,
	"best_mistakes" integer NOT NULL,
	CONSTRAINT "lesson_completions_user_id_lesson_id_pk" PRIMARY KEY("user_id","lesson_id")
);
--> statement-breakpoint
CREATE TABLE "review_items" (
	"user_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"box" integer NOT NULL,
	"due_date" date NOT NULL,
	CONSTRAINT "review_items_user_id_task_id_pk" PRIMARY KEY("user_id","task_id"),
	CONSTRAINT "review_items_box_range" CHECK ("review_items"."box" BETWEEN 1 AND 3)
);
--> statement-breakpoint
ALTER TABLE "learning_sessions" ADD CONSTRAINT "learning_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_completions" ADD CONSTRAINT "lesson_completions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "learning_sessions_one_in_progress_idx" ON "learning_sessions" USING btree ("user_id") WHERE "learning_sessions"."status" = 'in_progress';--> statement-breakpoint
CREATE INDEX "review_items_user_id_due_date_idx" ON "review_items" USING btree ("user_id","due_date");