"use client";

// src/app/casino/lane-runner/page.jsx
//
// LOBBY page for the "Lane Rush Duel" match system (the PvP
// replacement for the old solo tower game). The game logic lives in
// `src/lib/lane-rush-duel/*`; this page is a thin client.
//
// Flow:
//   1. Pick a stake (preset chips or custom).
//   2. Pick a difficulty (host-only — the joiner inherits whatever
//      the host chose when they created the lobby).
//   3. Hit Play → POST /api/lane-rush-duel/create-or-join
//        • matches on stake equality (server-authoritative)
//        • escrow stake on success
//        • provably-fair towers generated at match creation
//   4. Redirect to /casino/lane-runner/[matchId]
//
// The page chrome (balance strip → stake picker + Play → escrow
// note → Open Lobbies list) is the shared PvpLobby component in the
// blackjack layout / farkle color scheme.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
import PvpLobbyPage, { CoinIcon } from "../../../components/lobby/PvpLobby";
import { useSocket } from "../../../context/SocketProvider";
import {
  LANE_RUSH_DUEL_LOBBY_ROOM,
  LANE_RUSH_DUEL_MATCH_UPDATED,
  laneRushDuelMatchRoom,
} from "../../../lib/lane-rush-duel/rooms";
import { DIFFICULTIES } from "../../../lib/lane-rush-duel/constants";
import { IconShieldCheck } from "@tabler/icons-react";

function TowerIcon({ className = "" }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M5 3 L8 21" />
      <path d="M19 3 L16 21" />
      <path d="M5 3 H19" />
      <path d="M8 21 H16" />
      <path d="M8 9 H16" />
      <path d="M7.5 15 H16.5" />
    </svg>
  );
}

