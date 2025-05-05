INSERT INTO events (sport_id, team_a, team_b, start_time, odds_a, odds_b, odds_draw, status) VALUES
(1, 'Team Alpha', 'Team Beta', NOW() + INTERVAL '1 day', 1.50, 2.75, 3.10, 'upcoming'),
(2, 'Hoopers', 'Dunkers', NOW() + INTERVAL '2 days', 1.90, 1.90, NULL, 'upcoming'),
(3, 'Serve Kings', 'Net Smashers', NOW() + INTERVAL '3 days', 1.70, 2.20, NULL, 'upcoming');
