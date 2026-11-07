// src/lib/guest/postMatchCta.ts
//
// PURE decision rules for the post-match account invitation (Phase 5).
//
// The results screen asks one question — "should this visitor be invited to
// create an account?" — and this module answers it. Keeping the rules here
// (not inside JSX) means the display conditions can be tested directly:
//
//   · only a GUEST sees it (never an authenticated account, and never an
//     identity that has not loaded yet — guessing here would flash the card at
//     signed-in players);
//   · only once a match has ACTUALLY finished, so nothing appears during play,
//     matchmaking, loading, or on a cancelled match;
//   · only on a game whose practice results are actually persisted for guests,
//     so the card's claim ("your progress is already saved") is always true;
//   · only when this browser's guest session resolved (the server said the
//     HMAC-signed cookie is valid), so a signed-out visitor with no guest
//     record is never told about progress that does not exist;
//   · never twice for the same match, and never after a dismissal.
//
// CLIENT-SAFE BY CONSTRUCTION: it imports the same pure, dependency-free game
// vocabulary the guest profile view uses (no database, no server modules), so a
// result screen can import it without pulling server code into the bundle.

import { GUEST_GAME_LABELS } from "./guestProgressView";

/** sessionStorage prefix for "this browser dismissed the card". */
export const GUEST_POST_MATCH_CTA_STORAGE_PREFIX = "grynd:guest-post-match-cta";

/**
 * Where the account flow continues. `/sync` is the existing post-sign-up /
 * post-sign-in handoff: it syncs the account and, when this browser still holds
 * an unclaimed guest record, routes on to `/welcome/claim`. Pointing the CTA at
 * it means the Phase 4 conversion claims the guest progression through the ONE
 * existing mechanism — the card adds an entry point, never a second claim path.
 */
export const GUEST_POST_MATCH_CTA_NEXT = "/sync";

/** How far the guest session check has got for this browser. */
export type GuestPostMatchSession = "pending" | "present" | "absent";

export type GuestPostMatchCtaInput = {
  /** Clerk has resolved whether the visitor is signed in. */
  isLoaded: boolean;
  isSignedIn: boolean;
  /** The result is really on screen — the match reached a final state. */
  matchFinished: boolean;
  /** Canonical game key of the match that just ended. */
  gameKey: string | null | undefined;
  /** Answer of GET /api/guest/progress for this browser. */
  guestSession: GuestPostMatchSession;
  /** This browser already dismissed the invitation for this match. */
  dismissed: boolean;
  /** Creator Mode recording frame: the card is never recorded. */
  compact?: boolean;
};

/**
 * True only for the games whose guest practice results are persisted, which is
 * exactly the set the guest profile can show (GUEST_PRACTICE_GAME_KEYS on the
 * server; tests/guest-post-match-cta.test.mjs pins the two lists together).
 */
export function supportsGuestProgress(gameKey: unknown): boolean {
  return (
    typeof gameKey === "string" &&
    Object.prototype.hasOwnProperty.call(GUEST_GAME_LABELS, gameKey)
  );
}

/** The single display rule for the post-match invitation. */
export function shouldShowGuestPostMatchCta(
  input: GuestPostMatchCtaInput | null | undefined,
): boolean {
  if (!input) return false;
  if (!input.isLoaded) return false; // identity unknown — never flash the card
  if (input.isSignedIn) return false; // a converted guest is an account now
  if (!input.matchFinished) return false; // playing, loading, matchmaking, cancelled
  if (input.compact) return false; // a recorded Creator Mode frame
  if (!supportsGuestProgress(input.gameKey)) return false;
  if (input.guestSession !== "present") return false;
  return !input.dismissed;
}

/**
 * One key per match, so a re-render, a remount or reopening the result screen
 * cannot show a second invitation for the same finished game. A client-settled
 * practice board that carries no route id falls back to its path, which is the
 * same rule the post-match ad slot uses to identify a practice result.
 */
export function guestPostMatchCtaKey(input: {
  gameKey: string;
  matchId?: string | null;
  pathname?: string | null;
}): string {
  const match =
    typeof input.matchId === "string" && input.matchId.trim()
      ? input.matchId.trim()
      : typeof input.pathname === "string" && input.pathname
        ? input.pathname
        : "unknown-match";
  return `${GUEST_POST_MATCH_CTA_STORAGE_PREFIX}:${input.gameKey}:${match}`;
}

/** True when this browser already dismissed the card for that match. */
export function readGuestPostMatchCtaDismissed(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(key) === "1";
  } catch {
    // Denied storage: the card may reappear on a remount. Harmless.
    return false;
  }
}

/** Remember a dismissal for the rest of this browser session. */
export function rememberGuestPostMatchCtaDismissed(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, "1");
  } catch {
    // Denied storage: the dismissal still applies to the mounted card.
  }
}

/**
 * The two existing entry points, both pointed at the post-auth handoff. Plain
 * same-origin links: the HttpOnly `grynd_guest` cookie is untouched, so the
 * guest session — and the progression it points at — survives the trip.
 */
export function guestPostMatchCtaHrefs(): { signUp: string; signIn: string } {
  const next = encodeURIComponent(GUEST_POST_MATCH_CTA_NEXT);
  return {
    signUp: `/sign-up?redirect_url=${next}`,
    signIn: `/sign-in?redirect_url=${next}`,
  };
}
