"use client";

// src/components/solitaire-duel/SolitaireLobby.tsx
//
// THE Solitaire lobby — one implementation, mounted in two places:
//
//   * `/`                 (variant "home") — the homepage IS the lobby.
//   * `/casino/solitaire-duel` (variant "page") — the standalone route the
//                         `/games/solitaire-duel/play` rewrite keeps working.
//
// Both render the shared `PvpLobby` chrome, so the two surfaces cannot drift
// apart. Every action here is real:
//
//   ranked   POST /api/solitaire-duel/create-or-join — the store's own
//            matchmaker (advisory lock + FOR UPDATE), which joins the oldest
//            waiting lobby or opens one.
//   practice POST /api/solitaire-duel/create-ai — the real bot, unrated.
//   queue    GET  /api/solitaire-duel/lobby — open lobbies + my waiting lobby,
//            polled so the panel reports the actual queue instead of a number
//            someone typed.
//   resume   the match page for the caller's own waiting lobby.
//   cancel   POST /api/solitaire-duel/match/<id>/cancel.
//
// There is no simulated queue, no invented opponent and no silent fallback to
// the bot: a ranked search that finds nobody leaves the caller waiting, with
// the real state on screen and the decision (wait, cancel, practise) theirs.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { IconCards, IconRobot } from "@tabler/icons-react";

import PvpLobbyPage, { PvpLobby } from "../lobby/PvpLobby";
import { useMatchRouter } from "../../hooks/useMatchRouter";

const LOBBY_POLL_MS = 15_000;
const WAITING_POLL_MS = 5_000;

type OpenLobby = {
  matchId: string;
  createdAtMs: number | null;
};

type WaitingLobby = {
  matchId: string;
  createdAtMs: number | null;
};

type RecentMatch = {
  matchId: string;
  status: string;
  outcome: "win" | "loss" | "draw" | null;
  isAi: boolean;
  opponent: string;
  createdAtMs: number | null;
  endedAtMs: number | null;
};

type LobbySnapshot = {
  open: OpenLobby[];
  myWaiting: WaitingLobby | null;
  recent: RecentMatch[];
  serverNow: number;
};

const matchPath = (matchId: string) => `/casino/solitaire-duel/${matchId}`;

