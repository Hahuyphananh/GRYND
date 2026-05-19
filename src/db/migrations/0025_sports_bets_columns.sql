-- Migration: Add missing columns to sports_bets for market type, line value, external event IDs
-- These columns are referenced in the place-sports-bet, my-bets, and settle routes
-- but were never added via any previous migration.

-- Add event_external_id for The Odds API event IDs (differs from internal event_id)
ALTER TABLE sports_bets ADD COLUMN IF NOT EXISTS event_external_id VARCHAR(255);

-- Add market_type for bet classification (h2h, spreads, totals, props)
ALTER TABLE sports_bets ADD COLUMN IF NOT EXISTS market_type VARCHAR(40);

-- Add line_value for spreads/totals handicap lines
ALTER TABLE sports_bets ADD COLUMN IF NOT EXISTS line_value NUMERIC(8, 2);

-- Add selection_metadata for extensible bet data
ALTER TABLE sports_bets ADD COLUMN IF NOT EXISTS selection_metadata JSONB DEFAULT '{}'::jsonb;

-- Make event_id nullable since we now primarily use event_external_id for external API events
ALTER TABLE sports_bets ALTER COLUMN event_id DROP NOT NULL;
