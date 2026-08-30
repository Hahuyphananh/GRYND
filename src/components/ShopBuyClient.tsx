"use client";

// src/components/ShopBuyClient.tsx
//
// Client-side buyer for Grynd token packages.
//
// Purchase flow:    Shop → select package → server creates Stripe Checkout →
//                   user pays on Stripe → verified webhook credits tokens (the
//                   ONLY place tokens are granted) → user returns to /shop →
//                   this component polls /api/stripe/session-status for our own
//                   session, then shows "+N tokens" and refreshes the balance.
//
// Security:
//   * the client only ever submits a packageKey to /api/stripe/checkout; the
//     server resolves the price and token award (client amounts are ignored),
//   * success is confirmed from the server, not from the URL alone,
//   * refreshes / repeated polls cannot double-credit (webhook idempotency) —
//     this component only reports what the server says was already credited,
//     and it strips the ?checkout/session_id params once handled.

import { useCallback, useEffect, useRef, useState } from "react";

export type ShopPackage = {
  key: string;
  name: string;
  baseTokens: number;
  bonusTokens: number;
  awardedTokens: number;
  priceUsd: string;
  badge: string | null;
  featured: boolean;
  tokensPerDollar: number;
};

const POLL_ATTEMPTS = 12;
const POLL_INTERVAL_MS = 1500;

