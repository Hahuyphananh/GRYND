-- 0106: Availability alert subscriptions and delivery deduplication

CREATE TABLE IF NOT EXISTS availability_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar(255) NOT NULL,
  game_key varchar(80),
  mode varchar(80),
  region varchar(80),
  min_player_count integer NOT NULL DEFAULT 1,
  max_wait_ms integer,
  active boolean NOT NULL DEFAULT true,
  expires_at timestamp,
  last_triggered_at timestamp,
  created_at timestamp NOT NULL DEFAULT NOW(),
  updated_at timestamp NOT NULL DEFAULT NOW(),
  CONSTRAINT availability_alerts_min_players_positive CHECK (min_player_count > 0),
  CONSTRAINT availability_alerts_max_wait_positive CHECK (max_wait_ms IS NULL OR max_wait_ms > 0)
);

CREATE TABLE IF NOT EXISTS availability_alert_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id uuid NOT NULL REFERENCES availability_alerts(id) ON DELETE CASCADE,
  availability_key varchar(255) NOT NULL,
  delivered_at timestamp NOT NULL DEFAULT NOW(),
  UNIQUE (alert_id, availability_key)
);

CREATE INDEX IF NOT EXISTS availability_alerts_active_lookup_idx
  ON availability_alerts (active, game_key, mode, region);

CREATE INDEX IF NOT EXISTS availability_alert_deliveries_alert_idx
  ON availability_alert_deliveries (alert_id, delivered_at);
