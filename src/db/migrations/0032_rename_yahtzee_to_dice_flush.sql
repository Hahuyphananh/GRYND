-- Rename yahtzee tables to dice_flush for full rebranding
ALTER TABLE IF EXISTS yahtzee_rooms RENAME TO dice_flush_rooms;
ALTER TABLE IF EXISTS yahtzee_players RENAME TO dice_flush_players;
ALTER TABLE IF EXISTS yahtzee_actions RENAME TO dice_flush_actions;

-- Rename indexes
ALTER INDEX IF EXISTS idx_yahtzee_rooms_status RENAME TO idx_dice_flush_rooms_status;
ALTER INDEX IF EXISTS idx_yahtzee_players_room_id RENAME TO idx_dice_flush_players_room_id;
ALTER INDEX IF EXISTS idx_yahtzee_actions_room_id RENAME TO idx_dice_flush_actions_room_id;
