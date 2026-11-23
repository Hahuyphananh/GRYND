"use client";

// src/components/play/PuzzleRankedLobby.tsx
//
// THE PUZZLE RANKED LOBBY — human matchmaking, and nothing else.
//
// This page talks to the Puzzle Ranked queue only:
//
//   POST /api/solitaire-puzzle/queue   open or join a search
//   GET  /api/solitaire-puzzle/queue   resume a reloaded search
//   DELETE /api/solitaire-puzzle/queue cancel this player's own waiting search
//
// It never calls the Solitaire Duel lobby, never links to the regular Ranked
// page, and has no AI path: the copy says the opponent is a person because the
// server only pairs people. A low population is shown as an honest waiting
// state with a cancel button — there is no bot fallback anywhere in this flow.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import ModeLobby from "./ModeLobby";
import PuzzleSessionPlayer from "./PuzzleSessionPlayer";
import { useTranslation } from "../../hooks/useTranslation";

type QueueState = {
  sessionId: string | null;
  status: string | null;
  waiting: boolean;
  joined: boolean;
  alreadyActive: boolean;
  goAtMs: number | null;
  deadlineAtMs: number | null;
  waitingSinceMs: number | null;
  queueExpiresAtMs: number | null;
  serverNowMs: number;
};

function formatClock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function PuzzleRankedLobby() {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [mounted, setMounted] = useState(false);

  const read = useCallback(async () => {
    try {
      const res = await fetch("/api/solitaire-puzzle/queue", { cache: "no-store" });
      if (res.status === 401 || res.status === 403) {
        setSignedOut(true);
        return null;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) {
        setErrorKey("queueError");
        return null;
      }
      setSignedOut(false);
      setErrorKey(null);
      setQueue((body?.data ?? null) as QueueState | null);
      return body?.data as QueueState | null;
    } catch {
      setErrorKey("queueError");
      return null;
    }
  }, []);

  useEffect(() => {
    setMounted(true);
    void read();
  }, [read]);

  // A waiting search is re-read until it is matched, cancelled or expires.
  useEffect(() => {
    if (!queue?.waiting) return;
    const id = setInterval(() => {
      void read();
    }, 2_500);
    return () => clearInterval(id);
  }, [queue?.waiting, read]);

  const find = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setErrorKey(null);
    try {
      const res = await fetch("/api/solitaire-puzzle/queue", { method: "POST" });
      if (res.status === 401 || res.status === 403) {
        setSignedOut(true);
        return;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) {
        setErrorKey("queueError");
        return;
      }
      setQueue((body?.data ?? null) as QueueState | null);
    } catch {
      setErrorKey("queueError");
    } finally {
      setBusy(false);
    }
  }, [busy]);

  // A settled race is over. "Play again" drops it and opens a FRESH search,
  // so the next opponent is another person waiting in the queue — never a
  // rematch against the same seat and never a bot.
  const playAgain = useCallback(async () => {
    if (busy) return;
    setQueue(null);
    setErrorKey(null);
    await find();
  }, [busy, find]);

  // Back to lobby also leaves the settled match behind: the lobby then shows
  // the real queue state (idle, or a still-waiting search) instead of the
  // finished board. A same-route Link alone would keep this state alive.
  const backToLobby = useCallback(async () => {
    setQueue(null);
    await read();
  }, [read]);

  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    setErrorKey(null);
    try {
      const res = await fetch("/api/solitaire-puzzle/queue", { method: "DELETE" });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) {
        setErrorKey("cancelError");
        return;
      }
      // An opponent can take the seat in the same instant as the cancel: the
      // server then refuses the cancel (`cancelled: false`) because the race is
      // already live. Re-read instead of dropping a real match on the floor.
      if ((body.data as { cancelled?: boolean } | null)?.cancelled === false) {
        await read();
        return;
      }
      setQueue(null);
    } catch {
      setErrorKey("cancelError");
    } finally {
      setBusy(false);
    }
  };

  const waiting = Boolean(queue?.waiting);
  const matched = queue?.status === "playing";

  // A matched ranked race is the board, full width. The queue is frozen while
  // it plays (the interval above only runs while `waiting`).
  if (matched && queue?.sessionId) {
    return (
      <PuzzleSessionPlayer
        sessionId={queue.sessionId}
        mode="ranked"
        onPlayAgain={playAgain}
        onBackToLobby={backToLobby}
      />
    );
  }

  const action = signedOut ? (
    <Link
      href="/sign-in"
      className="inline-flex min-h-11 items-center justify-center rounded-xl bg-[#5eead4] px-5 py-2.5 text-sm font-black text-[#04120f] transition hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/70"
    >
      {t("playHub.lobby.puzzleRanked.signIn")}
    </Link>
  ) : waiting ? (
    <button
      type="button"
      onClick={cancel}
      disabled={busy}
      data-testid="puzzle-ranked-cancel"
      className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[#5eead4]/45 bg-[#5eead4]/10 px-5 py-2.5 text-sm font-black text-[#ccfbf1] transition hover:bg-[#5eead4]/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5eead4] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
    >
      {t("playHub.lobby.puzzleRanked.cancel")}
    </button>
  ) : (
    <button
      type="button"
      onClick={find}
      disabled={busy}
      data-testid="puzzle-ranked-find"
      className="inline-flex min-h-11 items-center justify-center rounded-xl bg-[#5eead4] px-5 py-2.5 text-sm font-black text-[#04120f] transition hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy ? t("playHub.lobby.puzzleRanked.searching") : t("playHub.lobby.puzzleRanked.cta")}
    </button>
  );

  return (
    <ModeLobby mode="puzzleRanked" action={action}>
      <div
        data-testid="puzzle-ranked-status"
        aria-live="polite"
        className="rounded-xl border border-white/10 bg-black/25 p-4 text-xs leading-relaxed text-white/70"
      >
        {signedOut ? (
          <p>{t("playHub.lobby.puzzleRanked.signIn")}</p>
        ) : errorKey ? (
          <p role="alert" className="text-rose-200">
            {t(`playHub.lobby.puzzleRanked.${errorKey}`)}
          </p>
        ) : matched ? (
          <p className="font-bold text-[#5eead4]">
            {t("playHub.lobby.puzzleRanked.matched")}
          </p>
        ) : waiting ? (
          <div className="space-y-1.5">
            <p className="font-bold text-[#5eead4]">
              {t("playHub.lobby.puzzleRanked.waiting")}
            </p>
            {mounted && queue?.queueExpiresAtMs ? (
              <p className="text-white/45">
                {t("playHub.lobby.puzzleRanked.expires").replace(
                  "{time}",
                  formatClock(queue.queueExpiresAtMs),
                )}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-white/55">
            {t("playHub.lobby.puzzleRanked.humanNote")}
          </p>
        )}
      </div>
    </ModeLobby>
  );
}
