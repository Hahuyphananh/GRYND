-- 0217: PRIVATE ROOMS + FRIEND CHALLENGES (rooms / invite-only matches).
--
-- WHY A NEW TABLE (and not a column on a game table)
-- --------------------------------------------------
-- The platform's multiplayer games create matches through two different
-- mechanisms: `create-or-join` (a public pool the store pairs from) and an
-- explicit lobby + atomic claim (`pool`, `precision`, `tower-arena`). Neither
-- carries an "invite-only" notion, and adding one to each game's live lobby
-- table would mean editing queries that public matchmaking depends on.
--
-- A room is therefore its own record — who may be in it, for which game, with
-- which settings, and (once it starts) which real match it became — and the
-- match itself is still created by the GAME'S OWN store. Nothing about public
-- matchmaking changes, and no game table gains a column.
--
-- TWO KINDS, ONE MODEL
-- --------------------
--   * `room`      — a GRYND PRO custom room. Created only by a verified member,
--                   carries an unguessable `code` that can be shared, may invite
--                   several friends, and is started by the host.
--   * `challenge` — a FREE direct challenge to ONE friend. It is deliberately
--                   not a general-purpose room: `code` stays NULL (there is
--                   nothing to share or brute-force), only one invitee may ever
--                   be attached, the settings are chosen by the server, and it
--                   starts the moment the friend accepts. That is what makes
--                   "challenge a friend" free without handing every account
--                   standalone room-creation privileges.
--
-- `private_room_members` is the invitation list AND the roster: one row per
-- (room, user), with `invite_status` tracking invited/accepted/declined and
-- `role` marking the host. UNIQUE (room_id, user_id) is the duplicate-join and
-- duplicate-invite guard.
--
-- IDEMPOTENT AND ADDITIVE: CREATE ... IF NOT EXISTS only, no existing table,
-- row or index is touched, and no historical data is invented.

CREATE TABLE IF NOT EXISTS "private_rooms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Shareable join code. UNIQUE and NULL for a challenge (see the header).
  "code" varchar(16),
  -- 'room' (PRO custom room) | 'challenge' (free 1v1 friend challenge).
  "kind" varchar(16) NOT NULL,
  -- Clerk id of the creator. The host is the only account that may invite,
  -- start or cancel.
  "host_user_id" text NOT NULL,
  -- Canonical game key from the room adapter registry (src/lib/rooms/games).
  "game_key" varchar(64) NOT NULL,
  -- Game mode id the adapter declares (both supported modes are 1v1 duels).
  "mode" varchar(32) NOT NULL DEFAULT 'pvp',
  -- Validated room settings (see the adapter's settings schema). Server-written.
  "settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- open       — waiting for invites / accepts
  -- starting   — a start is in flight (claimed; the match is being created).
  --              `claimed_at` is stamped; a stale claim is released by the
  --              lazy sweep, so the room cannot get stuck here.
  -- started    — the real match exists; `match_id` / `match_url` are set
  -- declined   — a challenge the friend declined
  -- expired    — past `expires_at` (swept lazily on read/write)
  -- cancelled  — the host cancelled, or everybody left
  -- failed     — the game refused to create the match (e.g. a seat cannot
  --              afford the room's stake); the room releases instead of
  --              pretending a match exists
  "status" varchar(16) NOT NULL DEFAULT 'open',
  -- The game's own match id once it exists (never client-supplied).
  "match_id" varchar(128),
  -- Where the participants go (the game's own match route).
  "match_url" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  -- Every room is time-boxed: a stale invitation must not stay joinable.
  "expires_at" timestamp NOT NULL,
  -- When a start claimed the room (status 'starting'). A claim that never
  -- finished (the instance died mid-create) is the ONLY stuck state a room can
  -- reach, so it is stamped explicitly: the lazy sweep releases any claim older
  -- than CLAIM_STALE_MS back to 'open' instead of leaving a room that can never
  -- be started or joined again. Cleared on success and on release.
  "claimed_at" timestamp,
  "started_at" timestamp,
  "closed_at" timestamp
);

-- A code is unique across every room that has one.
CREATE UNIQUE INDEX IF NOT EXISTS "private_rooms_code_unique"
  ON "private_rooms" ("code")
  WHERE "code" IS NOT NULL;

-- "the rooms I host" + the expiry sweep.
CREATE INDEX IF NOT EXISTS "private_rooms_host_status_idx"
  ON "private_rooms" ("host_user_id", "status");

CREATE INDEX IF NOT EXISTS "private_rooms_status_expires_idx"
  ON "private_rooms" ("status", "expires_at");

CREATE TABLE IF NOT EXISTS "private_room_members" (
  "id" serial PRIMARY KEY,
  "room_id" uuid NOT NULL REFERENCES "private_rooms"("id") ON DELETE CASCADE,
  -- Clerk id: room membership is per account, and a room must survive a
  -- profile rename (the stored `name` is only a display snapshot).
  "user_id" text NOT NULL,
  -- 'host' | 'guest'.
  "role" varchar(16) NOT NULL,
  -- 'invited' | 'accepted' | 'declined'.
  "invite_status" varchar(16) NOT NULL DEFAULT 'invited',
  -- Display snapshot for the room status list (never an identity).
  "name" text,
  "invited_at" timestamp NOT NULL DEFAULT now(),
  "responded_at" timestamp,
  "joined_at" timestamp
);

-- THE DUPLICATE GUARD: one row per player per room, so a replayed invite or a
-- double join can never create a second membership (and the join path can use
-- ON CONFLICT DO NOTHING to stay idempotent).
CREATE UNIQUE INDEX IF NOT EXISTS "private_room_members_room_user_unique"
  ON "private_room_members" ("room_id", "user_id");

-- "the invitations addressed to me" (the Friends tab's pending list).
CREATE INDEX IF NOT EXISTS "private_room_members_user_status_idx"
  ON "private_room_members" ("user_id", "invite_status");
