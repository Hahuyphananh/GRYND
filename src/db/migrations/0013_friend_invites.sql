CREATE TABLE IF NOT EXISTS friend_invites (
  id SERIAL PRIMARY KEY,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT friend_invites_no_self CHECK (sender_id <> receiver_id)
);

CREATE INDEX IF NOT EXISTS friend_invites_receiver_status_idx ON friend_invites(receiver_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS friend_invites_sender_status_idx ON friend_invites(sender_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS friend_invites_pending_pair_unique
ON friend_invites(sender_id, receiver_id)
WHERE status = 'pending';
