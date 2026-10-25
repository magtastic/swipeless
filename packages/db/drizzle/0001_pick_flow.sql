-- The pick flow (PRODUCT.md as of 2026-10-23). setup_status loses
-- interest_pending, mutual, proposed and countered and gains suggested and
-- requested, and a setup now carries the date swipeless suggests instead of
-- an agent's proposal. Existing setups rows are pre-alpha test data with no
-- mapping onto the new states, so they are deleted here. Profiles are kept.
--
-- Hand-edited from drizzle-kit's output so every statement can run twice:
-- @swipeless/db/testing replays all migrations before each suite.
DELETE FROM "setups";--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
ALTER TABLE "setups" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "setups" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."setup_status";--> statement-breakpoint
CREATE TYPE "public"."setup_status" AS ENUM('suggested', 'requested', 'confirmed', 'declined', 'expired');--> statement-breakpoint
ALTER TABLE "setups" ALTER COLUMN "status" SET DATA TYPE "public"."setup_status" USING "status"::"public"."setup_status";--> statement-breakpoint
ALTER TABLE "setups" ALTER COLUMN "status" SET DEFAULT 'suggested';--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "review_status" "review_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "setups" ADD COLUMN "date" jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "profiles_review_status_idx" ON "profiles" USING btree ("review_status");--> statement-breakpoint
ALTER TABLE "setups" DROP COLUMN IF EXISTS "proposal";--> statement-breakpoint
ALTER TABLE "setups" DROP COLUMN IF EXISTS "counter";--> statement-breakpoint
ALTER TABLE "setups" DROP COLUMN IF EXISTS "confirmed_slot";
