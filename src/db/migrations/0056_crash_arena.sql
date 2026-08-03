-- Crash Arena migration
-- Tables: crash_arena_tables, crash_arena_players, crash_arena_rounds,
--          crash_arena_entries, crash_arena_transactions
-- Enums: crash_arena_status, crash_arena_transaction_type

-- ── Enums ─────────────────────────────────────────────────────────────────

CREATE TYPE "crash_arena_status" AS ENUM ('waiting', 'active', 'closed');
CREATE TYPE "crash_arena_transaction_type" AS ENUM ('BUY_IN', 'WIN', 'LEAVE', 'RAKE');

-- ── Tables (lobby) ────────────────────────────────────────────────────────

CREATE TABLE "crash_arena_tables" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" varchar(255) NOT NULL,
  "wager_amount" numeric(10, 2) NOT NULL,
  "minimum_buyin" numeric(10, 2) NOT NULL,
  "max_players" integer NOT NULL DEFAULT 6,
  "status" "crash_arena_status" NOT NULL DEFAULT 'waiting',
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX "idx_crash_arena_tables_status" ON "crash_arena_tables" ("status", "created_at");

-- ── Players at tables ─────────────────────────────────────────────────────

CREATE TABLE "crash_arena_players" (
  "id" serial PRIMARY KEY NOT NULL,
  "table_id" integer NOT NULL REFERENCES "crash_arena_tables" ("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "balance" numeric(14, 2) NOT NULL DEFAULT '0.00',
  "status" varchar(20) NOT NULL DEFAULT 'seated',
  "joined_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX "idx_crash_arena_players_table_user" ON "crash_arena_players" ("table_id", "user_id");

-- ── Rounds ─────────────────────────────────────────────────────────────────

CREATE TABLE "crash_arena_rounds" (
  "id" serial PRIMARY KEY NOT NULL,
  "table_id" integer NOT NULL REFERENCES "crash_arena_tables" ("id") ON DELETE CASCADE,
  "seed" varchar(255),
  "seed_hash" varchar(255),
  "crash_point" numeric(6, 2),
  "status" varchar(20) NOT NULL DEFAULT 'waiting',
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX "idx_crash_arena_rounds_table" ON "crash_arena_rounds" ("table_id", "created_at");

-- ── Round entries (one per player per round) ──────────────────────────────

CREATE TABLE "crash_arena_entries" (
  "id" serial PRIMARY KEY NOT NULL,
  "round_id" integer NOT NULL REFERENCES "crash_arena_rounds" ("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "cashout_multiplier" numeric(6, 2),
  "cashout_timestamp" timestamp,
  "result" varchar(20) NOT NULL DEFAULT 'pending'
);

CREATE INDEX "idx_crash_arena_entries_round_user" ON "crash_arena_entries" ("round_id", "user_id");

-- ── Transactions ──────────────────────────────────────────────────────────

CREATE TABLE "crash_arena_transactions" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "table_id" integer NOT NULL REFERENCES "crash_arena_tables" ("id") ON DELETE CASCADE,
  "amount" numeric(14, 2) NOT NULL,
  "type" "crash_arena_transaction_type" NOT NULL,
  "reason" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX "idx_crash_arena_tx_user" ON "crash_arena_transactions" ("user_id", "created_at");
CREATE INDEX "idx_crash_arena_tx_table" ON "crash_arena_transactions" ("table_id", "created_at");
