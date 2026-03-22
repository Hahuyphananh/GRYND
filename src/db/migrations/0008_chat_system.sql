DO $$ BEGIN
  CREATE TYPE "chat_room_type" AS ENUM('global', 'game');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "chat_messages" (
  "id" serial PRIMARY KEY NOT NULL,
  "room_type" "chat_room_type" DEFAULT 'global' NOT NULL,
  "room_id" varchar(255) NOT NULL,
  "clerk_id" varchar(255) NOT NULL,
  "display_name" varchar(255) NOT NULL,
  "content" text NOT NULL,
  "is_deleted" boolean DEFAULT false NOT NULL,
  "deleted_at" timestamp,
  "deleted_by_clerk_id" varchar(255),
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "chat_messages_room_idx"
  ON "chat_messages" ("room_type", "room_id", "created_at");

CREATE INDEX IF NOT EXISTS "chat_messages_moderation_idx"
  ON "chat_messages" ("is_deleted", "created_at");
