INSERT INTO chess_games (player_white_id, player_black_id, bet_amount, winner_id, result, payout, created_at) VALUES
(1, 2, 100.00, 1, 'win', 200.00, NOW()),
(2, 3, 50.00, 3, 'win', 100.00, NOW()),
(3, 1, 75.00, NULL, 'draw', 75.00, NOW());
