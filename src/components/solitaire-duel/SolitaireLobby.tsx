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
//   queue    GET  /api/solitaire-duel/lobby — open lobbies + my waiting lobby,
//            polled so the panel reports the actual queue instead of a number
//            someone typed.
//   resume   the match page for the caller's own waiting lobby.
//   cancel   POST /api/solitaire-duel/match/<id>/cancel.
//
// There is no simulated queue, no invented opponent and no silent fallback: a
// ranked search that finds nobody leaves the caller waiting, with the real
// state on screen and the decision (wait or cancel) theirs. Bot matches live
// in the separate Play vs AI lobby at /play/ai.

import { useCallback, useEffect, useMemo, useState } from "react";

import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { IconCards } from "@tabler/icons-react";

import PvpLobbyPage, { PvpLobby } from "../lobby/PvpLobby";
import FriendChallengePanel from "./FriendChallengePanel";
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
  // Set once the server refuses a second guest race, so the lobby can offer the
  // sign-in path instead of repeating a button that cannot work.
  const [guestTrialUsed, setGuestTrialUsed] = useState(false);

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

  /**
   * The guest trial: one race against a recorded human run, no account.
   *
   * Deliberately NOT the ranked queue. A guest has no rating row, and an open
   * lobby is visible to real players, so the server mints a match that is
   * already playing against a ghost seat — the guest feels the race without
   * ever entering the ladder.
   */
  const startGuestRace = useCallback(async () => {
    if (rankedBusy) return;
    setRankedBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/solitaire-duel/guest-race", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        if (data?.reason === "guest_trial_used") {
          setGuestTrialUsed(true);
          setError("You've used your free race — sign in to keep racing.");
          return;
        }
        setError(data?.error || "Unable to start the race");
        return;
      }
      enterMatch(String(data.data.matchId));
    } catch {
      setError("Unable to start the race");
    } finally {
      setRankedBusy(false);
    }
  }, [enterMatch, rankedBusy]);

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
              no pot. A win moves your Solitaire Elo rating and trophies. Ranked
              only ever matches <b>real human players</b>. If nobody is live
              within a few seconds you race a <b>ghost</b>: the recorded,
              real-time run of another player who played this exact deal,
              replayed move for move at their own pace. A ghost is a recording of
              a person, <b>never an AI</b> — no bot is ever substituted. The
              outcome turns only on how fast and how accurately you solve the
              same puzzle your opponent is looking at.
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
        <div className="mt-1 text-xs leading-relaxed text-white/45">
          <p>
            Try <b className="text-white/70">one free race</b>: the same
            deterministic deal, against another player&apos;s recorded run of it.
            Nothing is rated and nothing is saved — sign in to join the live
            ranked queue afterwards.
          </p>
          {guestTrialUsed ? (
            <Link
              href="/sign-in?redirect_url=/play/ranked"
              className="mt-2 inline-block font-extrabold text-[#00e5ff] underline-offset-4 hover:underline"
              data-testid="guest-trial-sign-in"
            >
              Sign in to keep racing →
            </Link>
          ) : null}
        </div>
      ) : waitingId ? (
        <p className="mt-1 text-xs leading-relaxed text-cyan-100/80" role="status">
          You are in the live queue. If no live player joins within a few
          seconds, you will race a recorded run by another real player on the
          same deal — never a bot.
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
          No one is waiting right now. Start a search: if no live player joins
          within a few seconds, you race a recorded run by another real player
          on the same deal — never a bot.
        </p>
      )}
    </div>
  );

  const lobbyProps = {
    title: variant === "page" ? "Solitaire Duel" : undefined,
    subtitle:
      variant === "page"
        ? "A rated 1v1 Solitaire race. Both players receive the exact same Klondike deal and play it simultaneously — solve the whole puzzle first, or lead on progress when the clock runs out."
        : "Ranked Klondike against a real person: one deterministic deal, both seats, first to solve it wins. Ranked never substitutes an AI — if nobody is live within a few seconds, you race another real player's recorded run of the same deal.",
    icon:
      variant === "page" ? (
        <IconCards className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />
      ) : null,
    rules,
    rulesKey: "solitaire-duel",
    busy: rankedBusy,
    // A guest gets the one-race trial; an account gets the real queue.
    onPlay: isSignedIn ? startRanked : startGuestRace,
    playLabel: isSignedIn ? waitLabelFor(waitingId) : "Play one free race",
    playBusyLabel: isSignedIn ? "Searching…" : "Starting…",
    canPlay: true,
    // Open tables are a signed-in surface: a guest must never be seated next to
    // a real player, so the list is empty for them instead of misleading.
    lobbies: isSignedIn ? lobbies : [],
    lobbiesLoading: isSignedIn ? lobbyLoading : false,
    lobbyEmptyText: isSignedIn
      ? "No one is waiting right now — press play to open the next table."
      : "Live tables are for signed-in players — your free race starts right away.",
    lobbyKey: (lobby: OpenLobby) => lobby.matchId,
    lobbyTitle: () => <>Open Solitaire table</>,
    lobbyMeta: (lobby: { waited?: string | null }) =>
      lobby.waited ? `Waiting ${lobby.waited} for a second player` : "Waiting for a second player",
    onJoin: isSignedIn ? startRanked : startGuestRace,
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
      "Pairing you with a live player on the same free ranked ladder — or, within a few seconds, with a real player's recorded run of the same deal. Nothing is wagered.",
    // Solitaire never shows the "you've been playing for N minutes" popup:
    // reminding a player of elapsed time here is a nag, not a safeguard.
    sessionReminder: false,
    backHref: "/games/solitaire-duel",
    backLabel: "Solitaire rules",
    /**
     * Ranked is humans only. The AI picker remains a first-class mode through
     * /play/ai and /casino/solitaire-duel/play-ai; it is deliberately not a
     * shortcut inside the ranked lobby, so a search can never look like it
     * might substitute a bot.
     */
    children: (
      <>
        {queueStatus}
        {/* Ranked is one way to find an opponent; a private link is the other.
            The panel mints a lobby the public queue can never join. */}
        <FriendChallengePanel />
      </>
    ),
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
