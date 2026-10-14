"use client";

// src/app/upgrade-pro/PageClient.tsx
//
// The GRYND PRO page — ONE membership, THREE billing options.
//
// It does not fetch the plan or the entitlement itself: the server page
// resolved both (including the three authoritative price amounts) and passed
// them in, so the price in the first HTML is the price Stripe will charge and
// there is no "am I PRO?" flash. The only client work is the Stripe actions
// plus one confirmation poll when the visitor returns from Checkout.
//
// A free visitor chooses an interval and subscribes. An existing member sees
// their current interval, can switch to another (prorated, on the SAME
// subscription) and can open the billing portal — they are never asked to
// subscribe again, so no second subscription can be created.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import UpgradeProContent from "../../components/UpgradeProContent";
import {
  changeProBillingInterval,
  openProBillingPortal,
  startProCheckout,
  useMembershipStatus,
} from "../../lib/upgradePro";
import { useTranslation } from "../../hooks/useTranslation";
import type { ProBillingInterval } from "../../lib/proBilling";
import type { ProPlanDisplay } from "../../lib/membershipDisplay";

type Subscription = {
  planKey: string;
  status: string;
  currentPeriodEnd: string | null;
};

type PageClientProps = {
  plan: ProPlanDisplay;
  signedIn: boolean;
  subscription: Subscription | null;
};

/** What every player keeps for free — GRYND PRO adds convenience only. */
const FREE_FEATURES = [
  "All games",
  "Ranked play",
  "Game-specific Elo",
  "Leaderboards",
  "Free tournaments",
  "Profiles",
  "Normal match history",
  "Progression systems",
  "Cosmetic rewards",
];

const CONFIRM_ATTEMPTS = 10;
const CONFIRM_INTERVAL_MS = 1500;

