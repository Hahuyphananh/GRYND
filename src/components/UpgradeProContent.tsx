"use client";

// src/components/UpgradeProContent.tsx
//
// The GRYND PRO pitch — one presentational component shared by the reusable
// modal (UpgradeProModal) and the /upgrade-pro landing page, so the offer, the
// perk list and the CTA are written once.
//
// IT RENDERS NO PRICE OF ITS OWN. `plan.priceUsd` is resolved server-side from
// the plan catalog (or the bound Stripe price) and passed down, so the number
// shown here is always the number Stripe will charge. Nothing in this file
// knows about tokens, the old Shop, or how checkout works.
//
// Two membership states, two buttons:
//   * active subscriber → "Manage Subscription" (opens the Stripe portal),
//   * free user        → "Upgrade to GRYND PRO" (starts Stripe Checkout).

import Image from "next/image";
import {
  PRO_PLAN_FALLBACK_PERKS,
  type ProPlanDisplay,
} from "../lib/membershipDisplay";

export type UpgradeProContentProps = {
  plan: ProPlanDisplay;
  /** Server-authoritative: the caller already holds GRYND PRO. */
  active: boolean;
  /** Server-authoritative: the caller is signed in. */
  signedIn: boolean;
  /** ISO date of the current period end, for subscribers. */
  currentPeriodEnd?: string | null;
  busy?: boolean;
  error?: string | null;
  /** `modal` is the compact dialog; `page` is the full landing hero. */
  variant?: "modal" | "page";
  imagePriority?: boolean;
  onUpgrade: () => void;
  onManage: () => void;
  onSignIn: () => void;
  onDismiss?: () => void;
};

/**
 * Headline perks in the canonical order. The catalog is the source of the
 * lines; this only fixes their order and splits the secondary ones out.
 */
function splitPerks(plan: ProPlanDisplay): {
  headline: string[];
  secondary: string[];
} {
  const canonical: readonly string[] = PRO_PLAN_FALLBACK_PERKS;
  const available: string[] =
    plan.perks.length > 0 ? plan.perks : [...canonical];
  const headline = canonical.filter((p) => available.includes(p));
  if (headline.length === 0) {
    return { headline: available.slice(0, 4), secondary: available.slice(4) };
  }
  return {
    headline,
    secondary: available.filter((p) => !headline.includes(p)),
  };
}

export default function UpgradeProContent({
  plan,
  active,
  signedIn,
  currentPeriodEnd = null,
  busy = false,
  error = null,
  variant = "modal",
  imagePriority = false,
  onUpgrade,
  onManage,
  onSignIn,
  onDismiss,
}: UpgradeProContentProps) {
  const isPage = variant === "page";
  const { headline, secondary } = splitPerks(plan);

  const renewsOn =
    active && currentPeriodEnd
      ? new Date(currentPeriodEnd).toLocaleDateString()
      : null;

  const ctaLabel = busy
    ? "Opening Stripe…"
    : active
      ? "Manage Subscription"
      : "Upgrade to GRYND PRO";

  return (
    <section
      className={`relative overflow-hidden rounded-2xl border border-[#f5ff3b]/40 bg-[#040d24]/95 shadow-[0_0_40px_rgba(245,255,59,0.18)] ${
        isPage ? "p-6 sm:p-8" : "p-5 sm:p-6"
      }`}
      aria-labelledby="grynd-pro-heading"
    >
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 rounded-lg border border-[#00e5ff]/30 bg-[#0b224f]/80 px-2 py-1 text-sm text-[#9dd8ff] transition hover:text-[#00e5ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
        >
          ✕
        </button>
      )}

      <div
        className={`flex flex-col items-center gap-5 ${
          isPage ? "sm:flex-row sm:items-center sm:gap-8" : ""
        }`}
      >
        {/* Front image for GRYND PRO. */}
        <Image
          src="/images/pack-mega.png"
          alt="GRYND PRO membership"
          width={1024}
          height={1024}
          priority={imagePriority}
          sizes="(max-width: 640px) 220px, 260px"
          className={`h-auto w-[180px] shrink-0 object-contain drop-shadow-[0_0_30px_rgba(245,255,59,0.35)] sm:w-[220px] ${
            isPage ? "sm:w-[260px]" : ""
          }`}
        />

        <div className={`w-full ${isPage ? "text-left" : "text-center"}`}>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#00e5ff]">
            Membership
          </p>
          <h2
            id="grynd-pro-heading"
            className={`mt-1 font-black tracking-tight text-[#f5ff3b] ${
              isPage ? "text-3xl sm:text-4xl" : "text-2xl"
            }`}
          >
            {plan.name}
          </h2>
          <p className="mt-2 text-sm text-[#c9f7ff] sm:text-base">
            Compete without distractions.
          </p>

          <ul className={`mt-4 space-y-2 ${isPage ? "" : "text-left sm:mx-auto sm:max-w-xs"}`}>
            {headline.map((perk) => (
              <li key={perk} className="flex items-start gap-2 text-sm text-[#d8fbff]">
                <span aria-hidden className="mt-0.5 text-[#00ffa6]">
                  ✓
                </span>
                <span>{perk}</span>
              </li>
            ))}
          </ul>

          {secondary.length > 0 && (
            <p className="mt-3 text-xs text-[#9dd8ff]/70">
              Also includes: {secondary.join(" · ")}
            </p>
          )}

          <p className="mt-4 text-lg font-bold text-white">
            ${plan.priceUsd}
            <span className="text-sm font-medium text-[#9dd8ff]/80">/month</span>
          </p>

          {active ? (
            <p className="mt-1 text-xs font-semibold text-green-400">
              Active{renewsOn ? ` · renews ${renewsOn}` : ""}
            </p>
          ) : (
            <p className="mt-1 text-xs text-[#9dd8ff]/70">
              Cancel anytime. Billed monthly through Stripe.
            </p>
          )}

          {error && (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {error}
            </p>
          )}

          <div className={`mt-4 flex flex-wrap gap-3 ${isPage ? "" : "justify-center"}`}>
            {active ? (
              <button
                type="button"
                onClick={onManage}
                disabled={busy}
                className="inline-flex items-center justify-center rounded-xl border border-[#00e5ff]/60 bg-[#00e5ff]/15 px-5 py-2.5 font-semibold text-[#00e5ff] transition hover:bg-[#00e5ff]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] disabled:opacity-60"
              >
                {ctaLabel}
              </button>
            ) : signedIn ? (
              <button
                type="button"
                onClick={onUpgrade}
                disabled={busy}
                className="inline-flex items-center justify-center rounded-xl border border-[#f5ff3b]/60 bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-5 py-2.5 font-bold text-[#1f1700] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] disabled:opacity-60"
              >
                {ctaLabel}
              </button>
            ) : (
              <button
                type="button"
                onClick={onSignIn}
                className="inline-flex items-center justify-center rounded-xl border border-[#f5ff3b]/60 bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-5 py-2.5 font-bold text-[#1f1700] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b]"
              >
                {ctaLabel}
              </button>
            )}
          </div>

          {!active && (
            <p className="mt-3 text-xs text-[#9dd8ff]/60">
              Every game, ranked play, Elo, leaderboards, tournaments and the
              Battle Pass stay free — GRYND PRO never changes your odds or matchmaking.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
