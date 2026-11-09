"use client";

// src/components/guest/GuestPostMatchCta.tsx
//
// Guest → account invitation shown ON a finished match's result screen
// (Phase 5). It adds an entry point to the EXISTING account flow; it converts
// nothing by itself.
//
// HOW IT DECIDES
//
//   · Signed in → renders nothing. A guest who already converted is an account,
//     so the invitation stops by construction rather than by a stored flag.
//   · Signed out → the guest identity IS the HttpOnly `grynd_guest` cookie, and
//     only the server can read it. ONE read of GET /api/guest/progress answers
//     whether this browser still holds a guest record (401/403 = no guest).
//     Nothing is sent, so the card can only ever describe this browser's own
//     record — and it is never shown on a response we could not read.
//   · The rest of the rule set (finished match only, supported games only,
//     dismissal, recording frames) lives in lib/guest/postMatchCta.ts.
//
// HOW IT CONVERTS
//
// Both buttons are plain same-origin links to the existing Clerk routes with
// the existing post-auth handoff as the destination: /sign-up and /sign-in take
// the visitor through the normal flow and land on /sync, which routes a still
// unclaimed guest record to /welcome/claim. That is the Phase 4 claim, reached
// through its only door — no second claim path, no client-side guest id, and
// nothing clears the guest cookie, so the progression survives the trip.
//
// WHAT IT NEVER DOES
//
// No account creation, no claim request, no guest id in a URL or storage, no
// write of any kind. Dismissing it changes nothing but this tab's UI, so the
// guest can keep playing exactly as before.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";
import { IconArrowRight, IconCheck, IconX } from "@tabler/icons-react";

import { useTranslation } from "../../hooks/useTranslation";
import { normalizeGuestProgressResponse } from "../../lib/guest/guestProgressView";
import {
  guestPostMatchCtaHrefs,
  guestPostMatchCtaKey,
  readGuestPostMatchCtaDismissed,
  rememberGuestPostMatchCtaDismissed,
  shouldShowGuestPostMatchCta,
  supportsGuestProgress,
  type GuestPostMatchSession,
} from "../../lib/guest/postMatchCta";

