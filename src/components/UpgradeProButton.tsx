"use client";

// src/components/UpgradeProButton.tsx
//
// THE reusable GRYND PRO call to action. Drop it on any non-gameplay page:
//
//   <UpgradeProButton />                     // default CTA
//   <UpgradeProButton variant="compact" />   // fits a page header
//
// It reads the caller's membership from /api/membership/status (server
// authoritative — see lib/upgradePro.ts), then:
//
//   * active subscriber → "Manage Subscription" → Stripe Customer Portal,
//   * signed-in free user → "Upgrade to GRYND PRO" → the upgrade modal →
//     Stripe Checkout,
//   * signed-out visitor → the modal, whose CTA routes through sign-up and
//     returns to /upgrade-pro.
//
// Until the server answers it renders a neutral, disabled button, so the
// client can neither claim PRO nor flash the wrong action. The price shown in
// the modal comes from the server-resolved plan, never from this component.

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import UpgradeProModal from "./UpgradeProModal";
import {
  UPGRADE_PRO_PATH,
  type ProPlanDisplay,
} from "../lib/membershipDisplay";
import {
  openProBillingPortal,
  startProCheckout,
  useMembershipStatus,
} from "../lib/upgradePro";

export type UpgradeProButtonProps = {
  /** `cta` (default) is the full-width attention button; `compact` fits headers. */
  variant?: "cta" | "compact";
  className?: string;
  /** Override the free-user label. */
  label?: string;
  /** Override the subscriber label. */
  activeLabel?: string;
  /** Skip the modal and go straight to the /upgrade-pro page. */
  linkToPage?: boolean;
  /** Server-rendered plan (e.g. from the /upgrade-pro page) — avoids a price flash. */
  initialPlan?: ProPlanDisplay | null;
  initialActive?: boolean;
  initialSignedIn?: boolean;
};

const CTA_CLASS =
  "inline-flex w-full items-center justify-center rounded-xl border border-[#f5ff3b]/60 bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-5 py-3 text-base font-bold text-[#1f1700] shadow-[0_0_25px_rgba(245,255,59,0.35)] transition hover:brightness-110 hover:shadow-[0_0_40px_rgba(245,255,59,0.55)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817] disabled:opacity-60 sm:w-auto";

const COMPACT_CLASS =
  "inline-flex items-center justify-center rounded-lg border border-[#f5ff3b]/50 bg-[#f5ff3b]/10 px-3 py-1.5 text-sm font-semibold text-[#f5ff3b] transition hover:bg-[#f5ff3b]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817] disabled:opacity-60";

export default function UpgradeProButton({
  variant = "cta",
  className = "",
  label = "Upgrade to GRYND PRO",
  activeLabel = "Manage Subscription",
  linkToPage = false,
  initialPlan = null,
  initialActive = false,
  initialSignedIn = false,
}: UpgradeProButtonProps) {
  const router = useRouter();
  const status = useMembershipStatus();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = status.loaded || Boolean(initialPlan);
  const plan = status.plan ?? initialPlan;
  const active = status.loaded ? status.active : initialActive;
  const signedIn = status.loaded ? status.signedIn : initialSignedIn;

  const baseClass = variant === "compact" ? COMPACT_CLASS : CTA_CLASS;
  const buttonClass = `${baseClass} ${className}`.trim();

  const handleManage = useCallback(async () => {
    setError(null);
    setBusy(true);
    const result = await openProBillingPortal();
    if (!result.ok) {
      setBusy(false);
      setError(result.error ?? "Could not open subscription management.");
    }
  }, []);

  const handleUpgrade = useCallback(async () => {
    if (!plan) return;
    if (!signedIn) {
      router.push(`/sign-up?redirect_url=${encodeURIComponent(UPGRADE_PRO_PATH)}`);
      return;
    }
    setError(null);
    setBusy(true);
    const result = await startProCheckout(plan.key);
    if (!result.ok) {
      setBusy(false);
      setError(result.error ?? "Could not start the subscription.");
      // The server may already know about a subscription the client hasn't
      // seen yet (webhook race) — re-read so the button flips to Manage.
      void status.refresh();
    }
  }, [plan, signedIn, router, status]);

  const handleTrigger = useCallback(() => {
    setError(null);
    if (linkToPage) {
      router.push(UPGRADE_PRO_PATH);
      return;
    }
    setOpen(true);
  }, [linkToPage, router]);

  // Neutral placeholder until the server has told us who this user is.
  if (!ready || !plan) {
    return (
      <button
        type="button"
        disabled
        aria-busy="true"
        className={buttonClass}
        data-testid="upgrade-pro-button"
      >
        GRYND PRO
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={active ? handleManage : handleTrigger}
        disabled={busy}
        className={buttonClass}
        data-testid="upgrade-pro-button"
        data-pro-active={active ? "true" : "false"}
      >
        {busy
          ? "Opening Stripe…"
          : active
            ? activeLabel
            : label}
      </button>

      {!active && (
        <UpgradeProModal
          open={open}
          onClose={() => setOpen(false)}
          content={{
            plan,
            active,
            signedIn,
            currentPeriodEnd: status.currentPeriodEnd,
            busy,
            error,
            onUpgrade: handleUpgrade,
            onManage: handleManage,
            onSignIn: handleUpgrade,
          }}
        />
      )}
    </>
  );
}
