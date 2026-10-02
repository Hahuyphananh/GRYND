"use client";

// src/app/casino/mines-pvp/page.tsx
//
// LOBBY page for the Mines PvP ("Mines Duel") match system. The
// pickTile / end-state / payout logic lives in
// `src/lib/mines-pvp/serverStore.js`; this page is a thin client.
//
// Flow:
//   1. Hit Play (or Quick Queue) → POST /api/mines-pvp/create-or-join
//        • matches an open lobby (server-authoritative)
//        • board generated at match creation
//   2. Redirect to /casino/mines-pvp/[matchId]
//
// Stakes are retired and the mine count is a fixed server constant
// (MINES_PER_MATCH = 10 on the 10×10 board), so the lobby has neither a
// stake picker nor a mine picker. The open-lobbies list is informational
// only — every match has the same board.
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
  MINES_PVP_LOBBY_ROOM,
  MINES_PVP_MATCH_UPDATED,
  minesPvpMatchRoom,
} from "../../../lib/mines-pvp/rooms";
import { MINES_PER_MATCH } from "../../../lib/mines-pvp/constants";
import AiDifficultyPicker from "../../../components/lobby/AiDifficultyPicker";
import { startVisibleInterval } from "../../../hooks/useVisiblePoll";
import {
  type AiDifficulty,
  readStoredAiDifficulty,
} from "../../../lib/aiDifficulty";

// Type for a single open-matches list entry returned by
// /api/mines-pvp/available.
type AvailableMatch = {
  id: number;
  player1Id: string;
  stakeAmount: number;
  minesCount: number;
  createdAt: string;
};

// ── Inline SVG icons (kept in-file so this lobby doesn't pull in
// other game-specific icon sets) ─────────────────────────────────────

function MineIcon({ className = "" }: { className?: string }) {
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
      {/* Round bomb with fuse */}
      <circle cx="12" cy="14" r="7" />
      <path d="M14 7 L17 4" />
      <path d="M16 4 L18 4 L18 6" />
      {/* Spark on the fuse */}
      <circle cx="18" cy="4" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ShieldCheckIcon({ className = "" }: { className?: string }) {
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
      {/* Shield with a check — the no-guess guarantee badge */}
      <path d="M12 2 L20 5 V11 a8 8 0 0 1 -8 8 a8 8 0 0 1 -8 -8 V5 Z" />
      <path d="M8.5 12 l2.5 2.5 l4.5 -4.5" />
    </svg>
  );
}

