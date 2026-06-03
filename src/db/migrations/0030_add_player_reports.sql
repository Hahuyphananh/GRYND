-- Migration: add player_reports table for player-to-player reporting system
-- Also add is_banned column to users for admin ban functionality

CREATE TABLE IF NOT EXISTS player_reports (
  id SERIAL PRIMARY KEY,
  reporter_clerk_id VARCHAR(255) NOT NULL,
  reported_clerk_id VARCHAR(255) NOT NULL,
  game_type VARCHAR(50) NOT NULL,
  game_id VARCHAR(100),
  reason VARCHAR(50) NOT NULL,
  details TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMP,
  resolved_by_clerk_id VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_player_reports_status ON player_reports (status, created_at);
CREATE INDEX IF NOT EXISTS idx_player_reports_reported ON player_reports (reported_clerk_id);

-- Add is_banned column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_users_is_banned ON users (is_banned);
