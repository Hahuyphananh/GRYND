"use client";

// src/components/UpgradeProContent.tsx
//
// The GRYND PRO pitch — ONE presentational component shared by the reusable
// modal (UpgradeProModal) and the /upgrade-pro landing page, so the offer, the
// perk list, the THREE billing options and the CTA are written once.
//
// IT DERIVES NO PRICE OF ITS OWN. `plan.billingOptions` is resolved server-side
// from the plan catalog / the bound Stripe prices and passed down, so the
// numbers shown here are always what Stripe will charge. Savings come from the
// same objects (computed in src/lib/proBilling.ts), never from copy typed here.
//
// The caller picks the billing option; this component only renders the choice
// and hands the selected interval back through `onUpgrade` / `onChangeInterval`.

import { useEffect, useState } from "react";
import Image from "next/image";
import { useTranslation } from "../hooks/useTranslation";
import {
  PRO_BILLING_INTERVALS,
  type ProBillingInterval,
  type ProBillingOption,
} from "../lib/proBilling";
import { formatMoney } from "../lib/currency";
import { ADVERTISED_PRO_BENEFITS } from "../lib/proBenefits";
import type { ProPlanDisplay } from "../lib/membershipDisplay";

export type UpgradeProContentProps = {
  plan: ProPlanDisplay;
  /** Server-authoritative: the caller already holds GRYND PRO. */
  active: boolean;
  /** Server-authoritative: the caller is signed in. */
  signedIn: boolean;
  /** ISO date of the current period end, for subscribers. */
  currentPeriodEnd?: string | null;
  /** Which billing option an existing member is on, when known. */
  currentInterval?: ProBillingInterval | null;
  busy?: boolean;
  error?: string | null;
  /** `modal` is the compact dialog; `page` is the full landing hero. */
  variant?: "modal" | "page";
  imagePriority?: boolean;
  onUpgrade: (interval: ProBillingInterval) => void;
  /** An existing member switching interval (only offered when active). */
  onChangeInterval?: (interval: ProBillingInterval) => void;
  onManage: () => void;
  onSignIn: () => void;
  onDismiss?: () => void;
};

/**
 * The benefits this page advertises — the approved catalog's ADVERTISED set
 * (lib/proBenefits.ts), never `plan.perks`.
 *
 * Both halves of that matter. A fixed list (rather than whatever a catalog edit
 * put in the row) means nothing unapproved can be advertised; and taking only
 * the `available` benefits means an approved-but-unbuilt feature is never shown
 * as included. When a benefit ships, its entry flips to `available` in the
 * catalog and it appears here with no change to this component — its copy is
 * already translated under `pro.benefit.<id>` in every locale.
 */
const BENEFIT_IDS = ADVERTISED_PRO_BENEFITS.map((benefit) => benefit.id);

/** The default option a visitor sees selected (the recommended one). */
const DEFAULT_INTERVAL: ProBillingInterval = "yearly";

function optionFor(
  plan: ProPlanDisplay,
  interval: ProBillingInterval,
): ProBillingOption | undefined {
  return plan.billingOptions.find((option) => option.interval === interval);
}

