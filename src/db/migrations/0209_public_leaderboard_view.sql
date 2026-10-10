-- 0209: A public leaderboard view — ratings joined to display columns only.
--
-- ── Why a view instead of policies on `users` ───────────────────────────
-- A leaderboard row is `user_id + rating`; the board is useless without the
-- player's name and avatar, and those live in `users` — 71 columns including
-- `email`, `password`, `is_admin`, `ban_reason`, `balance` and
-- `daily_loss_limit`. RLS policies are ROW-level, not column-level, so the
-- usual table-level policy plus the default grants would expose every column
-- of every row to anyone holding the publishable key. Column-level GRANTs
-- would narrow that, but they still let a client page through every rated
-- player, and they put the boundary in a place future edits are unlikely to
-- notice.
--
-- A view moves the boundary somewhere explicit: this projection IS the
-- contract. It exposes exactly the columns listed below, of exactly the rows
-- that join, and `users` itself stays closed (0207's deny policy).
--
-- ── How the privileges work (important) ─────────────────────────────────
-- The view is created WITHOUT `security_invoker`, so it executes with its
-- owner's privileges (`postgres`, which owns the tables and has
-- `rolbypassrls = true`). That is deliberate: the base tables' RLS is not
-- consulted for the caller, which is what lets the view read `users` while
-- `users` remains unreadable from PostgREST. The view's own SELECT grant is
-- therefore the entire access-control boundary for this surface — which is
-- why the column list below is the thing to review, and why nothing sensitive
-- may ever be added to it.
--
-- ── Deliberately NOT exposed ────────────────────────────────────────────
-- `users.clerk_id` is omitted. The JSON API returns it so the board can mark
-- "you", but that is a per-request server decision; publishing stable Clerk
-- identifiers from the database surface is not necessary for the boards, and
-- the client-side "me" row needs the per-user read path (a Clerk-JWT-bound
-- policy) that stage 2 has not built yet. Until then the client boards render
-- every player and simply cannot highlight the viewer.
--
-- Also not exposed: no money columns, no streak/wager data, no email, no
-- clerk_id, no admin flags. `player_trophies` gets the same treatment when its
-- board is cut over; this file is scoped to the Elo boards.
--
-- Idempotent: CREATE OR REPLACE VIEW, and GRANT/REVOKE are idempotent.
--> statement-breakpoint

CREATE OR REPLACE VIEW public.leaderboard_rows AS
SELECT
  r.user_id,
  r.game_key,
  r.rating,
  r.peak_rating,
  r.games_rated,
  r.wins,
  r.losses,
  r.draws,
  r.last_rated_at,
  r.updated_at,
  u.username,
  u.image_url,
  u.profile_picture,
  u.selected_title,
  u.selected_icon,
  u.level,
  u.xp
FROM public.player_ratings r
JOIN public.users u ON u.id = r.user_id;
--> statement-breakpoint

GRANT SELECT ON public.leaderboard_rows TO anon, authenticated;
--> statement-breakpoint

-- Read-only, explicitly: the view is a projection, never a writable surface.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.leaderboard_rows FROM anon, authenticated;
