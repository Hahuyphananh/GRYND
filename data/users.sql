INSERT INTO users (clerk_id, name, email, password, age, balance, games_won, games_lost, created_at)
VALUES 
  ('user_001', 'Alice Johnson', 'alice@example.com', '$2b$10$J8WwxtzvXy0JIQ1YgkZUUeVmwV5rpdx4im5KUYSlWRBfE38DCOTtq', 28, 1500.00, 12, 3, NOW()),
  ('user_002', 'Bob Smith', 'bob@example.com', '$2b$10$J8WwxtzvXy0JIQ1YgkZUUeVmwV5rpdx4im5KUYSlWRBfE38DCOTtq', 34, 800.00, 5, 7, NOW()),
  ('user_003', 'Charlie Brown', 'charlie@example.com', '$2b$10$J8WwxtzvXy0JIQ1YgkZUUeVmwV5rpdx4im5KUYSlWRBfE38DCOTtq', 22, 1000.00, 0, 0, NOW()),
  ('user_004', 'Dana Lee', 'dana@example.com', '$2b$10$J8WwxtzvXy0JIQ1YgkZUUeVmwV5rpdx4im5KUYSlWRBfE38DCOTtq', 30, 2300.50, 20, 1, NOW()),
  ('user_005', 'Evan Davis', 'evan@example.com', '$2b$10$J8WwxtzvXy0JIQ1YgkZUUeVmwV5rpdx4im5KUYSlWRBfE38DCOTtq', 25, 500.75, 3, 10, NOW());