export default function GuestPostMatchCta({
  gameKey,
  matchId = null,
  matchFinished = true,
  compact = false,
}: {
  /** Canonical key of the game that just ended (see GUEST_GAME_LABELS). */
  gameKey: string;
  /** Route/query id of this match, so the card is offered once per match. */
  matchId?: string | null;
  /** The result is really on screen — the match reached a final state. */
  matchFinished?: boolean;
  /** Creator Mode recording frame: the card is never recorded. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const { isLoaded, isSignedIn } = useUser();

  // "pending" until the server says whether this browser holds a guest cookie.
  const [guestSession, setGuestSession] = useState<GuestPostMatchSession>("pending");
  const [savedMatches, setSavedMatches] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const storageKey = guestPostMatchCtaKey({ gameKey, matchId, pathname });

  // A dismissal belongs to this finished match, for the rest of this session.
  useEffect(() => {
    setDismissed(readGuestPostMatchCtaDismissed(storageKey));
  }, [storageKey]);

  useEffect(() => {
    // Only a signed-out visitor on a finished, guest-supported result needs an
    // answer; an account never issues the request at all.
    if (!isLoaded || isSignedIn) return undefined;
    if (!matchFinished || compact) return undefined;
    if (!supportsGuestProgress(gameKey)) return undefined;

    let cancelled = false;
    const controller = new AbortController();

    fetch("/api/guest/progress", {
      // The signed guest cookie is the identity; it is never sent cross-site.
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        return normalizeGuestProgressResponse(response.status, payload);
      })
      .then((view) => {
        if (cancelled) return;
        if (view.status === "ready") {
          setGuestSession("present");
          setSavedMatches(view.data.totals.matches);
          return;
        }
        // 401/403 (no guest record) or a read we cannot trust: no invitation.
        // An account offer must never rest on progress we cannot prove exists.
        setGuestSession("absent");
        setSavedMatches(null);
      })
      .catch(() => {
        if (!cancelled) setGuestSession("absent");
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isLoaded, isSignedIn, gameKey, matchFinished, compact]);

  const dismiss = useCallback(() => {
    rememberGuestPostMatchCtaDismissed(storageKey);
    setDismissed(true);
  }, [storageKey]);

  const show = shouldShowGuestPostMatchCta({
    isLoaded: Boolean(isLoaded),
    isSignedIn: Boolean(isSignedIn),
    matchFinished,
    gameKey,
    guestSession,
    dismissed,
    compact,
  });

  if (!show) return null;

  const { signUp, signIn } = guestPostMatchCtaHrefs();

  return (
    <section
      data-testid="guest-post-match-cta"
      data-guest-game={gameKey}
      aria-labelledby="guest-post-match-cta-title"
      // Inline in the result panel's own flow: it never covers the outcome,
      // the final score or the retry/lobby controls, and it never takes focus.
      className="rounded-2xl border border-[#00e5ff]/30 bg-linear-to-br from-[#062138] via-[#04122b] to-[#0a0f2a] p-4 text-left shadow-[0_0_30px_rgba(0,229,255,0.16)]"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 rounded-full border border-[#00ffa6]/40 bg-[#00ffa6]/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.18em] text-[#00ffa6]">
          {t("guestProgress.postMatch.eyebrow", "Guest")}
        </p>
        <button
          type="button"
          data-testid="guest-post-match-dismiss"
          onClick={dismiss}
          aria-label={t(
            "guestProgress.postMatch.dismissAria",
            "Dismiss the account invitation",
          )}
          className="-mr-1 -mt-1 rounded-lg p-1 text-white/40 transition hover:bg-white/10 hover:text-white/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00e5ff]"
        >
          <IconX size={16} aria-hidden="true" />
        </button>
      </div>

      <h3
        id="guest-post-match-cta-title"
        className="mt-2 text-base font-black leading-tight text-white"
      >
        {t(
          "guestProgress.postMatch.title",
          "Keep your progress. Create your GRYND account.",
        )}
      </h3>
      <p className="mt-1.5 text-[13px] leading-snug text-[#9dd8ff]/85">
        {t(
          "guestProgress.postMatch.body",
          "Your guest progress is already saved. Create an account to attach it to your profile and keep it when you switch devices.",
        )}
      </p>

      {savedMatches !== null && savedMatches > 0 ? (
        <p
          data-testid="guest-post-match-saved"
          className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#00ffa6]"
        >
          <IconCheck size={14} aria-hidden="true" />
          {t("guestProgress.postMatch.saved", {
            count: savedMatches,
          })}
        </p>
      ) : null}

      <div className="mt-3 flex flex-col gap-2">
        <Link
          href={signUp}
          data-testid="guest-post-match-signup"
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl border-b-4 border-[#00a86b] bg-[#00ffa6] px-4 py-2.5 text-sm font-extrabold text-[#00231a] transition hover:brightness-110"
        >
          {t("guestProgress.postMatch.primary", "Create Free Account")}
          <IconArrowRight size={16} aria-hidden="true" />
        </Link>
        <p className="text-center text-[10px] font-semibold uppercase tracking-wider text-[#9dd8ff]/55">
          {t(
            "guestProgress.postMatch.free",
            "Free to create — no payment, no card",
          )}
        </p>
        <Link
          href={signIn}
          data-testid="guest-post-match-signin"
          className="inline-flex w-full items-center justify-center rounded-xl border border-[#00e5ff]/40 bg-[#00e5ff]/5 px-4 py-2.5 text-xs font-semibold text-[#67f9ff] transition hover:bg-[#00e5ff]/15"
        >
          {t(
            "guestProgress.postMatch.secondary",
            "Already have an account? Sign in",
          )}
        </Link>
      </div>
    </section>
  );
}