export default function LaneRushDuelLobbyPage() {
  const { isSignedIn, user } = useUser();
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();

  // STAKES ARE RETIRED (src/lib/games/stakes.js): a lobby is free to open,
  // so there is no stake to pick and no token balance to load.
  const stake = 0;
  const [difficulty, setDifficulty] = useState("easy");

  // ── Lobby state ───────────────────────────────────────────────────
  const [availableMatches, setAvailableMatches] = useState([]);
  const [busy, setBusy] = useState(false);
  const [joiningId, setJoiningId] = useState(null);
  const [cancellingId, setCancellingId] = useState(null);
  const [error, setError] = useState(null);

  // ── Fetch helpers ────────────────────────────────────────────────
  const fetchAvailable = useCallback(async () => {
    try {
      const res = await fetch("/api/lane-rush-duel/available", {
        cache: "no-store",
      });
      const data = await res.json();
      if (data?.success) {
        setAvailableMatches(data.data.matches || []);
      }
    } catch {
      // Silent — polling retries on the next tick.
    }
  }, []);

  useEffect(() => {
    fetchAvailable();
    const interval = setInterval(() => {
      fetchAvailable();
    }, 3000);
    return () => clearInterval(interval);
  }, [fetchAvailable]);

  // Any lobby the current user owns, derived from the polled list.
  const myOpenMatch = useMemo(() => {
    if (!user?.id) return null;
    return availableMatches.find((m) => m.player1Id === user.id) ?? null;
  }, [availableMatches, user?.id]);
  const myOpenMatchId = myOpenMatch?.id ?? null;

  // Subscribe to lobby room updates.
  useEffect(() => {
    if (!socket) return;
    const refresh = () => fetchAvailable();
    socket.emit("join_room", { roomId: LANE_RUSH_DUEL_LOBBY_ROOM });
    socket.on(LANE_RUSH_DUEL_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId: LANE_RUSH_DUEL_LOBBY_ROOM });
      socket.off(LANE_RUSH_DUEL_MATCH_UPDATED, refresh);
    };
  }, [socket, fetchAvailable]);

  // ── Action handlers ──────────────────────────────────────────────

  const createOrJoin = useCallback(
    async (stakeAmount, chosenDifficulty) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/lane-rush-duel/create-or-join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            stakeAmount,
            difficulty: chosenDifficulty,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Unable to start match");
          return;
        }
        socket?.emit("room_event", {
          roomId: LANE_RUSH_DUEL_LOBBY_ROOM,
          event: LANE_RUSH_DUEL_MATCH_UPDATED,
        });
        const matchId = data?.data?.match?.id;
        if (matchId) {
          socket?.emit("room_event", {
            roomId: laneRushDuelMatchRoom(matchId),
            event: LANE_RUSH_DUEL_MATCH_UPDATED,
          });
        }
        posthog?.capture("lane_rush_duel_created_or_joined", {
          stake: stakeAmount,
          difficulty: chosenDifficulty,
          joined: Boolean(data?.data?.joined),
          match_id: matchId,
        });
        router.push(`/casino/lane-runner/${matchId}`);
      } finally {
        setBusy(false);
      }
    },
    [posthog, router, socket],
  );

  // Test vs Bot — zero-stake practice match against the server-side
  // bot. Same rules, no money: the bot crosses the same shared bridge,
  // avoiding tiles it has watched break (and spending its flags on hard).
  const createBotMatch = useCallback(
    async (chosenDifficulty) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/lane-rush-duel/create-or-join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            stakeAmount: 0,
            difficulty: chosenDifficulty,
            vsBot: true,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Unable to start practice match");
          return;
        }
        const matchId = data?.data?.match?.id;
        if (matchId) {
          socket?.emit("room_event", {
            roomId: laneRushDuelMatchRoom(matchId),
            event: LANE_RUSH_DUEL_MATCH_UPDATED,
          });
        }
        posthog?.capture("lane_rush_duel_vs_bot_started", {
          difficulty: chosenDifficulty,
          match_id: matchId,
        });
        router.push(`/casino/lane-runner/${matchId}`);
      } finally {
        setBusy(false);
      }
    },
    [posthog, router, socket],
  );

  const joinSpecific = useCallback(
    async (matchId) => {
      setJoiningId(matchId);
      setError(null);
      try {
        const target = availableMatches.find((m) => m.id === matchId);
        if (!target) {
          setError("Lobby no longer available.");
          return;
        }
        const res = await fetch("/api/lane-rush-duel/create-or-join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          // difficulty is IGNORED by the server in the join path (the
          // host's is locked at lobby creation), passed for telemetry.
          body: JSON.stringify({
            stakeAmount: target.stakeAmount,
            difficulty: target.difficulty,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Unable to join match");
          return;
        }
        socket?.emit("room_event", {
          roomId: LANE_RUSH_DUEL_LOBBY_ROOM,
          event: LANE_RUSH_DUEL_MATCH_UPDATED,
        });
        socket?.emit("room_event", {
          roomId: laneRushDuelMatchRoom(data.data.match.id),
          event: LANE_RUSH_DUEL_MATCH_UPDATED,
        });
        posthog?.capture("lane_rush_duel_joined", {
          match_id: matchId,
          stake: target.stakeAmount,
          difficulty: target.difficulty,
        });
        router.push(`/casino/lane-runner/${data.data.match.id}`);
      } finally {
        setJoiningId(null);
      }
    },
    [availableMatches, posthog, router, socket],
  );

  const cancelMyMatch = useCallback(
    async (matchId) => {
      setCancellingId(matchId);
      setError(null);
      try {
        const res = await fetch(`/api/lane-rush-duel/match/${matchId}/cancel`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Unable to cancel match");
          return;
        }
        socket?.emit("room_event", {
          roomId: LANE_RUSH_DUEL_LOBBY_ROOM,
          event: LANE_RUSH_DUEL_MATCH_UPDATED,
        });
        posthog?.capture("lane_rush_duel_lobby_cancelled", { match_id: matchId });
        fetchAvailable();
      } finally {
        setCancellingId(null);
      }
    },
    [fetchAvailable, socket, posthog],
  );

  const difficultyValid = Boolean(DIFFICULTIES[difficulty]);
  const canCreate =
    isSignedIn && !busy && difficultyValid && myOpenMatchId === null;

  return (
    <PvpLobbyPage
      title="Lane Rush Duel"
      subtitle={
        <>
          You and your opponent cross the <b>same glass bridge</b> — one
          provably-fair layout, <b>10 rows with exactly one bad tile
          each</b>. On your turn pick a tile on your row: a{" "}
          <b className="text-emerald-300">safe</b> tile carries you on and
          you pick again, a <b className="text-rose-300">bad</b> one breaks
          that tile for good and sends you back to row 1. Mark tiles you
          have landed on with <b className="text-amber-300">memory flags</b>{" "}
          (2 each, both players see them). You get 15 seconds per choice.{" "}
          <b>First across row 10 wins</b> — 1.9× your stake, house takes
          0.1×.
        </>
      }
      icon={
        <TowerIcon className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />
      }
      rulesKey="lane-runner"
      rules={{
        title: "How to Play",
        sections: [
          {
            heading: "Cross the same bridge",
            body: (
              <>
                Both players cross the <b>same bridge</b> — one
                provably-fair layout, same difficulty. It has{" "}
                <b>10 rows</b> and <b>exactly one bad tile per row</b>.
                Whoever crosses row 10 first wins.
              </>
            ),
          },
          {
            heading: "Pick your tile",
            body: (
              <>
                On your turn you pick a tile on the row you are standing
                on, with <b>15 seconds</b> to decide. A{" "}
                <b className="text-emerald-300">safe</b> tile carries you
                one row further and it stays your turn — you pick again
                with a fresh 15 seconds. A{" "}
                <b className="text-rose-300">bad</b> tile ends your
                attempt: it <b>stays broken</b> for the rest of the match
                and you start again from row 1. Let the clock run out and
                your attempt ends the same way.
              </>
            ),
          },
          {
            heading: "Remember with flags",
            body: (
              <>
                Each match gives you <b>2 memory flags</b>. You can flag
                only a tile you <b>personally landed on safely</b>, and
                flags are <b>public</b> — both players see them. A flag
                can never be moved or removed. Placing one costs you
                nothing and never ends your turn.
              </>
            ),
          },
          {
            heading: "Win the pot",
            body: (
              <>
                The first player to <b>cross row 10 wins</b> the match
                instantly. 1.9× your stake, house takes 0.1×.
              </>
            ),
          },
          {
            heading: "Provably fair",
            body: (
              <>
                Every row hides one bad tile. The bridge derives from
                one shared server seed (hash shown before the match) +
                the host&apos;s client seed, both revealed after.
              </>
            ),
          },
        ],
      }}
      busy={busy}
      onPlay={() => {
        posthog?.capture("lane_rush_duel_create_clicked", {
          stake,
          difficulty,
        });
        createOrJoin(stake, difficulty);
      }}
      canPlay={canCreate}
      vsAi={{
        label: "Test vs Bot",
        badge: "Free",
        disabled: !isSignedIn,
        busy,
        onClick: () => {
          posthog?.capture("lane_rush_duel_vs_bot_clicked", {
            difficulty,
          });
          createBotMatch(difficulty);
        },
      }}
      error={error}
      lobbies={availableMatches}
      lobbyEmptyText="No open lobbies yet. Be the first to make one."
      lobbyTitle={(m) => (
        <>
          Lobby #{m.id}
          <span className="ml-2 text-[10px] text-white/40">
            host #{m.player1Id?.slice(0, 6) ?? "?"}…
          </span>
        </>
      )}
      lobbyMeta={(m) => (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            Stake:{" "}
            <span className="inline-flex items-center gap-1 font-semibold text-yellow-300">
              {Number(m.stakeAmount).toLocaleString()}
              <CoinIcon className="h-3.5 w-3.5 text-yellow-300" />
            </span>
          </span>
          <span>
            Difficulty:{" "}
            <span className="font-semibold text-cyan-300">
              {DIFFICULTIES[m.difficulty]?.label || m.difficulty}
            </span>
          </span>
        </span>
      )}
      onJoin={(l) => {
        posthog?.capture("lane_rush_duel_join_clicked", {
          match_id: l.id,
          stake: l.stakeAmount,
          difficulty: l.difficulty,
        });
        joinSpecific(l.id);
      }}
      joinBusyId={joiningId}
      onRefresh={fetchAvailable}
      historyHref="/casino/lane-runner/history"
      myOpenId={myOpenMatchId}
      onResume={(id) => router.push(`/casino/lane-runner/${id}`)}
      onCancel={(id) => cancelMyMatch(id)}
      cancelling={cancellingId === myOpenMatchId}
      children={
        <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
          {/* Difficulty picker — host-only at create time */}
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-white/60">
              Difficulty{" "}
              <span className="font-normal normal-case tracking-normal text-cyan-300/70">
                (host)
              </span>
            </label>
            <div className="mt-1 flex flex-wrap gap-1">
              {Object.entries(DIFFICULTIES).map(([key, config]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setDifficulty(key)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition ${
                    difficulty === key
                      ? "border-cyan-400 bg-cyan-500/20 text-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.5)]"
                      : "border-gray-600 bg-gray-800/50 text-gray-400 hover:border-cyan-600/50 hover:text-cyan-200"
                  }`}
                >
                  {config.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[9px] leading-tight text-white/40">
              {DIFFICULTIES[difficulty]?.width} tiles per row · 10 rows,
              one bad tile each · 2 memory flags each. Joiners inherit.
            </p>
          </div>
        </div>
      }
      after={
        /* Skill mechanic explainer */
        <div className="mt-6 rounded-lg border border-amber-800/30 bg-amber-950/20 p-3 text-xs leading-relaxed text-amber-200/80">
          <p className="mb-1 flex items-start gap-1.5 font-bold text-amber-300">
            <IconShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-300" />
            Skill duel.
          </p>
          <p>
            You and your rival cross the {" "}
            <b>same 10-row bridge</b>, one bad tile hidden in every
            row. A safe tile keeps your turn; a bad tile breaks for
            good and sends you back to Row 1. Spend your two{" "}
            <b>memory flags</b> to remember the tiles you survived.
            First to cross row 10 wins. The bridge is{" "}
            <b>provably fair</b>: both players derive it from one
            shared server seed (hash shown before the match) + the
            match's client seed, revealed after.
          </p>
        </div>
      }
    />
  );
}
