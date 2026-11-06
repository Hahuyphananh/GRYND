"use client";

// src/app/welcome/claim/PageClient.tsx
//
// The one-step offer shown after sign-up / sign-in when this browser still has
// an unclaimed guest practice record (Phase 4). /sync routes here only for
// that case; everyone else keeps the existing destinations.
//
// The claim itself is the same POST /api/guest/claim used by the profile panel.
// Skipping changes nothing, and a failed claim keeps the guest cookie so the
// user can continue now or retry later from /profil.

import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import GuestClaimPanel from "../../../components/guest/GuestClaimPanel";
import { useTranslation } from "../../../hooks/useTranslation";

function safeNext(value: string | null): string {
  // Only same-site paths: a protocol-relative `//host` is an external redirect.
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export default function ClaimPage() {
  const { t } = useTranslation();
  const { isLoaded, isSignedIn } = useUser();
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get("next"));

  return (
    <div
      className="flex min-h-screen items-center justify-center px-4 py-16 text-white"
      style={{ background: "linear-gradient(135deg, #001933 0%, #000d1a 100%)" }}
    >
      <div className="w-full max-w-xl">
        <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#00e5ff]">
          {t("guestClaim.eyebrow", "One last step")}
        </p>
        <h1 className="mt-2 text-3xl font-black text-white">
          {t("guestClaim.welcome.title", "Keep the progress you already earned")}
        </h1>
        <p className="mt-2 text-sm text-[#9dd8ff]/80">
          {t(
            "guestClaim.welcome.body",
            "You played as a guest in this browser. Link that practice record to your account, or continue without it.",
          )}
        </p>

        <div className="mt-6">
          {!isLoaded ? (
            <div
              className="h-24 animate-pulse rounded-xl border border-white/10 bg-white/5"
              aria-busy="true"
            />
          ) : isSignedIn ? (
            <GuestClaimPanel />
          ) : (
            <p className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-[#9dd8ff]/80">
              {t(
                "guestClaim.welcome.signedOut",
                "Sign in to link the practice record saved in this browser.",
              )}
            </p>
          )}
        </div>

        <Link
          href={next}
          data-testid="guest-claim-continue"
          className="mt-6 inline-flex rounded-lg border border-[#00e5ff]/40 px-4 py-2 text-sm font-semibold text-[#00e5ff] transition hover:bg-[#00e5ff]/10"
        >
          {t("guestClaim.welcome.continue", "Continue")}
        </Link>
      </div>
    </div>
  );
}
