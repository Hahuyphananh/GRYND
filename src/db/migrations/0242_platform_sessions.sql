-- 0242_platform_sessions.sql
--
-- EXTERNAL PLATFORM EMBED SESSIONS (Phase 5).
--
-- ── WHAT THIS TABLE IS ───────────────────────────────────────────────────
--
-- One row per short-lived, server-minted session that lets an authorized
-- platform run ONE supported GRYND game inside an iframe. A platform's backend
-- creates it with its own secret (never shipped to a browser); the iframe
-- receives only the opaque token, and every API call made by the embedded
-- client presents that token.
--
--   token_hash       SHA-256 of the bearer token. The raw token is returned once
--                    to the platform backend and is never stored, so a database
--                    leak cannot be replayed as a live session.
--   platform         The allowlisted platform slug (configured in env, never a
--                    client claim).
--   platform_origin  The exact https origin allowed to frame this game. CSP for
--                    /embed/* is built from the same allowlist.
--   guest_id         A server-minted `guest_<32 hex>` identity. It is scoped to
--                    this session; it is NOT the browser's 30-day `grynd_guest`
--                    cookie and can never be used to claim that guest record.
--
-- ── WHAT IT DELIBERATELY DOES NOT HAVE ───────────────────────────────────
--
-- No `user_id`, no Clerk id, no email. An external session can never become an
-- account: it can only ever act as an unrated guest. Linking a platform session
-- to an account would require the normal Clerk sign-in flow, which this table
-- has no path to.
--
-- ── EXPIRY / REVOCATION ──────────────────────────────────────────────────
--
-- Sessions are short-lived (15 minutes, set by the writer). `ended_at` is set by
-- the revoke endpoint or when the platform closes the game. Reads reject ended
-- and expired rows; nothing is deleted here, so an audit trail remains until a
-- later retention job is added.
--
-- ── INDEXES ──────────────────────────────────────────────────────────────
--
-- The primary key is the only lookup used by validation (token hash). The expiry
-- index exists so a future sweep can find stale rows without a full scan.

CREATE TABLE IF NOT EXISTS "platform_sessions" (
  "token_hash" varchar(64) PRIMARY KEY,
  "platform" varchar(32) NOT NULL,
  "game_key" varchar(32) NOT NULL,
  "platform_origin" varchar(255) NOT NULL,
  "guest_id" varchar(64) NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "expires_at" timestamp NOT NULL,
  "ended_at" timestamp,
  CONSTRAINT "platform_sessions_guest_id_format"
    CHECK ("guest_id" ~ '^guest_[A-Za-z0-9_-]{1,58}$'),
  CONSTRAINT "platform_sessions_expiry_after_creation"
    CHECK ("expires_at" > "created_at")
);

CREATE INDEX IF NOT EXISTS "platform_sessions_expiry_idx"
  ON "platform_sessions" ("expires_at");

COMMENT ON TABLE "platform_sessions" IS
  'Short-lived server-minted sessions authorizing one platform to embed one supported game as an unrated guest';
COMMENT ON COLUMN "platform_sessions"."token_hash" IS
  'SHA-256 of the bearer token; the raw token is never stored';
COMMENT ON COLUMN "platform_sessions"."guest_id" IS
  'Server-minted guest identity scoped to this session; never the grynd_guest cookie identity';
COMMENT ON COLUMN "platform_sessions"."ended_at" IS
  'Set by revoke/close; validation rejects ended and expired rows';