export default function PageClient({ plan, signedIn, subscription }: PageClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useTranslation();
  const status = useMembershipStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const checkoutState = searchParams.get("checkout");
  const sessionId = searchParams.get("session_id");

  const active = status.loaded ? status.active : Boolean(subscription);
  const currentPeriodEnd = status.loaded
    ? status.currentPeriodEnd
    : (subscription?.currentPeriodEnd ?? null);
  const isSignedIn = status.loaded ? status.signedIn : signedIn;
  const resolvedPlan = status.plan ?? plan;
  const currentInterval = status.billingInterval;

  // Returning from Stripe Checkout: the webhook records the subscription
  // asynchronously, so poll the existing session-status endpoint until it
  // reports the membership, then drop the query params.
  const refresh = status.refresh;
  useEffect(() => {
    if (checkoutState !== "success") return;
    setConfirming(true);
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const tick = async () => {
      attempts += 1;
      try {
        if (sessionId) {
          const res = await fetch(
            `/api/stripe/session-status?session_id=${encodeURIComponent(sessionId)}`,
            { cache: "no-store" },
          );
          const data = await res.json().catch(() => ({}));
          if (data?.fulfilled) {
            if (cancelled) return;
            setConfirming(false);
            await refresh();
            router.replace("/upgrade-pro");
            return;
          }
        }
      } catch {
        // keep polling
      }
      if (cancelled) return;
      if (attempts >= CONFIRM_ATTEMPTS) {
        setConfirming(false);
        await refresh();
        router.replace("/upgrade-pro");
        return;
      }
      timer = setTimeout(tick, CONFIRM_INTERVAL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [checkoutState, sessionId, refresh, router]);

  const runAction = useCallback(async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    setBusy(true);
    const result = await action();
    if (!result.ok) {
      setBusy(false);
      setError(result.error ?? t("pro.error_generic"));
      void status.refresh();
    }
  }, [status, t]);

  const handleUpgrade = useCallback(
    (interval: ProBillingInterval) => {
      if (!isSignedIn) {
        router.push("/sign-up?redirect_url=%2Fupgrade-pro");
        return;
      }
      return runAction(() => startProCheckout(resolvedPlan.key, interval));
    },
    [isSignedIn, resolvedPlan.key, router, runAction],
  );

  const handleChangeInterval = useCallback(
    (interval: ProBillingInterval) => runAction(() => changeProBillingInterval(interval)),
    [runAction],
  );

  const handleManage = useCallback(
    () => runAction(() => openProBillingPortal()),
    [runAction],
  );

  const currentOption = resolvedPlan.billingOptions.find(
    (option) => option.interval === currentInterval,
  );

  return (
    <div className="relative min-h-screen">
      <InteractiveCasinoBg variant="subtle" />
      <NavigationBar currentPath="/upgrade-pro" />

      <main className="relative z-10 mx-auto max-w-5xl px-4 pb-20 pt-24 sm:pt-28">
        <header className="mb-8 text-center">
          <h1 className="text-3xl font-black tracking-tight text-[#f5ff3b] drop-shadow-[0_0_10px_rgba(245,255,59,0.5)] sm:text-5xl">
            {t("pro.headline")}
          </h1>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-[#9dd8ff]/85 sm:text-base">
            {t("pro.subtitle")}
          </p>
        </header>

        {checkoutState === "cancelled" && (
          <p
            role="status"
            className="mx-auto mb-5 max-w-xl rounded-lg border border-[#00e5ff]/30 bg-[#0b224f]/80 px-4 py-2 text-center text-sm text-[#9dd8ff]"
          >
            {t("pro.checkout_cancelled")}
          </p>
        )}

        {checkoutState === "success" && (
          <p
            role="status"
            className="mx-auto mb-5 max-w-xl rounded-lg border border-green-400/40 bg-green-500/10 px-4 py-2 text-center text-sm text-green-300"
          >
            {confirming || !active ? t("pro.checkout_activating") : t("pro.checkout_active")}
          </p>
        )}

        <UpgradeProContent
          plan={resolvedPlan}
          active={active}
          signedIn={isSignedIn}
          currentPeriodEnd={currentPeriodEnd}
          currentInterval={currentInterval}
          busy={busy}
          error={error}
          variant="page"
          imagePriority
          onUpgrade={handleUpgrade}
          onChangeInterval={handleChangeInterval}
          onManage={handleManage}
          onSignIn={() => handleUpgrade("yearly")}
        />

        {/* ── What free players keep ─────────────────────────────────── */}
        <section className="mt-8 rounded-2xl border border-[#00e5ff]/25 bg-[#0b224f]/70 p-6">
          <h2 className="text-xl font-bold text-[#00e5ff]">{t("pro.free_title")}</h2>
          <p className="mt-1 text-sm text-[#9dd8ff]/80">{t("pro.free_body")}</p>
          <ul className="mt-4 grid grid-cols-2 gap-2 text-sm text-[#d8fbff] sm:grid-cols-3">
            {FREE_FEATURES.map((feature) => (
              <li key={feature} className="flex items-start gap-2">
                <span aria-hidden className="mt-0.5 text-[#00ffa6]">
                  ✓
                </span>
                <span>{feature}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-[#9dd8ff]/70">{t("pro.free_note")}</p>
        </section>

        {/* ── Billing ────────────────────────────────────────────────── */}
        <section className="mt-6 rounded-2xl border border-[#00e5ff]/25 bg-[#0b224f]/70 p-6">
          <h2 className="text-xl font-bold text-[#00e5ff]">{t("pro.billing_title")}</h2>
          <ul className="mt-3 space-y-2 text-sm text-[#9dd8ff]/85">
            {active && currentOption ? (
              <li>
                •{" "}
                {t("pro.billing_current", {
                  interval: t(`pro.interval.${currentOption.interval}`).toLowerCase(),
                  price: currentOption.priceDisplay,
                  unit: t(`pro.unit.${currentOption.interval}`),
                })}
              </li>
            ) : (
              <li>• {t("pro.billing_options")}</li>
            )}
            <li>• {t("pro.billing_change")}</li>
            <li>
              • {t("pro.billing_profile_lead")}{" "}
              <Link href="/profil" className="text-[#f5ff3b] underline">
                {t("pro.billing_profile_link")}
              </Link>
            </li>
          </ul>
        </section>
      </main>

      <Footer />
    </div>
  );
}
