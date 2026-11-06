"use client";

// src/components/guest/GuestClaimPanel.tsx
//
// The signed-in half of guest→account conversion (Phase 4).
//
// It asks GET /api/guest/claim what this browser's guest record would mean for
// this account, and shows one button that calls POST /api/guest/claim. Both
// requests are same-origin and carry the signed `grynd_guest` cookie; neither
// sends a guest id, so the panel can only ever act on its own browser.
//
// COPY THAT MATTERS
//
//  · the account's existing progression is NOT changed by a claim;
//  · guest matches remain practice results and are never rated;
//  · a claimed record is reported as claimed, with the date, and cannot be
//    claimed again.
//
// A failed claim keeps the guest cookie, so the retry offered here works. When
// there is no guest record (or no finished practice match), the panel renders
// nothing at all — the normal profile/sync experience is untouched.

import { useCallback, useEffect, useState } from "react";
import { IconCheck, IconLink, IconRefresh } from "@tabler/icons-react";
import { useTranslation } from "../../hooks/useTranslation";

const ENDPOINT = "/api/guest/claim";

type Totals = { matches: number; wins: number; losses: number; draws: number };

type ClaimState =
  | { status: "no_guest" }
  | { status: "no_progress" }
  | { status: "invalid_identity" }
  | { status: "unclaimed"; totals: Totals }
  | { status: "claimed_by_you"; claimedAt: string; totals: Totals }
  | { status: "guest_already_claimed" }
  | { status: "account_already_claimed"; claimedAt: string };

type View = { status: "loading" } | { status: "ready"; state: ClaimState } | { status: "error" };

function formatDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function GuestClaimPanel({
  onClaimed,
}: {
  /** Called after a successful claim (the /welcome/claim flow continues). */
  onClaimed?: () => void;
} = {}) {
  const { t } = useTranslation();
  const [view, setView] = useState<View>({ status: "loading" });
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      setView({ status: "loading" });
      try {
        const response = await fetch(ENDPOINT, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null);
        if (cancelled) return;

        // 401 means this browser has no signed-in account for the status read;
        // there is nothing to show and nothing is wrong.
        if (response.status === 401) {
          setView({ status: "ready", state: { status: "no_guest" } });
          return;
        }
        if (!response.ok || payload?.success !== true || !payload?.data?.status) {
          setView({ status: "error" });
          return;
        }
        setView({ status: "ready", state: payload.data as ClaimState });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setView({ status: "error" });
      }
    }

    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [attempt]);

  const claim = useCallback(async () => {
    setClaiming(true);
    setClaimError(null);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);

      if (response.ok && payload?.success === true) {
        setView({ status: "ready", state: payload.data as ClaimState });
        onClaimed?.();
        return;
      }

      if (payload?.code === "guest_already_claimed") {
        setView({ status: "ready", state: { status: "guest_already_claimed" } });
        return;
      }
      if (payload?.code === "account_already_claimed") {
        setAttempt((value) => value + 1);
        return;
      }
      if (payload?.code === "guest_session_required") {
        setView({ status: "ready", state: { status: "no_guest" } });
        return;
      }
      setClaimError(
        payload?.error ||
          t(
            "guestClaim.error",
            "We couldn't link your practice record. It is still saved in this browser — try again.",
          ),
      );
    } catch {
      setClaimError(
        t(
          "guestClaim.error",
          "We couldn't link your practice record. It is still saved in this browser — try again.",
        ),
      );
    } finally {
      setClaiming(false);
    }
  }, [onClaimed, t]);

  if (view.status === "loading") {
    return (
      <div
        data-testid="guest-claim-loading"
        className="mb-6 h-20 animate-pulse rounded-xl border border-white/10 bg-white/5"
        aria-busy="true"
      />
    );
  }

  // Nothing to say: no guest session, no finished practice match, or an
  // unreadable session. The page around this panel remains exactly as before.
  if (view.status === "error") {
    return (
      <div
        data-testid="guest-claim-error"
        className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-[#9dd8ff]/80"
      >
        <span>
          {t("guestClaim.loadError", "Couldn't check your guest practice record.")}
        </span>
        <button
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
          className="inline-flex items-center gap-1 rounded-lg border border-[#00e5ff]/40 px-3 py-1.5 text-xs font-semibold text-[#00e5ff] transition hover:bg-[#00e5ff]/10"
        >
          <IconRefresh size={14} aria-hidden="true" />
          {t("guestClaim.retry", "Retry")}
        </button>
      </div>
    );
  }

  const state = view.state;
  if (
    state.status === "no_guest" ||
    state.status === "no_progress" ||
    state.status === "invalid_identity"
  ) {
    return null;
  }

  if (state.status === "guest_already_claimed") {
    return (
      <section
        data-testid="guest-claim-other"
        className="mb-6 rounded-xl border border-[#f5ff3b]/30 bg-[#f5ff3b]/5 p-4 text-sm text-[#f5ff3b]"
      >
        <p className="font-semibold">
          {t("guestClaim.other.title", "This practice record is already linked")}
        </p>
        <p className="mt-1 text-[#f5ff3b]/80">
          {t(
            "guestClaim.other.body",
            "The guest progress saved in this browser was already claimed by another account. Nothing was changed.",
          )}
        </p>
      </section>
    );
  }

  if (state.status === "account_already_claimed") {
    return (
      <section
        data-testid="guest-claim-account"
        className="mb-6 rounded-xl border border-[#00e5ff]/25 bg-[#04122b]/70 p-4 text-sm text-[#9dd8ff]/80"
      >
        {t(
          "guestClaim.account.body",
          "This account is already linked to a practice record. Each account can keep one guest record.",
        )}
      </section>
    );
  }

  if (state.status === "claimed_by_you") {
    return (
      <section
        data-testid="guest-claim-done"
        className="mb-6 rounded-xl border border-[#00ffa6]/40 bg-[#00ffa6]/5 p-4"
      >
        <p className="inline-flex items-center gap-2 text-sm font-semibold text-[#00ffa6]">
          <IconCheck size={16} aria-hidden="true" />
          {t("guestClaim.done.title", "Practice record claimed")}
        </p>
        <p className="mt-1 text-sm text-[#9dd8ff]/80">
          {t(
            "guestClaim.done.body",
            "Your guest practice results are linked to this account. They stay practice results — no Elo, trophies or rewards were added, and your account statistics are unchanged.",
          )}
        </p>
        <p className="mt-2 text-xs text-[#9dd8ff]/60">
          {formatDate(state.claimedAt)} · {state.totals.matches}{" "}
          {t("guestClaim.done.matches", "practice matches kept separate from rated stats")}
        </p>
      </section>
    );
  }

  // Unclaimed: the only state with a claim button.
  return (
    <section
      data-testid="guest-claim-panel"
      className="mb-6 rounded-xl border border-[#00e5ff]/30 bg-[#04122b]/80 p-4"
    >
      <p className="text-sm font-bold text-white">
        {t("guestClaim.title", "Keep your guest practice record")}
      </p>
      <p className="mt-1 text-sm text-[#9dd8ff]/80">
        {state.totals.matches}{" "}
        {t(
          "guestClaim.body",
          "practice matches are saved in this browser. Link them to this account?",
        )}
      </p>
      <p className="mt-2 text-xs text-[#9dd8ff]/60">
        {t(
          "guestClaim.reassurance",
          "Your existing account stats, Elo and trophies are not overwritten, and guest matches stay unrated practice results.",
        )}
      </p>

      {claimError ? (
        <p role="alert" className="mt-3 text-sm text-red-300">
          {claimError}
        </p>
      ) : null}

      <button
        type="button"
        onClick={claim}
        disabled={claiming}
        className="mt-3 inline-flex items-center gap-2 rounded-lg border border-[#00ffa6]/40 bg-[#00ffa6]/10 px-4 py-2 text-sm font-semibold text-[#00ffa6] transition hover:bg-[#00ffa6]/20 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <IconLink size={16} aria-hidden="true" />
        {claiming
          ? t("guestClaim.claiming", "Linking…")
          : t("guestClaim.cta", "Claim my practice record")}
      </button>
    </section>
  );
}
