-- 0154: Drop the avatar frame system.
--
-- The Grynd+ avatar frame was fully implemented (CSS gradient ring around
-- the avatar: src/components/AvatarFrame.tsx, `users.avatar_frame`) but the
-- app owner decided to remove it — the feature was unused.
--
-- Removes the stored column; the code references were deleted alongside this
-- migration (component, cosmetics catalog, API reads/writes, profile UI).
-- The historical `0123_profile_customization.sql` migration file is empty; the
-- column existed only because `drizzle-kit push` ran the scaffold, so there is
-- nothing earlier to revert.
-- Idempotent: safe to run repeatedly.

ALTER TABLE "users" DROP COLUMN IF EXISTS "avatar_frame";
--> statement-breakpoint