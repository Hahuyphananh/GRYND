-- Add is_admin column to users table for DB-based admin role management
-- This replaces the CHAT_ADMIN_CLERK_IDS env var approach.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Index on is_admin for fast lookups when checking admin status
CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users (is_admin);
