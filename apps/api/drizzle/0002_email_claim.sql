ALTER TABLE "email_log" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "next_attempt_at" timestamp with time zone;