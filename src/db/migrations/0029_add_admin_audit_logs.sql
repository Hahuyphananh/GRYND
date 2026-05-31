-- Migration: add admin_audit_logs table for persisted audit trail
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id SERIAL PRIMARY KEY,
  event VARCHAR(100) NOT NULL,
  clerk_id VARCHAR(255) NOT NULL,
  target_clerk_id VARCHAR(255),
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_event ON admin_audit_logs (event, created_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_clerk ON admin_audit_logs (clerk_id, created_at);
