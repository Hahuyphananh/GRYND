"use client";

// src/app/upgrade-pro/PageClient.tsx
//
// The GRYND PRO upgrade page (replaced the old token Shop).
//
// It does not fetch the plan or the entitlement itself: the server page
// resolved both and passed them in, so the price in the HTML is the price
// Stripe will charge and there is no "am I PRO?" flash. The only client work
// is the two Stripe actions plus one confirmation poll when the visitor
// returns from Checkout (the webhook may land a moment later).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import UpgradeProContent from "../../components/UpgradeProContent";
import {
  openProBillingPortal,
  startProCheckout,
  useMembershipStatus,
} from "../../lib/upgradePro";
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
  "Battle Pass",
  "Cosmetic rewards",
];

const CONFIRM_ATTEMPTS = 10;
const CONFIRM_INTERVAL_MS = 1500;

export default function PageClient({
  plan,
  signedIn,
  subscription,
}: PageClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
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
            { cache: "no-store" }
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
    // `refresh` and `router` are both stable (useCallback / next/navigation),
    // so this still runs exactly once per Stripe return trip.
  }, [checkoutState, sessionId, refresh, router]);

  const handleUpgrade = useCallback(async () => {
    if (!isSignedIn) {
      router.push("/sign-up?redirect_url=%2Fupgrade-pro");
      return;
    }
    setError(null);
    setBusy(true);
    const result = await startProCheckout(resolvedPlan.key);
    if (!result.ok) {
      setBusy(false);
      setError(result.error ?? "Could not start the subscription.");
      void status.refresh();
    }
  }, [isSignedIn, resolvedPlan.key, router, status]);

  const handleManage = useCallback(async () => {
    setError(null);
    setBusy(true);
    const result = await openProBillingPortal();
    if (!result.ok) {
      setBusy(false);
      setError(result.error ?? "Could not open subscription management.");
    }
  }, []);

  return (
    <div className="relative min-h-screen">
      <InteractiveCasinoBg variant="subtle" />
      <NavigationBar currentPath="/upgrade-pro" />

      <main className="relative z-10 mx-auto max-w-4xl px-4 pb-20 pt-24 sm:pt-28">
        <header className="mb-6 text-center">
          <h1 className="text-3xl font-black tracking-tight text-[#f5ff3b] drop-shadow-[0_0_10px_rgba(245,255,59,0.5)] sm:text-4xl">
            Upgrade to {resolvedPlan.name}
          </h1>
          <p className="mx-auto mt-2 max-w-2xl text-sm text-[#9dd8ff]/85 sm:text-base">
            A monthly membership for players who want to compete without
            distractions. It never changes your odds, Elo or matchmaking.
          </p>
        </header>

        {checkoutState === "cancelled" && (
          <p
            role="status"
            className="mx-auto mb-5 max-w-xl rounded-lg border border-[#00e5ff]/30 bg-[#0b224f]/80 px-4 py-2 text-center text-sm text-[#9dd8ff]"
          >
            Checkout cancelled — nothing was charged.
          </p>
        )}

        {checkoutState === "success" && (
          <p
            role="status"
            className="mx-auto mb-5 max-w-xl rounded-lg border border-green-400/40 bg-green-500/10 px-4 py-2 text-center text-sm text-green-300"
          >
            {confirming || !active
              ? "Payment received — activating your GRYND PRO membership…"
              : "You're on GRYND PRO. Enjoy the distraction-free experience."}
          </p>
        )}

        <UpgradeProContent
          plan={resolvedPlan}
          active={active}
          signedIn={isSignedIn}
          currentPeriodEnd={currentPeriodEnd}
          busy={busy}
          error={error}
          variant="page"
          imagePriority
          onUpgrade={handleUpgrade}
          onManage={handleManage}
          onSignIn={handleUpgrade}
        />

        <section className="mt-8 rounded-2xl border border-[#00e5ff]/25 bg-[#0b224f]/70 p-6">
          <h2 className="text-xl font-bold text-[#00e5ff]">
            Free forever — no membership required
          </h2>
          <p className="mt-1 text-sm text-[#9dd8ff]/80">
            GRYND PRO is convenience and insight, never an advantage. Everything
            competitive stays identical for every player:
          </p>
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
          <p className="mt-4 text-xs text-[#9dd8ff]/70">
            Free accounts see ads. GRYND PRO removes them and adds the deeper
            statistics, analytics and match history.
          </p>
        </section>

        <section className="mt-6 rounded-2xl border border-[#00e5ff]/25 bg-[#0b224f]/70 p-6">
          <h2 className="text-xl font-bold text-[#00e5ff]">Billing</h2>
          <ul className="mt-3 space-y-2 text-sm text-[#9dd8ff]/85">
            <li>
              • Billed monthly through Stripe —{" "}
              <span className="text-[#f5ff3b]">${resolvedPlan.priceUsd}/month</span>.
            </li>
            <li>• Cancel or change your payment method any time in the billing portal.</li>
            <li>
              • Managing an existing membership?{" "}
              <Link href="/profil" className="text-[#f5ff3b] underline">
                Your profile
              </Link>{" "}
              shows your current status.
            </li>
          </ul>
        </section>
      </main>

      <Footer />
    </div>
  );
}
