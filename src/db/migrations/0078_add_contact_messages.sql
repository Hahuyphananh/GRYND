-- 0078_add_contact_messages.sql
-- Add contact_messages table: the DB-backed contact form inbox.
-- Users submit the /contact form; the message is stored here (POST
-- /api/contact) and shown to admins in the admin dashboard's Messages tab
-- (GET /api/admin/contact-messages). No email is sent.
--
-- Applied manually like the other raw SQL migrations (0055+ are not in the
-- drizzle journal). Every statement is idempotent, and the runtime self-heal
-- in src/app/api/contact/route.ts creates the same table on first request,
-- so this is safe to apply on any database.

CREATE TABLE IF NOT EXISTS contact_messages (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255),
  email VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'new',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contact_messages_status ON contact_messages (status, created_at);
