"use client";

// src/components/CoinShopOffers.tsx
//
// The optional coin-purchase section on /rewards.
//
// ── What this component may decide ─────────────────────────────────────────
//
// Nothing about money or coins. The tier label, coin amount, bonus, price,
// currency and even whether purchases are open all arrive from
// `GET /api/coins/packages`, which resolves them from the `token_packages`
// catalog. The client sends exactly one thing back: the package KEY.
//
// ── The four states ────────────────────────────────────────────────────────
//
//   1. DISABLED (the default everywhere) — the server returns `enabled: false`
//      and this component renders nothing at all. Buttons are not hidden with
//      CSS: the server refuses to create a session, and the button markup does
//      not exist.
//   2. SHOP OPEN, NOT SIGNED IN — the cards render but the action is a sign-in
//      link, never a checkout call. The API requires Clerk auth anyway.
//   3. READY — one button per pack. It POSTs `{ packageKey }` to
//      `/api/coins/checkout`, shows a loading state, and navigates ONLY to the
//      Stripe URL the server returned (validated as an https Stripe host). Any
//      error is shown inline; there is no client-calculated price or amount.
//   4. RETURNING FROM STRIPE — the page shows a pending state and polls
//      `/api/stripe/session-status` until the server reports `fulfilled`.
//      Success is displayed only from that server answer, and the balance is
//      refreshed through the shared `notifyCoinBalanceChanged()` event (which
//      re-reads `/api/get-user-tokens`). This component never adds coins in the
//      browser.
//
// Coins are virtual, have no cash value, are used only inside GRYND and cannot
// be withdrawn or redeemed — the copy says so and never claims otherwise.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import {
  IconAlertTriangle,
  IconCheck,
  IconCoin,
  IconCoins,
  IconRefresh,
} from "@tabler/icons-react";
import { notifyCoinBalanceChanged } from "../hooks/useCoinBalance";
import { useTranslation } from "../hooks/useTranslation";
import {
  COIN_CHECKOUT_POLL_INTERVAL_MS,
  isTrustedStripeUrl,
  parseCheckoutReturn,
  shouldPollCheckout,
} from "../lib/coinCheckoutClient";

const CARD =
  "rounded-xl border border-[#00e5ff]/20 bg-[#040d24]/70 p-5 backdrop-blur-sm sm:p-6";
const OFFER =
  "flex h-full flex-col rounded-lg border border-[#00e5ff]/15 bg-[#030817]/60 p-4";
const CTA =
  "mt-3 inline-flex items-center justify-center rounded-xl border border-[#f5ff3b]/60 bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-4 py-2.5 text-sm font-bold text-[#1f1700] shadow-[0_0_20px_rgba(245,255,59,0.25)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817] disabled:cursor-not-allowed disabled:opacity-60";

/** One offer exactly as the server resolved it. */
type CoinOffer = {
  key: string;
  tier: string;
  name: string;
  coins: number;
  bonusCoins: number;
  totalCoins: number;
  priceCents: number;
  currency: string;
  priceDisplay: string;
  badge: string | null;
  featured: boolean;
};

type CatalogPayload = {
  enabled: boolean;
  checkoutReady: boolean;
  currency: string;
  offers: CoinOffer[];
};

type ConfirmState = "idle" | "polling" | "confirmed" | "pending" | "unavailable";

