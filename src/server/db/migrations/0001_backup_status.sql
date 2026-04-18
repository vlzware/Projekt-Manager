CREATE TABLE "meta_backup_status" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"last_backup_at" timestamp with time zone,
	"last_backup_ok" boolean DEFAULT false NOT NULL,
	"last_drill_at" timestamp with time zone,
	"last_drill_ok" boolean,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_backup_status_singleton" CHECK ("meta_backup_status"."singleton" = true)
);
--> statement-breakpoint
-- Pre-seed the single row so the app always upserts on the fixed singleton
-- key (data-model.md §5.9, ADR-0020). Avoids a first-write vs nth-write
-- distinction in the repository layer.
INSERT INTO "meta_backup_status" ("singleton", "last_backup_ok") VALUES (TRUE, FALSE)
	ON CONFLICT ("singleton") DO NOTHING;
