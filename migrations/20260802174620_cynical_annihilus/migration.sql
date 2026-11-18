CREATE TABLE "resume_variant" (
	"id" text PRIMARY KEY,
	"resume_id" text NOT NULL,
	"locale" text NOT NULL,
	"data" jsonb NOT NULL,
	"layout_mode" text DEFAULT 'shared' NOT NULL,
	"block_statuses" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resume_variant_resume_id_locale_unique" UNIQUE("resume_id","locale")
);
--> statement-breakpoint
CREATE INDEX "resume_variant_resume_id_index" ON "resume_variant" ("resume_id");--> statement-breakpoint
ALTER TABLE "resume_variant" ADD CONSTRAINT "resume_variant_resume_id_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "resume"("id") ON DELETE CASCADE;