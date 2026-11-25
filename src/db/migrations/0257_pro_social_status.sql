-- 0257: GRYND PRO social status — the PRO-only cosmetic entitlement.
--
-- WHY
-- ---
-- Every membership benefit shipped so far was PRIVATE (no ads, more analysis, a
-- queue tie-break) or persisted per account. Competitive players pay to support
-- the game and want that support to be visible, so the offer now includes
-- identity flair other players can see.
--
-- WHAT
-- ----
--   * `cosmetics.pro_only` — a catalog flag. A PRO-only cosmetic is never
--     granted by the account-creation catalog grant and cannot be equipped by a
--     non-member (src/lib/cosmetics.ts enforces it on the server; the client
--     cannot ask for it).
--   * Two signature PRO frames. They carry NO price and NO unlock condition:
--     they are not sold for coins and are not earned — equipping one is the
--     grant. Every other cosmetic in the catalog stays free and unchanged, which
--     is the product rule this migration deliberately does not touch.
--
-- Idempotent: the ALTER is IF NOT EXISTS and the seed is an upsert by key.
-- Additive only: no existing cosmetic is modified, priced or disabled.

ALTER TABLE "cosmetics"
  ADD COLUMN IF NOT EXISTS "pro_only" BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO "cosmetics"
  ("key", "name", "description", "category", "rarity", "visual",
   "price_tokens", "unlock_condition", "enabled", "sort_order", "pro_only")
VALUES
  (
    'pro_founder_frame',
    'Founder Frame',
    'A gold-and-cyan frame for GRYND PRO members who backed the site while it was small.',
    'profile_frame',
    'Founder',
    '{"cssClass":"frame-founder"}'::jsonb,
    NULL,
    NULL,
    TRUE,
    900,
    TRUE
  ),
  (
    'pro_supporter_frame',
    'Supporter Frame',
    'The GRYND PRO supporter frame — proof that you keep the tables open.',
    'profile_frame',
    'Supporter',
    '{"cssClass":"frame-supporter"}'::jsonb,
    NULL,
    NULL,
    TRUE,
    901,
    TRUE
  )
ON CONFLICT ("key") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category",
  "rarity" = EXCLUDED."rarity",
  "visual" = EXCLUDED."visual",
  "price_tokens" = NULL,
  "unlock_condition" = NULL,
  "enabled" = TRUE,
  "pro_only" = TRUE;