function BillingCard({
  option,
  selected,
  onSelect,
  t,
}: {
  option: ProBillingOption;
  selected: boolean;
  onSelect: () => void;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  const interval = option.interval;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-testid={`pro-interval-${interval}`}
      data-selected={selected ? "true" : "false"}
      onClick={onSelect}
      className={`relative flex h-full flex-col rounded-xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] ${
        selected
          ? "border-[#f5ff3b] bg-[#f5ff3b]/10 shadow-[0_0_22px_rgba(245,255,59,0.25)]"
          : "border-[#00e5ff]/25 bg-[#04122e]/70 hover:border-[#00e5ff]/50"
      }`}
    >
      {option.badge && (
        <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-[#f5ff3b]/60 bg-[#0b224f] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#f5ff3b]">
          {t("pro.badge.best_value")}
        </span>
      )}

      <span className="text-xs font-semibold uppercase tracking-wider text-[#9dd8ff]">
        {t(`pro.interval.${interval}`)}
      </span>

      {/* The amount Stripe charges, in the currency resolved for this visitor
          (see lib/currency.ts). Both halves come from the same server-resolved
          option, so the symbol can never disagree with the digits. */}
      <span className="mt-1 text-xl font-black text-white">
        {option.priceDisplay}
        <span className="ml-0.5 text-xs font-medium text-[#9dd8ff]/80">
          /{t(`pro.unit.${interval}`)}
        </span>
      </span>

      {option.monthlyEquivalentCents !== null && (
        <span className="mt-0.5 text-[11px] text-[#9dd8ff]/75">
          {t("pro.equivalent", {
            amount: formatMoney(option.monthlyEquivalentCents, option.currency),
          })}
        </span>
      )}

      <span className="mt-2 space-y-0.5">
        {option.savings.map((saving) => (
          <span
            key={saving.versus}
            className="block text-[11px] font-medium leading-snug text-[#00ffa6]"
          >
            {t("pro.save", {
              amount: formatMoney(saving.amountCents, option.currency),
              percent: saving.percent,
              versus: t(`pro.interval.${saving.versus}`).toLowerCase(),
            })}
          </span>
        ))}
        {option.savings.length === 0 && (
          <span className="block text-[11px] leading-snug text-[#9dd8ff]/70">
            {t("pro.flexible_weekly")}
          </span>
        )}
      </span>

      {selected && (
        <span className="mt-2 text-[11px] font-bold text-[#f5ff3b]">
          {t("pro.selected")}
        </span>
      )}
    </button>
  );
}

export default function UpgradeProContent({
  plan,
  active,
  signedIn,
  currentPeriodEnd = null,
  currentInterval = null,
  busy = false,
  error = null,
  variant = "modal",
  imagePriority = false,
  onUpgrade,
  onChangeInterval,
  onManage,
  onSignIn,
  onDismiss,
}: UpgradeProContentProps) {
  const { t } = useTranslation();
  const isPage = variant === "page";

  // A member starts on the option they actually hold; a visitor starts on the
  // recommended (yearly) one. The selection is client-side only — it chooses
  // WHICH approved interval to request, never a price.
  const [selected, setSelected] = useState<ProBillingInterval>(
    active && currentInterval ? currentInterval : DEFAULT_INTERVAL,
  );

  useEffect(() => {
    if (active && currentInterval) setSelected(currentInterval);
  }, [active, currentInterval]);

  const selectedOption = optionFor(plan, selected) ?? plan.billingOptions[0];
  if (!selectedOption) return null;

  const renewsOn =
    active && currentPeriodEnd ? new Date(currentPeriodEnd).toLocaleDateString() : null;

  const switchingInterval = active && selected !== (currentInterval ?? null);

  const ctaLabel = busy
    ? t("pro.cta.opening")
    : active
      ? switchingInterval
        ? t("pro.cta.switch", { interval: t(`pro.interval.${selected}`) })
        : t("pro.cta.manage")
      : t("pro.cta.subscribe", {
          price: selectedOption.priceDisplay,
          unit: t(`pro.unit.${selected}`),
        });

  const handlePrimary = () => {
    if (active) {
      if (switchingInterval && onChangeInterval) onChangeInterval(selected);
      else onManage();
      return;
    }
    if (!signedIn) {
      onSignIn();
      return;
    }
    onUpgrade(selected);
  };

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
          aria-label={t("pro.close")}
          className="absolute right-3 top-3 z-10 rounded-lg border border-[#00e5ff]/30 bg-[#0b224f]/80 px-2 py-1 text-sm text-[#9dd8ff] transition hover:text-[#00e5ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
        >
          ✕
        </button>
      )}

      <div
        className={`flex flex-col items-center gap-5 ${
          isPage ? "sm:flex-row sm:items-start sm:gap-8" : ""
        }`}
      >
        <Image
          src="/images/pack-mega.png"
          alt="GRYND PRO membership"
          width={1024}
          height={1024}
          priority={imagePriority}
          sizes="(max-width: 640px) 180px, 240px"
          className={`h-auto shrink-0 object-contain drop-shadow-[0_0_30px_rgba(245,255,59,0.35)] ${
            isPage ? "w-[160px] sm:w-[240px]" : "w-[140px]"
          }`}
        />

        <div className={`w-full ${isPage ? "text-left" : "text-center"}`}>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#00e5ff]">
            {t("pro.membership")}
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
            {t("pro.lead")}
          </p>

          {/* ── Three billing options ─────────────────────────────────── */}
          <div
            role="radiogroup"
            aria-label={t("pro.interval_group")}
            className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3"
          >
            {PRO_BILLING_INTERVALS.map((interval) => {
              const option = optionFor(plan, interval);
              if (!option) return null;
              return (
                <BillingCard
                  key={interval}
                  option={option}
                  selected={selected === interval}
                  onSelect={() => setSelected(interval)}
                  t={t}
                />
              );
            })}
          </div>

          <p className="mt-3 text-[11px] leading-snug text-[#9dd8ff]/70">
            {t("pro.same_membership")}
          </p>

          {/* ── Status ────────────────────────────────────────────────── */}
          {active ? (
            <p className="mt-3 text-xs font-semibold text-green-400">
              {renewsOn
                ? t("pro.active_renews", { date: renewsOn })
                : t("pro.active_plain")}
            </p>
          ) : (
            <p className="mt-3 text-xs text-[#9dd8ff]/70">{t("pro.cancel_anytime")}</p>
          )}

          {error && (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {error}
            </p>
          )}

          <div className={`mt-4 flex flex-wrap gap-3 ${isPage ? "" : "justify-center"}`}>
            <button
              type="button"
              onClick={handlePrimary}
              disabled={busy}
              data-testid="pro-primary-cta"
              className="inline-flex items-center justify-center rounded-xl border border-[#f5ff3b]/60 bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-5 py-2.5 font-bold text-[#1f1700] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] disabled:opacity-60"
            >
              {ctaLabel}
            </button>
            {active && (
              <button
                type="button"
                onClick={onManage}
                disabled={busy}
                className="inline-flex items-center justify-center rounded-xl border border-[#00e5ff]/60 bg-[#00e5ff]/15 px-5 py-2.5 font-semibold text-[#00e5ff] transition hover:bg-[#00e5ff]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] disabled:opacity-60"
              >
                {t("pro.cta.manage")}
              </button>
            )}
          </div>

          {/* ── Benefits ──────────────────────────────────────────────── */}
          <h3 className={`mt-6 text-sm font-bold uppercase tracking-wider text-[#00e5ff] ${isPage ? "" : "text-center"}`}>
            {t("pro.benefits_title")}
          </h3>
          <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {BENEFIT_IDS.map((id) => (
              <li key={id} className="flex items-start gap-2 text-sm text-[#d8fbff]">
                <span aria-hidden className="mt-0.5 text-[#00ffa6]">
                  ✓
                </span>
                <span>{t(`pro.benefit.${id}`)}</span>
              </li>
            ))}
          </ul>

          {!active && (
            <p className="mt-4 text-xs text-[#9dd8ff]/60">{t("pro.no_advantage")}</p>
          )}
        </div>
      </div>
    </section>
  );
}
