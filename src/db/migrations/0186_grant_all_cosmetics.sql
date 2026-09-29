-- 0186: Grant every cosmetic item to every player, for free.
--
-- The Battle Pass was the only way to earn its cosmetics. With the pass removed
-- (0185), nothing can be earned any more, so the entire catalog is granted
-- outright: every enabled glow, every enabled animated emote, every cosmetic
-- (frames / badges / avatar + username + chat effects / profile glows) and
-- every special title — for every existing account, whether or not they had
-- earned it.
--
-- Ownership rows only. Equipping is untouched: a player still chooses what to
-- wear through the existing pickers (owned ⇒ equippable). New accounts get the
-- same grant at creation (grantAllCosmeticsToUser in src/lib/cosmetics.ts).
--
-- Idempotent: the NOT EXISTS guards make a re-run a no-op.

INSERT INTO "user_glows" ("user_id", "glow_key")
SELECT u."id", g."key"
FROM "users" u
CROSS JOIN "glows" g
WHERE g."enabled" = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM "user_glows" ug WHERE ug."user_id" = u."id" AND ug."glow_key" = g."key"
  );
--> statement-breakpoint

INSERT INTO "user_emotes" ("user_id", "emote_key")
SELECT u."id", e."key"
FROM "users" u
CROSS JOIN "emotes" e
WHERE e."enabled" = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM "user_emotes" ue WHERE ue."user_id" = u."id" AND ue."emote_key" = e."key"
  );
--> statement-breakpoint

INSERT INTO "user_cosmetics" ("user_id", "cosmetic_key", "source")
SELECT u."id", c."key", 'grant'
FROM "users" u
CROSS JOIN "cosmetics" c
WHERE c."enabled" = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM "user_cosmetics" uc WHERE uc."user_id" = u."id" AND uc."cosmetic_key" = c."key"
  );
--> statement-breakpoint

INSERT INTO "user_special_titles" ("user_id", "title_key")
SELECT u."id", st."key"
FROM "users" u
CROSS JOIN "special_titles" st
WHERE NOT EXISTS (
  SELECT 1 FROM "user_special_titles" ust
   WHERE ust."user_id" = u."id" AND ust."title_key" = st."key"
);
