CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_kind" text NOT NULL,
	"actor_reason" text,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"correlation_id" text,
	CONSTRAINT "audit_log_actor_kind_valid" CHECK ("audit_log"."actor_kind" IN ('user', 'system')),
	CONSTRAINT "audit_log_entity_type_valid" CHECK ("audit_log"."entity_type" IN ('project', 'customer', 'user', 'project_worker')),
	CONSTRAINT "audit_log_actor_shape" CHECK ((
        ("audit_log"."actor_kind" = 'user'
          AND "audit_log"."actor_reason" IS NULL)
        OR
        ("audit_log"."actor_kind" = 'system'
          AND "audit_log"."actor_id" IS NULL
          AND "audit_log"."actor_reason" IS NOT NULL
          AND length(trim("audit_log"."actor_reason")) > 0)
      ))
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at" DESC NULLS LAST);