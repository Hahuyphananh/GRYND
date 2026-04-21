ALTER TABLE "chat_messages"
  ADD COLUMN IF NOT EXISTS "profile_image_url" text;

CREATE INDEX IF NOT EXISTS "chat_messages_created_at_idx"
  ON "chat_messages" ("created_at");

DELETE FROM "chat_messages"
WHERE "created_at" < now() - interval '24 hours';
