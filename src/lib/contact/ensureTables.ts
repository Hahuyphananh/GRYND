// src/lib/contact/ensureTables.ts
// Self-healing DDL for the contact-message system, shared by:
//   - POST /api/contact                (store a submission)
//   - GET  /api/contact/messages       (user message history)
//   - GET/POST/PATCH/DELETE /api/admin/contact-messages (admin inbox)
//
// The migrations (0078 / 0079) may not have run on every environment yet;
// this creates both tables idempotently on first use. The module-level flag
// prevents re-running DDL on every request.

import { getNeonSql } from "../../db/neon";

let ensured = false;

export async function ensureContactTables(sql: ReturnType<typeof getNeonSql>) {
  if (ensured) return;
  await sql`
    CREATE TABLE IF NOT EXISTS contact_messages (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255),
      email VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'new',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMP
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_contact_messages_status
    ON contact_messages (status, created_at)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS contact_message_replies (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES contact_messages(id) ON DELETE CASCADE,
      admin_clerk_id VARCHAR(255) NOT NULL,
      admin_name VARCHAR(255) NOT NULL,
      reply TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_contact_message_replies_message
    ON contact_message_replies (message_id)
  `;
  ensured = true;
}