export default function MinesPvpLobbyPage() {
  const { isSignedIn, user } = useUser();
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();

  // STAKES ARE RETIRED (src/lib/games/stakes.js): a lobby is free to open,
  // so there is no stake to pick and no token balance to load. The mine count
  // is FIXED (10 on the 10×10 board), so there is no mine picker either.
  const stake = 0;
  const minesCount = MINES_PER_MATCH;

  // ── Lobby state ───────────────────────────────────────────────────
  const [availableMatches, setAvailableMatches] = useState<AvailableMatch[]>(
    [],
  );
  const [busy, setBusy] = useState(false);
  // The AI tier the bot picks at, chosen in this lobby and remembered per
  // game by the picker; sent with the create-ai request.
  const [aiDifficulty, setAiDifficulty] = useState<AiDifficulty>(() =>
    readStoredAiDifficulty("mines-pvp"),
  );
  const [joiningId, setJoiningId] = useState<number | null>(null);
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Fetch helpers ────────────────────────────────────────────────
  const fetchAvailable = useCallback(async () => {
    try {
      const res = await fetch("/api/mines-pvp/available", {
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
    // Visibility-gated: a hidden lobby tab stops polling Postgres.
    return startVisibleInterval(fetchAvailable, 3000);
  }, [fetchAvailable]);

  // Derive any lobby the current user owns FROM the availableMatches
  // payload (which carries the player's clerkId as player1Id). This
  // avoids an /api/mines-pvp/my-open-match route just to surface a
  // single banner.
  const myOpenMatch = useMemo<AvailableMatch | null>(() => {
    if (!user?.id) return null;
    return availableMatches.find((m) => m.player1Id === user.id) ?? null;
  }, [availableMatches, user?.id]);

  // Subscribe to lobby room updates. The realtime-server routes
  // `room_event` payloads to the matching socket.io room; the
  // generic event name is `lobby:updated` (mirrors the
  // MINES_PVP_MATCH_UPDATED event used by the match view).
  useEffect(() => {
    if (!socket) return;
    const refresh = () => fetchAvailable();
    socket.emit("join_room", { roomId: MINES_PVP_LOBBY_ROOM });
    socket.on(MINES_PVP_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId: MINES_PVP_LOBBY_ROOM });
      socket.off(MINES_PVP_MATCH_UPDATED, refresh);
    };
  }, [socket, fetchAvailable]);

  // ── Action handlers ──────────────────────────────────────────────

  // Create OR join — server's createOrJoin picks the right path
  // based on whether an open lobby with this stake already exists.
  // When CREATING, minesCount is included; when JOINING, the host's
  // mine count is used (minesCount is ignored by the server in the
  // join path).
  // Play Free vs AI — creates a zero-stake match against the bot.
  const playVsAi = useCallback(
    async (chosenMines: number) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/mines-pvp/create-ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
          minesCount: chosenMines,
          difficulty: aiDifficulty,
        }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Unable to start AI match");
          return;
        }
        router.push(`/casino/mines-pvp/${data.data.match.id}`);
      } finally {
        setBusy(false);
      }
    },
    [router, aiDifficulty],
  );

  const createOrJoin = useCallback(
    async (stakeAmount: number, chosenMines: number) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/mines-pvp/create-or-join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ stakeAmount, minesCount: chosenMines }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Unable to start match");
          return;
        }
        socket?.emit("room_event", {
          roomId: MINES_PVP_LOBBY_ROOM,
          event: MINES_PVP_MATCH_UPDATED,
        });
        const matchId = data?.data?.match?.id;
        if (matchId) {
          socket?.emit("room_event", {
            roomId: minesPvpMatchRoom(matchId),
            event: MINES_PVP_MATCH_UPDATED,
          });
        }
        posthog?.capture("mines_pvp_match_created_or_joined", {
          stake: stakeAmount,
          mines: chosenMines,
          joined: Boolean(data?.data?.joined),
          match_id: data?.data?.match?.id,
        });
        router.push(`/casino/mines-pvp/${data.data.match.id}`);
      } finally {
        setBusy(false);
      }
    },
    [posthog, router, socket],
  );

  // Join a specific lobby from the open-lobbies list. The host's
  // mine count is read from the list payload so the joiner sees what
  // they're agreeing to before they click.
  const joinSpecific = useCallback(
    async (matchId: number) => {
      setJoiningId(matchId);
      setError(null);
      try {
        const target = availableMatches.find((m) => m.id === matchId);
        if (!target) {
          setError("Lobby no longer available.");
          return;
        }
        const res = await fetch("/api/mines-pvp/create-or-join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          // minesCount is IGNORED by the server in the join path
          // (the host's count is locked at lobby creation), but we
          // pass it through for telemetry parity.
          body: JSON.stringify({
            stakeAmount: target.stakeAmount,
            minesCount: target.minesCount,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Unable to join match");
          return;
        }
        socket?.emit("room_event", {
          roomId: MINES_PVP_LOBBY_ROOM,
          event: MINES_PVP_MATCH_UPDATED,
        });
        socket?.emit("room_event", {
          roomId: minesPvpMatchRoom(data.data.match.id),
          event: MINES_PVP_MATCH_UPDATED,
        });
        posthog?.capture("mines_pvp_match_joined", {
          match_id: matchId,
          stake: target.stakeAmount,
          mines: target.minesCount,
        });
        router.push(`/casino/mines-pvp/${data.data.match.id}`);
      } finally {
        setJoiningId(null);
      }
    },
    [availableMatches, posthog, router, socket],
  );

  // Cancel a lobby the current user owns. Only valid while the
  // match is in `waiting` — the server returns 400 otherwise.
  const cancelMyMatch = useCallback(
    async (matchId: number) => {
      setCancellingId(matchId);
      setError(null);
      try {
        const res = await fetch(
          `/api/mines-pvp/match/${matchId}/cancel`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
          },
        );
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data?.error || "Unable to cancel match");
          return;
        }
        socket?.emit("room_event", {
          roomId: MINES_PVP_LOBBY_ROOM,
          event: MINES_PVP_MATCH_UPDATED,
        });
        posthog?.capture("mines_pvp_lobby_cancelled", {
          match_id: matchId,
        });
        // The derived `myOpenMatchId` refreshes once `fetchAvailable`
        // returns, so no local state to clear here.
        fetchAvailable();
      } finally {
        setCancellingId(null);
      }
    },
    [fetchAvailable, socket, posthog],
  );

  // Derived from `myOpenMatch` so it's reactive to the polled lobby list.
  const myOpenMatchId = myOpenMatch?.id ?? null;

  // ── Validation ────────────────────────────────────────────────────
  // Both the stake and the mine count are fixed server-side, so there is
  // nothing for the client to validate before submitting.
  const canCreate = isSignedIn && !busy && myOpenMatchId === null;
  const canPlayAi = isSignedIn && !busy;
  // Stakes are retired and the mine count is fixed — the queue carries
  // neither, so this is just an explanation of what Quick Queue will do.
  const quickQueuePreferences = (
    <div className="mt-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-white/60">
        Quick Queue mines
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-white/45">
        Fixed at <b className="text-cyan-300">{minesCount}</b> on the standard
        10×10 board — Quick Queue drops you into the next free Mines Duel.
      </p>
    </div>
  );

  return (
    <PvpLobbyPage
      quickQueuePreferences={quickQueuePreferences}
      quickQueueReadinessBody={{ preferredGames: ["mines-pvp"], minesStakeAmount: 0, minesCount }}
      title="Mines Duel Lobby"
      subtitle={
        <>
          A 10×10 Minesweeper field with <b>{minesCount} mines</b>. You and
          your opponent take turns on the <b>same board</b> — each turn you
          either reveal one tile (its number tells you how far the nearest
          mine is) <b>or</b> plant one flag, then the turn passes. Reveals and
          their numbers are <b>public</b>; your flags are <b>private</b> — the
          opponent only sees your mine counter drop. Reveal a mine and you
          lose instantly; confirm <b>every</b> mine and you win.
        </>
      }
      icon={
        <MineIcon className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />
      }
      rulesKey="mines-pvp"
      rules={{
        title: "How to Play",
        sections: [
          {
            heading: "10×10, ten mines",
            body: (
              <>
                Both players share the <b>same 10×10 board</b>. It always
                holds <b>{minesCount} mines</b> — one per 10 tiles — and your
                very first reveal can never hit one.
              </>
            ),
          },
          {
            heading: "One action per turn",
            body: (
              <>
                On your turn you either <b>reveal a tile</b> or <b>plant a
                flag</b> — never both. As soon as you act, the turn passes to
                your opponent.
              </>
            ),
          },
          {
            heading: "Shared clues, private flags",
            body: (
              <>
                Every revealed tile is revealed for <b>both</b> of you, and
                its number (how close the nearest mine is) is public. Flags
                are <b>private</b>: when you correctly flag a mine you see
                where it was, your opponent only sees your mine counter drop.
                A wrong flag is rejected and still costs you your turn.
              </>
            ),
          },
          {
            heading: "Winning",
            body: (
              <>
                Reveal a mine and you lose <b>instantly</b>. Confirm
                <b>every</b> mine with your flags and you win instantly —
                watch the side counter race to <b>0</b>.
              </>
            ),
          },
          {
            heading: "The mine counter",
            body: (
              <>
                Two counters sit side by side (yours and your opponent's),
                each starting at {minesCount}. Every mine you confirm ticks
                <b>your</b> number down; the opponent's number stays put
                until they find one of their own.
              </>
            ),
          },
          {
            heading: "Payout",
            body: (
              <>
                Winner takes <b>1.9× their stake</b>, house takes 0.1×.
              </>
            ),
          },
        ],
      }}
      busy={busy}
      onPlay={() => {
        posthog?.capture("mines_pvp_lobby_create_clicked", {
          stake,
          mines: minesCount,
        });
        createOrJoin(stake, minesCount);
      }}
      canPlay={canCreate}
      vsAi={{
        label: "Play Free vs AI",
        onClick: () => playVsAi(minesCount),
        disabled: !canPlayAi,
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
            Mines:{" "}
            <span className="inline-flex items-center gap-1 font-semibold text-cyan-300">
              {m.minesCount}
              <MineIcon className="h-3.5 w-3.5 text-cyan-300" />
            </span>
          </span>
        </span>
      )}
      onJoin={(l) => {
        posthog?.capture("mines_pvp_lobby_join_clicked", {
          match_id: l.id,
          stake: l.stakeAmount,
          mines: l.minesCount,
        });
        joinSpecific(l.id);
      }}
      joinBusyId={joiningId}
      onRefresh={fetchAvailable}
      myOpenId={myOpenMatchId}
      onResume={(id) => router.push(`/casino/mines-pvp/${id}`)}
      onCancel={(id) => cancelMyMatch(id)}
      cancelling={cancellingId === myOpenMatchId}
      children={
        <div className="mt-4">
          {/* AI tier — the bot's pick policy, chosen before the match */}
          <AiDifficultyPicker
            gameKey="mines-pvp"
            value={aiDifficulty}
            onChange={setAiDifficulty}
            className="mt-0"
            hint={{
              easy: "The bot reveals at random, with no board reading at all.",
              normal: "The bot reads the revealed clues and avoids tiles that are likely mines.",
              hard: "The bot deduces every provably-safe tile before it risks anything.",
            }}
          />
        </div>
      }
      after={
        <div className="mt-6 rounded-lg border border-amber-800/30 bg-amber-950/20 p-3 text-xs leading-relaxed text-amber-200/80">
          <p className="mb-1 flex items-center gap-1.5 font-bold text-amber-300">
            <ShieldCheckIcon className="h-4 w-4 text-emerald-300" />
            Standard field.
          </p>
          <p>
            Every match is played on the same 10×10 field with {minesCount}
            mines (one per 10 tiles), so nobody gets a denser or sparser board.
            Your first reveal is always safe, but after that the field is
            yours to read — and your opponent reads the same clues you do.
          </p>
        </div>
      }
    />
  );
}
