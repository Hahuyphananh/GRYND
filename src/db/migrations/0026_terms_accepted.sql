-- Migration: Add terms_accepted column to users table
-- Tracks whether the user has accepted the Terms & Conditions

ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted BOOLEAN NOT NULL DEFAULT false;
