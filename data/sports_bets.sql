INSERT INTO sports_bets (user_id, event_id, bet_amount, choice, odds, payout, result, placed_at) VALUES
(1, 1, 100.00, 'teamA', 1.50, 150.00, 'win', NOW()),
(2, 2, 50.00, 'teamB', 1.90, 0.00, 'loss', NOW()),
(3, 3, 75.00, 'teamA', 1.70, NULL, 'pending', NOW());
