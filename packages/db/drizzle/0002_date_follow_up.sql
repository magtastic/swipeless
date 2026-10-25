-- When the admin site sent both people "how was the date?" after a confirmed
-- setup. Null means not yet.
--
-- IF NOT EXISTS so it can run twice: @swipeless/db/testing replays all
-- migrations before each suite.
ALTER TABLE "setups" ADD COLUMN IF NOT EXISTS "follow_up_sent_at" timestamp with time zone;