/** "waiting 3m" — derived from the server's own creation instant. */
function waitedFor(createdAtMs: number | null, nowMs: number): string | null {
  if (!createdAtMs) return null;
  const seconds = Math.max(0, Math.round((nowMs - createdAtMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

export default function SolitaireLobby({ variant = "home" }: { variant?: "home" | "page" }) {
  const { isSignedIn } = useUser();
  const router = useMatchRouter();

  const [rankedBusy, setRankedBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<LobbySnapshot | null>(null);
  const [lobbyLoading, setLobbyLoading] = useState(true);
  // The waiting match we just created. The GET snapshot is the source of truth,
  // but between the POST and the next poll this keeps the panel honest.
  const [localWaitingId, setLocalWaitingId] = useState<string | null>(null);

  const waitingId = snapshot?.myWaiting?.matchId ?? localWaitingId;

  const loadLobby = useCallback(async () => {
    try {
      const res = await fetch("/api/solitaire-duel/lobby", {
        cache: "no-store",
        credentials: "include",
      });
      const data = await res.json().catch(() => null);
      if (data?.success && data.data) {
        setSnapshot(data.data);
        // The server says there is no waiting lobby any more (it started, or it
        // was cancelled elsewhere): stop showing the local one.
        if (!data.data.myWaiting) setLocalWaitingId(null);
      }
    } catch {
      // A failed poll keeps the last known state; the next tick retries.
    } finally {
      setLobbyLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLobby();
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void loadLobby();
    }, LOBBY_POLL_MS);
    return () => clearInterval(id);
  }, [loadLobby]);

  // While the caller is queued, read the authoritative match snapshot. The
  // instant an opponent joins, the server flips the row to `playing` and this
  // enters the race — the lobby does not decide that, it just observes it.
  useEffect(() => {
    if (!waitingId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/solitaire-duel/match/${waitingId}`, {
          cache: "no-store",
          credentials: "include",
        });
        const data = await res.json().catch(() => null);
        if (!stopped && data?.success && data.data?.status === "playing") {
          stopped = true;
          router.push(matchPath(waitingId));
        }
      } catch {
        // Poll backstop: the interval tries again.
      }
    };
    void tick();
    const id = setInterval(tick, WAITING_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [waitingId, router]);

  const enterMatch = useCallback(
    (matchId: string) => {
      router.push(matchPath(matchId));
    },
    [router],
  );

  const startRanked = useCallback(async () => {
    if (rankedBusy) return;
    setRankedBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/solitaire-duel/create-or-join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        // Ranked Solitaire is free — the server never asks for a stake.
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(data?.error || "Unable to find a match");
        return;
      }
      const matchId = String(data.data.matchId);
      if (data.data.status === "waiting") {
        // Nobody was waiting: the caller now HOLDS a real open lobby. Stay on
        // the page, show it, and let them wait or cancel.
        setLocalWaitingId(matchId);
        void loadLobby();
        return;
      }
      enterMatch(matchId);
    } catch {
      setError("Unable to find a match");
    } finally {
      setRankedBusy(false);
    }
  }, [enterMatch, loadLobby, rankedBusy]);

  const cancelWaiting = useCallback(async () => {
    if (!waitingId || cancelling) return;
    setCancelling(true);
    setError(null);
    const matchId = waitingId;
    setLocalWaitingId(null);
    try {
      await fetch(`/api/solitaire-duel/match/${matchId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
    } catch {
      setError("Unable to cancel the search. Try again.");
    } finally {
      setCancelling(false);
      void loadLobby();
    }
  }, [cancelling, loadLobby, waitingId]);

  const rules = useMemo(
    () => ({
      title: "How to Play Solitaire Duel",
      sections: [
        {
          heading: "One deal, two players, same puzzle",
          body: (
            <>
              The server generates <b>one deterministic Klondike deal</b> and hands
              the <b>exact same starting position</b> to both players: identical
              tableau, identical face-up and face-down cards, identical stock and
              waste order. You play your own copy — you cannot see, touch or
              interfere with your opponent&apos;s board.
            </>
          ),
        },
        {
          heading: "First to solve it wins",
          body: (
            <>
              Build all four foundations from Ace to King. The{" "}
              <b>first player to put all 52 cards on the foundations wins
              immediately</b> — the server verifies the completion from its own
              board, so a board that merely looks finished locally is not a win.
            </>
          ),
        },
        {
          heading: "No clock — but don't go idle",
          body: (
            <>
              A match has <b>no time limit</b>: it ends when someone solves the
              deal, concedes, or disconnects. To keep a race from stalling, a seat
              that makes no move for <b>15 minutes</b> is warned, and one that
              stays idle for <b>20 minutes forfeits</b> — the opponent takes the
              win. The clock and the result are the server&apos;s.
            </>
          ),
        },
        {
          heading: "How you play",
          body: (
            <>
              Click a card to pick it up, then click a highlighted pile to place
              it — a run, a single card, or the top of the waste. Click the stock
              to draw, and click the {"\u21bb"} slot to turn an exhausted waste
              back over. A face-down card flips by itself the moment the card
              above it leaves. Every move is validated by the server before it
              counts.
            </>
          ),
        },
        {
          heading: "Simultaneous play — and the server decides",
          body: (
            <>
              Both players play at the same time, each on their own board, and
              neither can see or affect the other&apos;s cards. An{" "}
              <b>invalid move is simply refused and does not count</b> — it can
              never advance your board or your progress. The server owns the
              deal, the clock, the progress and the winner.
            </>
          ),
        },
        {
          heading: "Free ranked play, pure skill",
          body: (
            <>
              Ranked Solitaire is <b>free</b>: there is no stake, no entry fee and
              no pot. A win moves your Solitaire Elo rating and trophies. Practice
              vs the bot is free too. The outcome turns only on how fast and how
              accurately you solve the same puzzle your opponent is looking at.
            </>
          ),
        },
      ],
    }),
    [],
  );

  const nowMs = snapshot?.serverNow ?? Date.now();
  const lobbies = useMemo(
    () =>
      (snapshot?.open ?? []).map((lobby) => ({
        ...lobby,
        waited: waitedFor(lobby.createdAtMs, nowMs),
      })),
    [nowMs, snapshot?.open],
  );

  const queueStatus = (
    <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <p className="text-xs font-black uppercase tracking-[0.16em] text-cyan-200/80">
        Live queue
      </p>
      {!isSignedIn ? (
        <p className="mt-1 text-xs leading-relaxed text-white/45">
          Sign in to join the ranked queue. Practice against the bot works without
          an account.
        </p>
      ) : waitingId ? (
        <p className="mt-1 text-xs leading-relaxed text-cyan-100/80" role="status">
          You are in the live queue, waiting for an opponent to join your table.
        </p>
      ) : lobbies.length > 0 ? (
        <p className="mt-1 text-xs leading-relaxed text-white/50">
          {lobbies.length === 1
            ? "1 open table is waiting for a second player."
            : `${lobbies.length} open tables are waiting for a second player.`}{" "}
          Press play and the matchmaker pairs you with the oldest one.
        </p>
      ) : (
        <p className="mt-1 text-xs leading-relaxed text-white/45">
          No one is waiting right now. Start a search and you hold the next open
          table until another player joins — or practise against the bot instead.
        </p>
      )}
    </div>
  );

  const lobbyProps = {
    title: variant === "page" ? "Solitaire Duel" : undefined,
    subtitle:
      variant === "page"
        ? "A rated 1v1 Solitaire race. Both players receive the exact same Klondike deal and play it simultaneously — solve the whole puzzle first, or lead on progress when the clock runs out."
        : "Ranked Klondike against a real person: one deterministic deal, both seats, first to solve it wins. Or play the same format against one of six named bots, unrated.",
    icon:
      variant === "page" ? (
        <IconCards className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />
      ) : null,
    rules,
    rulesKey: "solitaire-duel",
    busy: rankedBusy,
    onPlay: startRanked,
    playLabel: waitLabelFor(waitingId),
    playBusyLabel: "Searching…",
    canPlay: Boolean(isSignedIn),
    lobbies,
    lobbiesLoading: lobbyLoading,
    lobbyEmptyText:
      "No one is waiting right now — press play to open the next table.",
    lobbyKey: (lobby: OpenLobby) => lobby.matchId,
    lobbyTitle: () => <>Open Solitaire table</>,
    lobbyMeta: (lobby: { waited?: string | null }) =>
      lobby.waited ? `Waiting ${lobby.waited} for a second player` : "Waiting for a second player",
    onJoin: startRanked,
    onRefresh: loadLobby,
    historyHref: isSignedIn ? "/profil" : null,
    myOpenId: waitingId,
    onResume: () => {
      if (waitingId) enterMatch(waitingId);
    },
    onCancel: cancelWaiting,
    cancelling,
    error,
    waitingSubtitle:
      "Pairing you with another player on the same free ranked ladder. Nothing is wagered.",
    // Solitaire never shows the "you've been playing for N minutes" popup:
    // reminding a player of elapsed time here is a nag, not a safeguard.
    sessionReminder: false,
    backHref: "/games/solitaire-duel",
    backLabel: "Solitaire rules",
    extraActions: (
      <Link
        href="/casino/solitaire-duel/play-ai"
        data-testid="solitaire-play-bots"
        className="inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-violet-400/40 bg-violet-400/10 px-5 text-sm font-black uppercase tracking-[0.14em] text-violet-200 transition hover:bg-violet-400/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
      >
        <IconRobot size={16} className="opacity-70" />
        Play vs Bots
      </Link>
    ),
    children: queueStatus,
  };

  if (variant === "page") {
    return <PvpLobbyPage {...lobbyProps} />;
  }

  return <PvpLobby {...lobbyProps} />;
}

/** The ranked button's honest label: it always starts a real search. */
function waitLabelFor(waitingId: string | null) {
  return waitingId ? "Searching for an opponent…" : "Play ranked";
}
