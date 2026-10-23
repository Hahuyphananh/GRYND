// src/lib/coinPurchases.ts
//
// The ONE server-side authority for the optional one-time coin shop.
//
// Coins are GRYND's existing virtual currency (`users.balance`), used to enter
// wagered matches. They have no cash value and can never be cashed out,
// redeemed for gift cards or exchanged for money. Free rewards, daily rewards
// and multiplayer quests are untouched by this module.
//
// This file deliberately does NOT implement payment fulfilment. It provides:
//
//   * isCoinPurchasesEnabled()  — the feature flag. DISABLED unless the
//     deployment explicitly sets COIN_PURCHASES_ENABLED=1, so a fresh
//     environment (and production, today) never offers a purchase.
//   * INITIAL_COIN_OFFER_KEYS   — the small launch catalog, expressed purely as
//     KEYS into the EXISTING `token_packages` table. There is no second
//     package system: amounts, bonuses, prices, enabled state and ordering all
//     come from that table (see src/db/schema.ts and
//     src/lib/stripe/packages.ts).
//   * selectInitialCoinOffers() — a pure function that validates catalog rows
//     and turns them into display data. The client never supplies a price, a
//     coin amount or a currency; everything it renders is resolved here.
//   * resolveInitialCoinOffers() — the DB read used by the public catalog API.
//   * resolveCoinCheckoutPackage() / hasFulfilledPackagePurchase() — the
//     server-side package resolution and one-time-per-user check used by the
//     checkout route.
//   * buildCoinCheckoutSession() — a PURE builder for the Checkout Session
//     parameters, the idempotency key and the ledger row fields. It takes the
//     price id and charge that the server resolved; nothing it emits can be
//     influenced by a client-supplied amount, price id or redirect URL.
//   * COIN_CHECKOUT_READY       — the code-side launch switch, now TRUE for the
//     live shop. Sales are still gated at runtime by COIN_PURCHASES_ENABLED, so
//     an environment without the flag serves an empty catalog and refuses to
//     create a session. Flipping this constant back to false is the emergency
//     stop that needs no environment change and no redeploy of other code.
//
// Nothing in this module writes a balance or a Stripe object. The only write it
// supports is the `stripe_checkout_sessions` ledger row the route persists.

import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../db/client";
import { stripeCheckoutSessions, tokenPackages } from "../db/schema";
import { PACKAGE_CURRENCY } from "./stripe/packages";
import { formatMoney } from "./currency";

/**
 * The feature flag. Opt-in ONLY: the exact string "1" enables coin purchases.
 * Every other value — unset, empty, "0", "true", "yes" — leaves them disabled,
 * so no environment can start selling coins by accident.
 */
export const COIN_PURCHASES_FLAG = "COIN_PURCHASES_ENABLED";

/**
 * True only when the deployment explicitly enabled coin purchases.
 *
 * `env` is injectable so the flag is unit-testable without mutating
 * `process.env`.
 */
export function isCoinPurchasesEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env[COIN_PURCHASES_FLAG] ?? "").trim() === "1";
}

/**
 * The launch catalog: three offers, expressed as keys into `token_packages`.
 *
 * The rows already exist (seeded by migrations 0115–0156) and stay the single
 * source of truth for coin amounts, bonuses, prices, badge, enabled state and
 * ordering. A key that is missing, disabled or invalid simply drops out of the
 * catalog — it is never replaced by a code-side default.
 *
 * The requested Starter / Standard / Value ladder maps onto the existing
 * records:
 *   starter → Starter   (entry offer)
 *   medium  → Standard  (middle offer)
 *   large   → Value     (best tokens-per-dollar of the three)
 *
 * NOTE: the row names are shown as-is. Renaming them (or changing amounts and
 * prices) is a catalog/business decision made against the live economy, not
 * something this module invents.
 */
export const INITIAL_COIN_OFFER_KEYS = ["starter", "medium", "large"] as const;

export type CoinOfferKey = (typeof INITIAL_COIN_OFFER_KEYS)[number];

