-- 0112: Mines PvP Quick Queue preferences

ALTER TABLE quick_queue_readiness
  ADD COLUMN IF NOT EXISTS mines_stake_amount numeric(14, 2),
  ADD COLUMN IF NOT EXISTS mines_count integer;

ALTER TABLE quick_queue_requests
  ADD COLUMN IF NOT EXISTS mines_stake_amount numeric(14, 2),
  ADD COLUMN IF NOT EXISTS mines_count integer;

ALTER TABLE quick_queue_readiness
  ADD CONSTRAINT quick_queue_readiness_mines_count_valid
  CHECK (mines_count IS NULL OR (mines_count >= 1 AND mines_count <= 24));

ALTER TABLE quick_queue_requests
  ADD CONSTRAINT quick_queue_requests_mines_count_valid
  CHECK (mines_count IS NULL OR (mines_count >= 1 AND mines_count <= 24));
