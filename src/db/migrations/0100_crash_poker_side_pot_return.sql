-- Crash Poker — side-pot returns.
--
-- When a fold-out winner is all-in for less than other (folded) players'
-- contributions, poker-style tiering returns the uncontested side-pot money
-- to the players who funded it (\"you can only win chips you matched\"). Those
-- refunds are credited to the table balance and ledgered with a new RETURN
-- transaction type, appended to the existing enum exactly like 0044/0055/0064.

ALTER TYPE "crash_arena_transaction_type" ADD VALUE IF NOT EXISTS 'RETURN';