/**
 * The shop's three tier labels for the launch catalog. Presentation only — the
 * amount, bonus, price and currency still come from `token_packages`. Kept
 * server-side so the client renders a label the server chose instead of
 * hardcoding one (and so Starter/Standard/Value cannot drift from the keys).
 */
export const COIN_OFFER_TIERS: Record<CoinOfferKey, string> = {
  starter: "Starter",
  medium: "Standard",
  large: "Value",
};

/**
 * The currency both the displayed price and the Stripe charge use. Re-exported
 * from the package price creator so display and charge can never disagree by
 * picking different currencies.
 */
export const COIN_PACKAGE_CURRENCY: string = PACKAGE_CURRENCY;

/**
 * Whether a coin purchase can actually be completed end to end.
 *
 * The checkout route and the idempotent webhook fulfilment both exist; this
 * remains the FINAL go-live switch, deliberately closed in code as well as by
 * the (default-off) feature flag. Enabling purchased coins is a two-key action:
 * set COIN_PURCHASES_ENABLED=1 AND flip this to true in a reviewed change.
 *
 * While false, POST /api/coins/checkout refuses to create a session, so no
 * customer can be charged. No UI may render an active buy action either.
 */
export const COIN_CHECKOUT_READY = true;

/** The catalog columns this module reads — nothing else. */
export type CoinPackageRow = {
  key: string;
  name: string;
  tokenAmount: number;
  bonusTokens: number;
  priceCents: number;
  enabled: boolean;
  featured: boolean;
  sortOrder: number;
  badge?: string | null;
};

/** One offer as the client is allowed to see it, fully resolved server-side. */
export type CoinOffer = {
  key: string;
  /** Tier label for the shop card (Starter / Standard / Value). */
  tier: string;
  name: string;
  /** Base coins awarded (from the catalog). */
  coins: number;
  /** Bonus coins awarded on top (from the catalog). */
  bonusCoins: number;
  /** coins + bonusCoins — the total the buyer receives. */
  totalCoins: number;
  /** The amount Stripe charges, in `currency`. Never client-supplied. */
  priceCents: number;
  /** ISO currency code shared with the Stripe price (see PACKAGE_CURRENCY). */
  currency: string;
  /** `priceCents` written for display, symbol included (e.g. "$4.99"). */
  priceDisplay: string;
  badge: string | null;
  featured: boolean;
};

