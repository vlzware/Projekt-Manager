ALTER TABLE "sessions" ALTER COLUMN "token" SET DATA TYPE varchar(64);--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "token" DROP DEFAULT;