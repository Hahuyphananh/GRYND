-- 0079_add_contact_message_replies.sql
-- Add contact_message_replies table: admin replies to contact form messages.
-- Filled by POST /api/admin/contact-messages; surfaced to the user in their
-- message history (GET /api/contact/messages) and to admins in the dashboard.
--
-- Applied manually like the other raw SQL migrations (0055+ are not in the
-- drizzle journal). Every statement is idempotent, and the runtime self-heal
-- in src/lib/contact/ensureTables.ts creates the same table on first request,
-- so this is safe to apply on any database.

CREATE TABLE IF NOT EXISTS contact_message_replies (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES contact_messages(id) ON DELETE CASCADE,
  admin_clerk_id VARCHAR(255) NOT NULL,
  admin_name VARCHAR(255) NOT NULL,
  reply TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_message_replies_message
  ON contact_message_replies (message_id);