export type CoinPackageValidation =
  | { ok: true }
  | { ok: false; reason: string };

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Validate one catalog row before it can be offered. Pure and strict: a price
 * of 0 (the `own` row's placeholder, migration 0117), a fractional amount, a
 * negative bonus or a blank name all disqualify the offer rather than being
 * coerced into something sellable.
 */
export function validateCoinPackage(row: CoinPackageRow): CoinPackageValidation {
  if (!row || typeof row !== "object") return { ok: false, reason: "missing row" };
  if (typeof row.key !== "string" || row.key.trim() === "") {
    return { ok: false, reason: "missing key" };
  }
  if (typeof row.name !== "string" || row.name.trim() === "") {
    return { ok: false, reason: "missing name" };
  }
  if (row.enabled !== true) return { ok: false, reason: "not enabled" };
  if (!isPositiveInt(row.tokenAmount)) {
    return { ok: false, reason: "coin amount must be a positive integer" };
  }
  if (!isNonNegativeInt(row.bonusTokens)) {
    return { ok: false, reason: "bonus coins must be a non-negative integer" };
  }
  if (!isPositiveInt(row.priceCents)) {
    return { ok: false, reason: "price must be a positive integer number of cents" };
  }
  return { ok: true };
}

/** A row that failed validation, for server-side logging only. */
export type SkippedCoinPackage = { key: string; reason: string };

/**
 * Turn catalog rows into the launch catalog. PURE — no DB, no Stripe, no env —
 * so the catalog rules are unit-testable.
 *
 * Rules:
 *   * only keys in `INITIAL_COIN_OFFER_KEYS` are offered (a legacy row such as
 *     `mega`, `own`, `popular` or `big` can never leak into the shop),
 *   * every offered row must pass `validateCoinPackage`,
 *   * a duplicate key keeps the FIRST valid row,
 *   * order is the catalog's `sortOrder`, then key, so the server owns layout,
 *   * the amount, bonus, price and currency are copied from the row — never
 *     derived from anything a client sent.
 */
export function selectInitialCoinOffers(rows: readonly CoinPackageRow[]): {
  offers: CoinOffer[];
  skipped: SkippedCoinPackage[];
} {
  const allowed = new Set<string>(INITIAL_COIN_OFFER_KEYS);
  const skipped: SkippedCoinPackage[] = [];
  const seen = new Set<string>();
  const selected: Array<{ offer: CoinOffer; sortOrder: number }> = [];

  for (const row of rows ?? []) {
    const key = String(row?.key ?? "");
    if (!allowed.has(key)) {
      if (key) skipped.push({ key, reason: "not part of the launch catalog" });
      continue;
    }
    const validation = validateCoinPackage(row);
    if (!validation.ok) {
      // `reason` is read with an `in` guard because this project compiles with
      // `strict` off, where a discriminated union is not narrowed by `!x.ok`
      // (same reason as the annotated result in src/lib/tokens/wager.ts).
      skipped.push({ key, reason: "reason" in validation ? validation.reason : "invalid" });
      continue;
    }
    if (seen.has(key)) {
      skipped.push({ key, reason: "duplicate key" });
      continue;
    }
    seen.add(key);
    selected.push({
      sortOrder: row.sortOrder ?? 0,
      offer: {
        key,
        tier: COIN_OFFER_TIERS[key as CoinOfferKey] ?? row.name.trim(),
        name: row.name.trim(),
        coins: row.tokenAmount,
        bonusCoins: row.bonusTokens,
        totalCoins: row.tokenAmount + row.bonusTokens,
        priceCents: row.priceCents,
        currency: COIN_PACKAGE_CURRENCY,
        // The displayed amount IS the charged amount: same cents, same
        // currency, one formatter (lib/currency) so the server and the client
        // render identical strings.
        priceDisplay: formatMoney(row.priceCents, COIN_PACKAGE_CURRENCY),
        badge: typeof row.badge === "string" && row.badge.trim() ? row.badge : null,
        featured: row.featured === true,
      },
    });
  }

  selected.sort(
    (a, b) => a.sortOrder - b.sortOrder || a.offer.key.localeCompare(b.offer.key),
  );

  return { offers: selected.map((entry) => entry.offer), skipped };
}

/**
 * Read the launch catalog from `token_packages`. Server-only.
 *
 * READ-ONLY and side-effect free: it never creates a Stripe product or price,
 * never writes the catalog and never touches a balance. Disabled rows are
 * filtered by the query AND re-checked by validation.
 */
export async function resolveInitialCoinOffers(): Promise<{
  offers: CoinOffer[];
  skipped: SkippedCoinPackage[];
  currency: string;
}> {
  const rows = await db
    .select({
      key: tokenPackages.key,
      name: tokenPackages.name,
      tokenAmount: tokenPackages.tokenAmount,
      bonusTokens: tokenPackages.bonusTokens,
      priceCents: tokenPackages.priceCents,
      enabled: tokenPackages.enabled,
      featured: tokenPackages.featured,
      sortOrder: tokenPackages.sortOrder,
      badge: tokenPackages.badge,
    })
    .from(tokenPackages)
    .where(
      and(
        eq(tokenPackages.enabled, true),
        inArray(tokenPackages.key, [...INITIAL_COIN_OFFER_KEYS]),
      ),
    )
    .orderBy(tokenPackages.sortOrder);

  const { offers, skipped } = selectInitialCoinOffers(rows);
  return { offers, skipped, currency: COIN_PACKAGE_CURRENCY };
}

// ── Checkout preparation ───────────────────────────────────────────────────

/** The catalog fields the checkout resolves. Server-side only. */
export type CoinCheckoutPackage = {
  id: number;
  key: string;
  name: string;
  tokenAmount: number;
  bonusTokens: number;
  /** The coins the buyer must receive — the ledger's reconciliation figure. */
  totalCoins: number;
  /** The catalog price the bound Stripe price must charge. */
  priceCents: number;
  stripeProductId: string | null;
  stripePriceId: string | null;
  /** True when each user may buy this package at most once. */
  oneTime: boolean;
};

/**
 * Resolve ONE purchasable package from the server's own catalog.
 *
 * Unknown, disabled, malformed and out-of-ladder keys all resolve to `null`, so
 * the caller answers identically for all of them (the client learns nothing
 * about a package that is not for sale). No amount, price or currency is ever
 * taken from the caller — only the key is.
 */
export async function resolveCoinCheckoutPackage(
  packageKey: string,
): Promise<CoinCheckoutPackage | null> {
  const key = typeof packageKey === "string" ? packageKey.trim() : "";
  if (!key) return null;
  if (!(INITIAL_COIN_OFFER_KEYS as readonly string[]).includes(key)) return null;

  const rows = await db
    .select({
      id: tokenPackages.id,
      key: tokenPackages.key,
      name: tokenPackages.name,
      tokenAmount: tokenPackages.tokenAmount,
      bonusTokens: tokenPackages.bonusTokens,
      priceCents: tokenPackages.priceCents,
      enabled: tokenPackages.enabled,
      featured: tokenPackages.featured,
      sortOrder: tokenPackages.sortOrder,
      oneTime: tokenPackages.oneTime,
      stripeProductId: tokenPackages.stripeProductId,
      stripePriceId: tokenPackages.stripePriceId,
    })
    .from(tokenPackages)
    .where(and(eq(tokenPackages.key, key), eq(tokenPackages.enabled, true)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  const validation = validateCoinPackage(row);
  if (!validation.ok) return null;

  return {
    id: row.id,
    key: row.key,
    name: row.name.trim(),
    tokenAmount: row.tokenAmount,
    bonusTokens: row.bonusTokens,
    totalCoins: row.tokenAmount + row.bonusTokens,
    priceCents: row.priceCents,
    stripeProductId: row.stripeProductId,
    stripePriceId: row.stripePriceId,
    oneTime: row.oneTime === true,
  };
}

/**
 * Has this user already BOUGHT this package?
 *
 * The durable answer is the ledger, not a client flag: a fulfilled one-time
 * Checkout Session row for the same user and package means the offer is spent.
 * Only `session_mode = 'payment'` rows count — a subscription session shares
 * the table and never spends a package.
 */
export async function hasFulfilledPackagePurchase(
  clerkId: string,
  packageKey: string,
): Promise<boolean> {
  if (!clerkId || !packageKey) return false;
  const rows = await db
    .select({ id: stripeCheckoutSessions.id })
    .from(stripeCheckoutSessions)
    .where(
      and(
        eq(stripeCheckoutSessions.clerkId, clerkId),
        eq(stripeCheckoutSessions.packageKey, packageKey),
        eq(stripeCheckoutSessions.sessionMode, "payment"),
        eq(stripeCheckoutSessions.fulfilled, true),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * How long two identical requests are considered the same purchase. A retry,
 * a double-click or a duplicated tab inside this window reuses the same Stripe
 * idempotency key, so at most ONE session can be created for it.
 */
export const COIN_CHECKOUT_IDEMPOTENCY_WINDOW_MS = 5 * 60_000;

/**
 * The Stripe idempotency key for one user buying one package in one time
 * window. Deterministic and server-derived: the client cannot choose it, and a
 * replayed request within the window returns the SAME session instead of
 * opening a second one. Clerk ids are hashed so the key itself carries no
 * user identifier into Stripe's logs.
 */
export function coinCheckoutIdempotencyKey(
  clerkId: string,
  packageKey: string,
  now: number = Date.now(),
): string {
  const bucket = Math.floor(now / COIN_CHECKOUT_IDEMPOTENCY_WINDOW_MS);
  const digest = createHash("sha256")
    .update(`${clerkId}|${packageKey}|${bucket}`)
    .digest("hex")
    .slice(0, 48);
  return `grynd_coins_${digest}`;
}

export type CoinCheckoutBuildInput = {
  /** The authenticated caller (server-side session, never a body field). */
  clerkId: string;
  /** The catalog package resolved by the server. */
  pkg: CoinCheckoutPackage;
  /** The price id resolved by `ensurePackageStripe` and verified by the caller. */
  priceId: string;
  /** The verified charge: exactly what Stripe will take. */
  charge: { currency: string; amountCents: number };
  /** The trusted app origin (see lib/stripe.getReturnBaseUrl). */
  baseUrl: string;
  now?: number;
};

export type CoinCheckoutBuild = {
  /** Parameters for `checkout.sessions.create` (branding is added by the helper). */
  params: Stripe.Checkout.SessionCreateParams;
  /** Stripe idempotency key — server-derived, per user/package/window. */
  idempotencyKey: string;
  /** The `stripe_checkout_sessions` row to persist BEFORE redirecting. */
  ledger: {
    clerkId: string;
    packageKey: string;
    sessionMode: "payment";
    tokenAmount: number;
    amountCents: number;
    currency: string;
    paymentStatus: "open";
    fulfilled: false;
  };
};

/** Random 8-letter suffix for the Checkout integration identifier. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10).toLowerCase();
}

/**
 * Build the Checkout Session parameters for a coin purchase. PURE — no DB, no
 * Stripe call, no env — so the shape can be unit-tested exactly.
 *
 * What this guarantees:
 *   * the line item is a SERVER-resolved `price_…` id at quantity 1 (never a
 *     client-supplied price id, amount or currency),
 *   * the amount and currency recorded on the ledger are the verified charge,
 *     not anything read from the request,
 *   * the coin award recorded for reconciliation comes from the catalog,
 *   * both return URLs are built from the trusted app origin — no client
 *     redirect can be injected,
 *   * promotion codes are NOT enabled: a discount would let a pack be bought
 *     for less than the price the catalog and the ledger expect.
 *
 * It does NOT take an amount, a price id, a currency or a URL from the caller,
 * and it throws on a malformed price id or a non-absolute origin rather than
 * creating a session that could charge or redirect somewhere unexpected.
 */
export function buildCoinCheckoutSession(
  input: CoinCheckoutBuildInput,
): CoinCheckoutBuild {
  const { clerkId, pkg, priceId, charge, baseUrl } = input;
  const now = input.now ?? Date.now();

  if (!clerkId) throw new Error("clerkId is required");
  if (!priceId || !priceId.startsWith("price_")) {
    throw new Error("a server-resolved Stripe price id is required");
  }
  if (!/^https?:\/\//i.test(baseUrl || "")) {
    throw new Error("an absolute base URL is required");
  }
  if (
    !Number.isInteger(charge?.amountCents) ||
    charge.amountCents <= 0 ||
    !charge.currency
  ) {
    throw new Error("a verified charge is required");
  }

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    line_items: [{ price: priceId, quantity: 1 }],
    // Links the payment back to the caller even without metadata (Stripe shows
    // it on the payment); the webhook still resolves the user server-side.
    client_reference_id: clerkId,
    metadata: {
      clerkId,
      packageKey: pkg.key,
      // The award the webhook must credit — recorded here so a mismatch is
      // visible at reconciliation time.
      coins: String(pkg.totalCoins),
    },
    payment_intent_data: {
      metadata: { clerkId, packageKey: pkg.key },
    },
    success_url: `${baseUrl}/rewards?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/rewards?checkout=cancelled`,
    // Same Managed Payments setup as the package products were created for
    // (see lib/stripe/packages.ts) — the product carries the eligible tax code.
    managed_payments: { enabled: true },
    integration_identifier: `grynd_coins_${randomSuffix()}`,
  };

  return {
    params,
    idempotencyKey: coinCheckoutIdempotencyKey(clerkId, pkg.key, now),
    ledger: {
      clerkId,
      packageKey: pkg.key,
      sessionMode: "payment",
      tokenAmount: pkg.totalCoins,
      amountCents: charge.amountCents,
      currency: charge.currency,
      paymentStatus: "open",
      fulfilled: false,
    },
  };
}
