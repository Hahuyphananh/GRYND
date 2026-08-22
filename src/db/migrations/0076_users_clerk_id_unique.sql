-- Bring the users table in line with src/db/schema.ts: clerk_id is declared
-- .unique() there but the constraint was never created in the database.
-- Without it, ON CONFLICT (clerk_id) fails and concurrent /api/sync-user
-- calls (dev double-effects, retries) race each other into 500s, breaking
-- first-time sign-up.
-- Safe to run when duplicates exist? No — run only if no duplicates. The
-- current DB has none (verified at write time).
ALTER TABLE "users" ADD CONSTRAINT "users_clerk_id_unique" UNIQUE ("clerk_id");
