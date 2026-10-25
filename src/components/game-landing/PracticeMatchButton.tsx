"use client";

// src/components/game-landing/PracticeMatchButton.tsx
//
// THE "PLAY THE BOT" ENTRY ON A PUBLIC GAME LANDING PAGE.
//
// ── WHY IT IS A CLIENT COMPONENT ──────────────────────────────────────────
//
// Starting a practice match is a POST that creates a real match row server-side
// and answers with its id, so it cannot happen while the landing page is being
// rendered. The page itself stays a server component (all of its copy — the H1,
// the rules, the FAQ — is in the HTML response, which is the whole point of
// /games/<slug>); only this one button is client-side.
//
// ── WHAT IT DOES, AND WHAT IT DOES NOT ────────────────────────────────────
//
// It sends an EMPTY body to the game's own practice route and follows the match
// id that comes back. It decides nothing about the match: no difficulty, no
// deal, no seat — the route mints a guest seat for a signed-out visitor, picks
// the opening seat from the tiles and plays the bot's first turn if the bot won
// the bid. The same route the lobby uses, so a practice match started here is
// identical to one started from the lobby.
//
// It uses the shared `useMatchRouter`, which turns the entry into a DOCUMENT
// navigation when this document has loaded ad code (lib/matchNavigation.ts), so
// a landing page's ad tag can never keep running over the board.
//
// ── SIGNED OUT IS ALLOWED ─────────────────────────────────────────────────
//
// Practice is the free, unrated half of the game and the practice routes accept
// a guest. A signed-in player goes through the normal age gate inside the route;
// if that refuses, the route's own message is shown under the button rather than
// a generic failure.

import { useCallback, useState } from "react";
import { IconRobot } from "@tabler/icons-react";

import { useMatchRouter } from "../../hooks/useMatchRouter";

export type PracticeMatchButtonProps = {
  /** The game's practice entry route, e.g. `/api/dominoes/create-ai`. */
  apiPath: string;
  /** The visible label, e.g. "Play the bot". */
  label: string;
  /**
   * The game's match URL PREFIX, e.g. `/games/dominoes/` (see
   * `gameMatchPathPrefix`); the id the route answers with is appended.
   *
   * A STRING, not a `(matchId) => string` builder, because this component is
   * rendered by a server component: functions are not serialisable across the
   * server/client boundary, and React throws as soon as one is passed — which
   * took the whole landing page down behind the route error boundary.
   */
  matchHrefBase: string;
};

const FAILED = "Unable to start a practice match. Please try again.";

export default function PracticeMatchButton({
  apiPath,
  label,
  matchHrefBase,
}: PracticeMatchButtonProps) {
  const router = useMatchRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The practice routes issue the guest session cookie on create, and the
        // board's own reads need it — so it must be sent and stored.
        credentials: "include",
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => null);
      const matchId = data?.data?.matchId;
      if (!res.ok || !data?.success || typeof matchId !== "string" || !matchId) {
        setError(typeof data?.error === "string" && data.error ? data.error : FAILED);
        setBusy(false);
        return;
      }
      // Deliberately left busy: this document is on its way to the board.
      router.push(`${matchHrefBase}${matchId}`);
    } catch {
      setError(FAILED);
      setBusy(false);
    }
  }, [apiPath, busy, matchHrefBase, router]);

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={start}
        disabled={busy}
        aria-busy={busy}
        data-testid="landing-practice-cta"
        className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#00e5ff]/35 px-5 py-3 text-sm font-semibold text-[#9dd8ff] transition hover:bg-[#00e5ff]/10 hover:text-[#d8fbff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <IconRobot size={16} aria-hidden="true" />
        {busy ? "Starting practice…" : label}
      </button>
      {error ? (
        <span role="status" aria-live="polite" className="text-xs text-[#ffb4b4]">
          {error}
        </span>
      ) : null}
    </span>
  );
}
