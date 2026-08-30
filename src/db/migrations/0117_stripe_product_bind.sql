-- 0117: Offer bound to a real Stripe product.
--
-- Adds a Shop token offer whose price is resolved live from the Stripe product
-- `prod_VAIDsyJFxIGdG8` (the display price and the charge both come from that
-- product's active one-time price — see
-- src/lib/stripe/packages.ts::resolvePackagePriceCents / ensurePackageStripe).
--
-- `price_cents` is stored as 0 as a safe placeholder; the authoritative price
-- is the Stripe price on the bound product. `token_amount` is the base token
-- award (server-authoritative) — set it to the real amount before selling.
-- Idempotent: upserts on `key`.

INSERT INTO "token_packages" ("key", "name", "token_amount", "bonus_tokens", "price_cents", "stripe_product_id", "stripe_price_id", "badge", "enabled", "featured", "sort_order")
VALUES ('own', 'Grynd Tokens', 1000, 0, 0, 'prod_VAIDsyJFxIGdG8', NULL, NULL, true, false, 0)
ON CONFLICT ("key") DO UPDATE SET
  "stripe_product_id" = EXCLUDED."stripe_product_id",
  "enabled"           = EXCLUDED."enabled";
--> statement-breakpoint