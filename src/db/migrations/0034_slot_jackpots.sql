-- Progressive Slot Jackpots
CREATE TABLE IF NOT EXISTS slot_jackpots (
  theme VARCHAR(30) PRIMARY KEY,
  amount NUMERIC(14,2) NOT NULL DEFAULT 1000.00,
  seed_amount NUMERIC(14,2) NOT NULL DEFAULT 1000.00,
  contribution_rate NUMERIC(5,4) NOT NULL DEFAULT 0.0200,
  total_contributed NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  times_won INTEGER NOT NULL DEFAULT 0,
  last_won_by VARCHAR(255),
  last_won_amount NUMERIC(14,2),
  last_won_at TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Seed initial jackpots for all 4 themes
INSERT INTO slot_jackpots (theme, amount, seed_amount) VALUES
  ('fruit', 1000.00, 1000.00),
  ('gems', 1000.00, 1000.00),
  ('sevens', 1000.00, 1000.00),
  ('egyptian', 1000.00, 1000.00)
ON CONFLICT (theme) DO NOTHING;
