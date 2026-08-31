-- ── 0131: Rebrand Connect Four → Four-In-A-Row ──
--
-- Renames the game's table + supporting indexes from `connect_four_games`
-- to `four_in_a_row_games` (display/branding only — same columns, same data).
-- Historical migrations (0037, 0092) that reference the old name are left
-- untouched; this migration is the forward step that moves the live table.
--
-- Safe: `ALTER TABLE ... RENAME` and index renames are metadata-only and
-- preserve all rows, constraints, and column data. No data is rewritten.

ALTER TABLE IF EXISTS "connect_four_games" RENAME TO "four_in_a_row_games";

ALTER INDEX IF EXISTS "connect_four_status_idx" RENAME TO "four_in_a_row_status_idx";
ALTER INDEX IF EXISTS "connect_four_host_idx" RENAME TO "four_in_a_row_host_idx";
ALTER INDEX IF EXISTS "connect_four_guest_idx" RENAME TO "four_in_a_row_guest_idx";