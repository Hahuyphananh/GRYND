INSERT INTO users (name, email, password, age, balance, games_won, games_lost, created_at)
VALUES 
  ('Alice Johnson', 'alice@example.com', '$2b$10$J8WwxtzvXy0JIQ1YgkZUUeVmwV5rpdx4im5KUYSlWRBfE38DCOTtq', 28, 1500.00, 12, 3, NOW()),
  ('Bob Smith', 'bob@example.com', '$2b$10$J8WwxtzvXy0JIQ1YgkZUUeVmwV5rpdx4im5KUYSlWRBfE38DCOTtq', 34, 800.00, 5, 7, NOW()),
  ('Charlie Brown', 'charlie@example.com', '$2b$10$J8WwxtzvXy0JIQ1YgkZUUeVmwV5rpdx4im5KUYSlWRBfE38DCOTtq', 22, 1000.00, 0, 0, NOW()),
  ('Dana Lee', 'dana@example.com', '$2b$10$J8WwxtzvXy0JIQ1YgkZUUeVmwV5rpdx4im5KUYSlWRBfE38DCOTtq', 30, 2300.50, 20, 1, NOW()),
  ('Evan Davis', 'evan@example.com', '$2b$10$J8WwxtzvXy0JIQ1YgkZUUeVmwV5rpdx4im5KUYSlWRBfE38DCOTtq', 25, 500.75, 3, 10, NOW());