function formatCoins(value: number) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export default function CoinShopOffers() {
  const { t } = useTranslation();
  const { isLoaded, isSignedIn } = useUser();

  const [catalog, setCatalog] = useState<CatalogPayload | null>(null);
  const [startingKey, setStartingKey] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState(false);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pollKey, setPollKey] = useState(0);
  const [confirmState, setConfirmState] = useState<ConfirmState>("idle");
  const [confirmedCoins, setConfirmedCoins] = useState(0);

  // Read-only catalog. A failure renders as "nothing", the same as the flag
  // being off, because this surface must never invent a price.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/coins/packages", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: CatalogPayload | null) => {
        if (cancelled || !data) return;
        setCatalog({
          enabled: Boolean(data.enabled),
          checkoutReady: Boolean(data.checkoutReady),
          currency: String(data.currency ?? ""),
          offers: Array.isArray(data.offers) ? data.offers : [],
        });
      })
      .catch(() => {
        // Silent: a failed catalog read must not disturb the rest of the page.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Did we come back from Stripe? Only a `cs_…` session id is polled, and the
  // server answers only for the caller's own sessions.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const parsed = parseCheckoutReturn(window.location.search);
    if (!parsed.returned) return;
    if (parsed.sessionId) {
      setSessionId(parsed.sessionId);
      return;
    }
    // Returned as "success" without a usable session id: we cannot confirm it,
    // so we say exactly that instead of claiming success.
    if (!parsed.cancelled) setConfirmState("unavailable");
  }, []);

  // Poll the server-owned status. Success is displayed ONLY when the server
  // reports `fulfilled` — the webhook is the only thing that credits coins.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    setConfirmState("polling");

    const tick = async () => {
      attempts += 1;
      let fulfilled = false;

      try {
        const res = await fetch(
          `/api/stripe/session-status?session_id=${encodeURIComponent(sessionId)}`,
          { cache: "no-store", credentials: "include" },
        );
        const data = res.ok ? await res.json() : null;
        if (cancelled) return;
        if (data?.success && data?.fulfilled) {
          fulfilled = true;
          setConfirmedCoins(Number(data.tokenAmount) || 0);
          setConfirmState("confirmed");
          // Server truth only: re-read the balance, never add to it locally.
          notifyCoinBalanceChanged();
        }
      } catch {
        // A transient network error is retried by the same loop.
      }

      if (cancelled || fulfilled) return;

      if (!shouldPollCheckout(attempts, false)) {
        // Paid but not confirmed yet: stay honest and offer a manual re-check.
        setConfirmState("pending");
        return;
      }
      timer = setTimeout(tick, COIN_CHECKOUT_POLL_INTERVAL_MS);
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, pollKey]);

  const startCheckout = async (packageKey: string) => {
    setCheckoutError(false);
    setStartingKey(packageKey);

    try {
      const res = await fetch("/api/coins/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        // The ONLY thing the client picks. Price, currency and coin award are
        // resolved server-side.
        body: JSON.stringify({ packageKey }),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.success || !isTrustedStripeUrl(data.url)) {
        setCheckoutError(true);
        setStartingKey(null);
        return;
      }

      // Only the server-issued Stripe Checkout URL, and only a real https
      // Stripe host.
      window.location.assign(data.url);
    } catch {
      setCheckoutError(true);
      setStartingKey(null);
    }
  };

  const confirmation =
    confirmState === "confirmed" ? (
      <p
        role="status"
        data-testid="coin-purchase-confirmed"
        className="mb-4 flex items-start gap-2 rounded-lg border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 px-3 py-2 text-sm font-semibold text-[#f5ff3b]"
      >
        <IconCheck size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span>{t("coins.confirmed", { amount: formatCoins(confirmedCoins) })}</span>
      </p>
    ) : confirmState === "polling" ? (
      <p
        role="status"
        data-testid="coin-purchase-confirming"
        className="mb-4 flex items-center gap-2 rounded-lg border border-[#00e5ff]/30 bg-[#00e5ff]/10 px-3 py-2 text-sm font-semibold text-[#00e5ff]"
      >
        <IconRefresh size={16} aria-hidden="true" className="animate-spin" />
        <span>{t("coins.confirming")}</span>
      </p>
    ) : confirmState === "pending" ? (
      <div
        role="status"
        data-testid="coin-purchase-pending"
        className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-[#00e5ff]/30 bg-[#00e5ff]/10 px-3 py-2 text-sm text-[#c9f7ff]"
      >
        <IconAlertTriangle size={16} aria-hidden="true" className="text-[#00e5ff]" />
        <span>{t("coins.pending")}</span>
        <button
          type="button"
          onClick={() => setPollKey((key) => key + 1)}
          data-testid="coin-purchase-retry"
          className="inline-flex items-center gap-1 font-semibold text-[#00e5ff] underline underline-offset-2 hover:text-[#f5ff3b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
        >
          <IconRefresh size={13} aria-hidden="true" /> {t("coins.retry")}
        </button>
      </div>
    ) : confirmState === "unavailable" ? (
      <p
        role="alert"
        data-testid="coin-purchase-unavailable"
        className="mb-4 flex items-start gap-2 rounded-lg border border-[#ff4fd8]/40 bg-[#ff4fd8]/10 px-3 py-2 text-sm text-[#ff4fd8]"
      >
        <IconAlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span>{t("coins.confirm_unavailable")}</span>
      </p>
    ) : null;

  const showOffers = Boolean(catalog?.enabled && catalog.offers.length > 0);

  // Nothing to sell and nothing to confirm → no surface at all.
  if (!showOffers && confirmState === "idle") return null;

  return (
    <section
      aria-labelledby={showOffers ? "coin-packs-heading" : undefined}
      aria-label={showOffers ? undefined : t("coins.title")}
      className={CARD}
      data-testid="coin-shop"
      data-enabled={showOffers ? "true" : "false"}
      data-checkout-ready={catalog?.checkoutReady ? "true" : "false"}
    >
      {confirmation}

      {showOffers ? (
        <>
          <h2
            id="coin-packs-heading"
            className="mb-1 flex items-center gap-2 text-lg font-bold text-[#00e5ff]"
          >
            <IconCoins size={18} aria-hidden="true" />
            {t("coins.title")}
          </h2>
          <p className="mb-4 text-xs leading-relaxed text-[#9dd8ff]/80">
            {t("coins.lead")}
          </p>

          <ul className="grid gap-3 sm:grid-cols-3">
            {catalog.offers.map((offer) => {
              const busy = startingKey === offer.key;
              return (
                <li key={offer.key} className="h-full">
                  <article
                    className={`${OFFER} h-full`}
                    data-testid={`coin-offer-${offer.key}`}
                    data-tier={offer.tier}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <h3 className="text-sm font-bold text-[#c9f7ff]">{offer.tier}</h3>
                      {offer.badge ? (
                        <span className="shrink-0 rounded-full border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#f5ff3b]">
                          {offer.badge}
                        </span>
                      ) : null}
                    </div>

                    <p className="flex items-center gap-1.5 text-lg font-extrabold text-[#f5ff3b]">
                      <IconCoin size={16} aria-hidden="true" />
                      {t("coins.total", { amount: formatCoins(offer.totalCoins) })}
                    </p>
                    <p className="mb-1 text-[11px] font-semibold text-[#9dd8ff]">
                      {offer.bonusCoins > 0
                        ? t("coins.bonus", { amount: formatCoins(offer.bonusCoins) })
                        : null}
                    </p>

                    {/* Rendered exactly as the server resolved it: same cents,
                        same currency as the Stripe charge. */}
                    <p
                      className="mt-auto text-base font-bold text-[#c9f7ff]"
                      data-testid={`coin-offer-price-${offer.key}`}
                      data-currency={offer.currency}
                    >
                      {offer.priceDisplay}
                    </p>

                    {/* No action at all unless the server says checkout is open
                        — hiding is not the security boundary, the API is. */}
                    {catalog.checkoutReady && isLoaded ? (
                      isSignedIn ? (
                        <button
                          type="button"
                          onClick={() => startCheckout(offer.key)}
                          disabled={startingKey !== null}
                          aria-busy={busy}
                          data-testid={`coin-buy-${offer.key}`}
                          className={CTA}
                        >
                          {busy
                            ? t("coins.buying")
                            : t("coins.buy", { price: offer.priceDisplay })}
                        </button>
                      ) : (
                        <Link
                          href="/sign-in?redirect_url=/rewards"
                          data-testid={`coin-signin-${offer.key}`}
                          className={CTA}
                        >
                          {t("coins.signin")}
                        </Link>
                      )
                    ) : null}
                  </article>
                </li>
              );
            })}
          </ul>

          {catalog.checkoutReady ? null : (
            <p
              className="mt-4 flex items-center gap-1.5 text-xs font-semibold text-[#f5ff3b]"
              data-testid="coin-shop-soon"
            >
              <IconCoins size={14} aria-hidden="true" />
              {t("coins.soon")}
            </p>
          )}

          {checkoutError ? (
            <p
              role="alert"
              data-testid="coin-checkout-error"
              className="mt-3 flex items-start gap-2 text-sm text-[#ff4fd8]"
            >
              <IconAlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
              <span>{t("coins.checkout_error")}</span>
            </p>
          ) : null}
        </>
      ) : null}

      {/* Coin facts, stated plainly. No claim of legal or platform compliance. */}
      <p className="mt-4 text-[11px] leading-relaxed text-[#c9f7ff]/60">
        {t("coins.cash")}
      </p>
    </section>
  );
}
