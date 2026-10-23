"use client";

// src/app/casino/lane-runner/page.jsx
//
// LOBBY page for "Lane Rush" — the simultaneous-planning oval race.
// The race engine lives in `src/lib/lane-rush/*`; the legacy
// glass-bridge transitions stay in `src/lib/lane-rush-duel/*` for
// historical rows. This page is a thin client.
//
// Flow:
//   1. Pick a stake (preset chips or custom).
//   2. Hit Play → POST /api/lane-rush-duel/create-or-join
//        • matches on stake equality (server-authoritative)
//        • escrow stake on success
//        • every new match is created as a race (state version 1)
//   3. Redirect to /casino/lane-runner/[matchId]
//
// The page chrome (balance strip → stake picker + Play → escrow
// note → Open Lobbies list) is the shared PvpLobby component in the
// blackjack layout / farkle color scheme.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMatchRouter } from "../../../hooks/useMatchRouter";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
import PvpLobbyPage, { CoinIcon } from "../../../components/lobby/PvpLobby";
import { useCoinBalance } from "../../../hooks/useCoinBalance";
import { useSocket } from "../../../context/SocketProvider";
import {
  LANE_RUSH_DUEL_LOBBY_ROOM,
  LANE_RUSH_DUEL_MATCH_UPDATED,
  laneRushDuelMatchRoom,
} from "../../../lib/lane-rush-duel/rooms";
import { DIFFICULTIES } from "../../../lib/lane-rush-duel/constants";
import { MIN_STAKE } from "../../../lib/games/stakes";
import { startVisibleInterval } from "../../../hooks/useVisiblePoll";
import { IconRoute, IconShieldCheck } from "@tabler/icons-react";

export default function LaneRushDuelLobbyPage() {
  const { isSignedIn, user } = useUser();
  const router = useMatchRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();

  // Coin wager: the player picks the stake the lobby is opened at, and the
  // server escrows both seats the moment an opponent joins.
  const coinBalance = useCoinBalance();
  const [stake, setStake] = useState(10);
  const [difficulty, setDifficulty] = useState("easy");

  // ── Lobby state ───────────────────────────────────────────────────
  const [availableMatches, setAvailableMatches] = useState([]);
  // False once the first list response lands, so the empty state never
  // flashes before the request resolves.
  const [lobbiesLoading, setLobbiesLoading] = useState(true);
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
    } finally {
      setLobbiesLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAvailable();
    // Visibility-gated: a hidden lobby tab stops polling Postgres.
    return startVisibleInterval(fetchAvailable, 3000);
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
      // A ranked match always plays for coins: no legal stake, no match.
      if (!(Number(stakeAmount) >= MIN_STAKE)) {
        setError(`Pick a stake of at least ${MIN_STAKE} coin to play.`);
        return;
      }
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
  // bot. Same racing rules, no money: the bot submits an ordinary
  // validated plan and only its route-risk appetite changes with the
  // chosen difficulty.
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
      wager={{ value: stake, onChange: setStake, balance: coinBalance }}
      title="Lane Rush"
      subtitle={
        <>
          You and your opponent plan in secret on the <b>same oval circuit</b>.{" "}
          Each round is a <b>60-second planning window</b> with 2 action
          points: deploy up to four cars to the <b>Safe</b>, <b>Sprint</b> or{" "}
          <b>Risk</b> lane, then buy, merge or repair in the garage. The
          server races both grids at once — a finished car scores tier
          points × the lane multiplier, a DNF scores nothing and leaves the
          car damaged. <b>First to 1,000 points wins</b> — 1.8× your stake,
          house takes 0.2×.
        </>
      }
      icon={
        <IconRoute className="h-9 w-9 flex-shrink-0 text-cyan-300 drop-shadow-[0_0_12px_rgba(34,211,238,0.55)] sm:h-10 sm:w-10" />
      }
      rulesKey="lane-runner"
      rules={{
        title: "How to Play",
        sections: [
          {
            heading: "Plan in secret",
            body: (
              <>
                Every round opens a <b>60-second planning window</b> and
                grants <b>2 action points</b>. Both seats plan at the same
                time, and the opponent&apos;s route choices stay hidden until
                the race resolves. Lock in when you are ready — or the server
                finalizes whatever you had deployed.
              </>
            ),
          },
          {
            heading: "Build the garage",
            body: (
              <>
                You start with <b>two Tier 1 cars</b> and <b>4 Scrap</b>. Buy
                a Tier 1 car for 2 Scrap + 1 AP, merge two undamaged cars of
                the same tier into the next tier for 1 AP, or repair a damaged
                car for 1 Scrap + 1 AP. You can own up to eight cars and race
                up to four.
              </>
            ),
          },
          {
            heading: "Pick a lane",
            body: (
              <>
                <b className="text-emerald-300">Safe</b> pays 1.0× with a 5%
                DNF and +1 Scrap. <b className="text-sky-300">Sprint</b> pays
                1.5× with a 15% DNF and +1 Fuel.{" "}
                <b className="text-rose-300">Risk</b> pays 2.2× with a 30%
                DNF and +1 Tech. A finished car scores its tier base points ×
                the lane multiplier; a DNF scores nothing and comes back
                damaged.
              </>
            ),
          },
          {
            heading: "Win the pot",
            body: (
              <>
                Points are cumulative and the <b>first seat to 1,000</b>
                wins. If both cross it in the same round, the higher total
                wins; an exact tie is a draw and both stakes are refunded.
                The winner takes 1.8× their stake, the house takes 0.2×.
              </>
            ),
          },
          {
            heading: "Server-authoritative",
            body: (
              <>
                The server rolls every race outcome with its own random
                values and applies the round exactly once inside a row-locked
                transaction. The client never decides a DNF, a score or the
                winner — it only replays the round the server confirmed.
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
      canPlay={canCreate && stake >= MIN_STAKE}
      vsAi={{
        label: "Test vs Bot",
        badge: "Free",
        // NOTE: the bot match is created by /api/lane-rush-duel/create-or-join,
        // which still requires an account, so this stays disabled for a
        // signed-out visitor until that route takes the practice gate.
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
      lobbiesLoading={lobbiesLoading}
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
              Bot risk{" "}
              <span className="font-normal normal-case tracking-normal text-cyan-300/70">
                (practice only)
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
              Only the practice bot uses this — it changes how much route
              risk the bot takes. PvP opponents plan for themselves.
            </p>
          </div>
        </div>
      }
      after={
        /* Skill mechanic explainer */
        <div className="mt-6 rounded-lg border border-amber-800/30 bg-amber-950/20 p-3 text-xs leading-relaxed text-amber-200/80">
          <p className="mb-1 flex items-start gap-1.5 font-bold text-amber-300">
            <IconShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-300" />
            Skill race.
          </p>
          <p>
            Every round you spend two <b>action points</b> on the garage and{" "}
            <b>deploy up to four cars</b> to lanes with different risk and
            reward. Merging two cars upgrades a tier, so the biggest totals
            come from planning several rounds ahead. Both grids race at once
            on the server&apos;s rolls, the first seat to <b>1,000 points</b>{" "}
            wins, and a damaged car sits out until you repair it.
          </p>
        </div>
      }
    />
  );
}
