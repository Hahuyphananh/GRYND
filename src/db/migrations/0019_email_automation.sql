-- Email automation persistence
CREATE TABLE IF NOT EXISTS email_events (
  id serial PRIMARY KEY,
  clerk_id varchar(255),
  user_email varchar(255) NOT NULL,
  type varchar(80) NOT NULL,
  category varchar(30) NOT NULL DEFAULT 'marketing',
  dedupe_key varchar(255),
  status varchar(20) NOT NULL DEFAULT 'sent',
  meta jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_events_clerk_created_idx
  ON email_events (clerk_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS email_events_type_dedupe_sent_idx
  ON email_events (type, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status = 'sent';

CREATE TABLE IF NOT EXISTS user_automation_state (
  clerk_id varchar(255) PRIMARY KEY,
  last_login_at timestamp NOT NULL DEFAULT now(),
  last_inactivity_email_sent_at timestamp,
  inactivity_cycle_start_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_automation_last_login_idx
  ON user_automation_state (last_login_at);