async function fetchBalance(): Promise<number | null> {
  try {
    const res = await fetch("/api/get-user-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    });
    const data = await res.json().catch(() => ({}));
    const balance = data?.data?.balance;
    return typeof balance === "number" ? balance : null;
  } catch {
    return null;
  }
}

export default function ShopBuyClient({ packages }: { packages: ShopPackage[] }) {
  const [balance, setBalance] = useState<number | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{
    tokens: number;
    note?: string | null;
  } | null>(null);

  const polledSessionRef = useRef(false);

  const refreshBalance = useCallback(async () => {
    setBalance(await fetchBalance());
  }, []);

  // Load balance on mount.
  useEffect(() => {
    refreshBalance();
  }, [refreshBalance]);

  // Handle a return from Stripe Checkout. Reads our own URL params, confirms the
  // session was fulfilled server-side, shows the amount, and refreshes balance.
  useEffect(() => {
    if (polledSessionRef.current) return;

    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") !== "success") return;

    const sessionId = params.get("session_id");
    if (!sessionId) {
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }

    polledSessionRef.current = true;

    let attempts = 0;
    let cancelled = false;

    const check = async () => {
      attempts += 1;
      try {
        const res = await fetch(
          `/api/stripe/session-status?session_id=${encodeURIComponent(sessionId)}`,
          { credentials: "include" }
        );
        const data = await res.json().catch(() => ({}));
        if (data?.success && data.fulfilled) {
          if (!cancelled) {
            setSuccess({ tokens: Number(data.tokenAmount ?? 0), note: data.note });
            await refreshBalance();
            // Strip the params so a manual refresh doesn't re-trigger this.
            if (window.location.search) {
              window.history.replaceState({}, "", window.location.pathname);
            }
          }
          return;
        }
      } catch {
        /* retry below */
      }
      if (!cancelled && attempts < POLL_ATTEMPTS) {
        setTimeout(check, POLL_INTERVAL_MS);
      } else if (!cancelled) {
        // Webhook hasn't confirmed yet — surface a neutral "processing" state
        // rather than claiming success. Balance safe from duplicate credit.
        window.history.replaceState({}, "", window.location.pathname);
      }
    };

    const timer = setTimeout(check, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refreshBalance]);

  async function buy(key: string) {
    setError(null);
    setSuccess(null);
    setBuying(key);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageKey: key }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.url) {
        setError(data?.error || "Could not start checkout. Please try again.");
        setBuying(null);
        return;
      }
      // Redirect to Stripe-hosted Checkout. Tokens are granted only by the
      // webhook after payment, never by this redirect.
      window.location.href = data.url;
    } catch {
      setError("Could not start checkout. Please try again.");
      setBuying(null);
    }
  }

  return (
    <section className="mt-8">
      <div className="mb-6 text-center">
        <h2 className="text-2xl font-bold text-[#00e5ff]">Buy Grynd Tokens</h2>
        <p className="mt-1 text-sm text-[#9dd8ff]/70">
          {balance !== null ? `Your balance: ${balance.toLocaleString()} tokens` : ""}
          <span className="text-[#9dd8ff]/40">
            {" "}
            · Virtual tokens — no cash value, non-refundable.
          </span>
        </p>
      </div>

      {success && (
        <div className="mx-auto mb-6 max-w-lg rounded-xl border border-green-400/50 bg-green-950/40 p-4 text-center shadow-[0_0_24px_rgba(34,197,94,0.2)]">
          <p className="text-lg font-bold text-green-400">
            Purchase confirmed — +{success.tokens.toLocaleString()} tokens added!
          </p>
          {success.note && <p className="mt-1 text-sm text-green-300/80">{success.note}</p>}
        </div>
      )}

      {error && <p className="mb-4 text-center text-sm text-red-400">{error}</p>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {packages.map((pkg) => {
          const isFeatured = Boolean(pkg.featured);
          const buyLabel =
            pkg.bonusTokens > 0
              ? `${pkg.awardedTokens.toLocaleString()} (+${pkg.bonusTokens.toLocaleString()} bonus)`
              : `${pkg.awardedTokens.toLocaleString()}`;
          return (
            <div
              key={pkg.key}
              className={`relative flex flex-col rounded-2xl border bg-[#040d24]/70 p-5 text-center transition-all ${
                isFeatured
                  ? "border-[#f5ff3b]/70 shadow-[0_0_30px_rgba(245,255,59,0.18)] ring-2 ring-[#f5ff3b]/40 scale-[1.02]"
                  : "border-[#00e5ff]/20 shadow-[0_0_20px_rgba(0,229,255,0.08)]"
              }`}
            >
              {isFeatured && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-[#f5ff3b] px-3 py-0.5 text-xs font-bold text-[#040d24]">
                  Best Value
                </span>
              )}
              <div className="text-sm font-semibold uppercase tracking-wider text-[#c9f7ff]">
                {pkg.name}
              </div>

              <div className="mt-2 flex-1">
                <div className="text-3xl font-black text-[#00e5ff]">
                  {pkg.awardedTokens.toLocaleString()}
                </div>
                <div className="text-xs text-[#9dd8ff]/70">
                  {pkg.bonusTokens > 0
                    ? `${pkg.baseTokens.toLocaleString()} + ${pkg.bonusTokens.toLocaleString()} bonus`
                    : "tokens"}
                </div>
              </div>

              {pkg.tokensPerDollar > 0 && (
                <div
                  className={`mt-2 inline-flex self-center rounded-full px-2 py-0.5 text-xs ${
                    isFeatured
                      ? "bg-[#f5ff3b]/15 text-[#f5ff3b]"
                      : "bg-[#00e5ff]/10 text-[#00e5ff]/80"
                  }`}
                >
                  ≈ {pkg.tokensPerDollar.toLocaleString()} tokens / $1
                </div>
              )}

              <div className="mt-3 text-lg font-bold text-white">${pkg.priceUsd}</div>

              <button
                type="button"
                onClick={() => buy(pkg.key)}
                disabled={buying !== null}
                className={`mt-4 w-full rounded-xl px-4 py-2 font-semibold transition-colors ${
                  isFeatured
                    ? "bg-[#f5ff3b] text-[#040d24] hover:bg-[#faff80]"
                    : buying === pkg.key
                      ? "cursor-wait bg-[#0a3750] text-[#9dd8ff]"
                      : "bg-[#00e5ff] text-[#040d24] hover:bg-[#33ebff]"
                } disabled:opacity-60`}
              >
                {buying === pkg.key ? "Opening checkout…" : `${buyLabel} — Buy`}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
