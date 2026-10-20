ALTER TABLE "email_log" ADD COLUMN "recipient" text;--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "text_body" text;--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "html_body" text;