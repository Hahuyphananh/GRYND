ALTER TABLE neon_territory_actions
  ADD COLUMN IF NOT EXISTS action_type TEXT NOT NULL DEFAULT 'attack';

UPDATE neon_territory_actions
SET action_type = 'attack'
WHERE action_type IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'neon_territory_actions_action_type_check'
  ) THEN
    ALTER TABLE neon_territory_actions
      ADD CONSTRAINT neon_territory_actions_action_type_check
      CHECK (action_type IN ('attack', 'reinforce', 'fortify'));
  END IF;
END $$;
