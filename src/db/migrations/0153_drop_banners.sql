-- 0153: Drop the official Grynd profile banner system.
--
-- Profile banners have been removed from the product entirely: the battlepass
-- no longer grants them, the catalog/ownership pickers are deleted, and the
-- equipped-banner fields are gone. The ownership + catalog tables (created by
-- 0135) and the `selected_banner` / legacy `profile_banner` columns on
-- `users` are no longer referenced anywhere in the codebase and are dropped.
DROP TABLE IF EXISTS "user_banners";
--> statement-breakpoint
DROP TABLE IF EXISTS "banners";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "selected_banner";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "profile_banner";