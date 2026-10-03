"use client";

// src/app/casino/tic-tac-toe/PageClient.tsx
//
// Tic-Tac-Toe Duel lobby. Reuses the shared casino lobby chrome
// (`PvpLobbyPage`) — the same component every other 1v1 game mounts — and wires
// it to the Tic-Tac-Toe matchmaking endpoints:
//
//   POST /api/tic-tac-toe/create-or-join     — match into the oldest open
//                                              lobby, or open a new one
//   GET  /api/tic-tac-toe/available          — open lobbies (cheap poll)
//   POST /api/tic-tac-toe/match/<id>/cancel  — close the caller's own lobby
//
// Entry is free (stakes are retired platform-wide) and Tic-Tac-Toe is unstaked,
// so there is no wager picker, no balance and no escrow note — and no
// difficulty picker, because the game has no bot, no timers and no randomness.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { usePostHog } from "posthog-js/react";
import { IconTicTac } from "@tabler/icons-react";
import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import AiDifficultyPicker from "../../../components/lobby/AiDifficultyPicker";
import {
  type AiDifficulty,
  readStoredAiDifficulty,
} from "../../../lib/aiDifficulty";
import { useSocket } from "../../../context/SocketProvider";
import { startVisibleInterval } from "../../../hooks/useVisiblePoll";
import {
  TIC_TAC_TOE_LOBBY_ROOM,
  TIC_TAC_TOE_MATCH_UPDATED,
} from "../../../lib/tic-tac-toe/rooms";

const POLL_MS = 3000;

type LobbyRow = {
  matchId: string;
  player1Id: string;
  status: string;
  createdAt?: string;
};

export default function TicTacToeLobbyPage() {
  const { isSignedIn, user } = useUser();
  const { socket } = useSocket();
  const router = useRouter();
  const posthog = usePostHog();

  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lobbies, setLobbies] = useState<LobbyRow[]>([]);
  // False once the first list response lands, so the empty state never
  // flashes before the request resolves.
  const [lobbiesLoading, setLobbiesLoading] = useState(true);
  // The tier the practice bot plays at, remembered per game by the picker.
  const [aiDifficulty, setAiDifficulty] = useState<AiDifficulty>(() =>
    readStoredAiDifficulty("tic-tac-toe"),
  );

  const fetchLobbies = useCallback(async () => {
    try {
      const res = await fetch("/api/tic-tac-toe/available", { cache: "no-store" });
      const data = await res.json();
      if (data?.success) setLobbies(Array.isArray(data.data) ? data.data : []);
    } catch {
      // silent — the poll retries
    } finally {
      setLobbiesLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLobbies();
    // Visibility-gated: a hidden lobby tab stops polling Postgres, and coming
    // back to it refreshes immediately instead of waiting out the interval.
    return startVisibleInterval(fetchLobbies, POLL_MS);
  }, [fetchLobbies, isSignedIn, user?.id]);

  // Near-instant lobby refresh: the shared `lobby:tic-tac-toe` room carries the
  // generic `lobby:updated` relay, exactly like the other PvP lobbies.
  useEffect(() => {
    if (!socket) return undefined;
    const refresh = () => fetchLobbies();
    socket.emit("join_room", { roomId: TIC_TAC_TOE_LOBBY_ROOM });
    socket.on(TIC_TAC_TOE_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId: TIC_TAC_TOE_LOBBY_ROOM });
      socket.off(TIC_TAC_TOE_MATCH_UPDATED, refresh);
    };
  }, [socket, fetchLobbies]);

  const myOpenId = useMemo(() => {
    if (!user?.id) return null;
    return lobbies.find((row) => row.player1Id === user.id)?.matchId ?? null;
  }, [lobbies, user?.id]);

  const pokeLobby = useCallback(() => {
    socket?.emit("room_event", {
      roomId: TIC_TAC_TOE_LOBBY_ROOM,
      event: TIC_TAC_TOE_MATCH_UPDATED,
    });
  }, [socket]);

  const createOrJoin = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/tic-tac-toe/create-or-join", {
        method: "POST",
        // The proxy rejects POSTs without a JSON content-type (415), even
        // bodyless ones — declare it so matchmaking reaches the route.
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(data?.error || "Unable to find a match");
        return;
      }
      pokeLobby();
      posthog?.capture("tic_tac_toe_match_started", {
        mode: data.data?.joined ? "join" : "create",
      });
      router.push(`/casino/tic-tac-toe/${data.data.matchId}`);
    } catch {
      setError("Unable to find a match");
    } finally {
      setBusy(false);
    }
  }, [busy, pokeLobby, posthog, router]);

  const playAi = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/tic-tac-toe/create-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ difficulty: aiDifficulty }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(data?.error || "Unable to start the practice match");
        return;
      }
      posthog?.capture("tic_tac_toe_match_started", { mode: "ai" });
      router.push(`/casino/tic-tac-toe/${data.data.matchId}`);
    } catch {
      setError("Unable to start the practice match");
    } finally {
      setBusy(false);
    }
  }, [aiDifficulty, posthog, router]);

  const cancelLobby = useCallback(
    async (matchId: string) => {
      if (cancelling) return;
      setCancelling(true);
      try {
        await fetch(`/api/tic-tac-toe/match/${matchId}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        pokeLobby();
        await fetchLobbies();
      } finally {
        setCancelling(false);
      }
    },
    [cancelling, pokeLobby, fetchLobbies],
  );

  // Rules copy. Tic-Tac-Toe is turn-based with no timers, no abilities and no
  // randomness, so the four sections stay to the three things a new player
  // actually has to know: whose mark is whose, how a turn works, and what wins.
  const rules = useMemo(
    () => ({
      title: "How to Play Tic-Tac-Toe",
      sections: [
        {
          heading: "Three in a row wins",
          body: (
            <>
              You take turns filling one cell of a <b>3×3 board</b>. The first
              player to line up <b>three of their mark</b> — a row, a column or a
              diagonal — takes the match immediately. If all nine cells fill and
              nobody has a line, the match is a <b>draw</b>.
            </>
          ),
        },
        {
          heading: "X moves first",
          body: (
            <>
              The player who opened the lobby holds <b>X</b> and plays the first
              move; the opponent holds <b>O</b>. Whose turn it is is decided by
              the server, not by the board you can see, so a stale tab can never
              play out of turn.
            </>
          ),
        },
        {
          heading: "One click per turn",
          body: (
            <>
              Click any <b>empty cell</b> on your turn — the board submits it and
              shows it the moment the server accepts. Clicking an occupied cell,
              or a cell that is not yours to play, does nothing. There are no
              timers, no power-ups and no luck: nothing is drawn or rolled, ever.
            </>
          ),
        },
        {
          heading: "Rated 1v1",
          body: (
            <>
              Every completed match feeds the platform&apos;s shared per-game
              rating and trophy system, exactly like the other ranked duels. A
              draw moves both ratings by the same half-point and awards nobody a
              win. There are <b>no wagers, no tokens and no payouts</b>.
            </>
          ),
        },
      ],
    }),
    [],
  );

  return (
    <PvpLobbyPage
      title="Tic-Tac-Toe"
      subtitle="A free, rated 1v1 duel on a 3×3 board. X moves first, play is turn by turn, and the first player to line up three in a row takes the match."
      icon={<IconTicTac className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />}
      rulesKey="tic-tac-toe"
      rules={rules}
      waitingSubtitle="Pairing you with another Tic-Tac-Toe player…"
      busy={busy}
      onPlay={createOrJoin}
      playLabel="Find a Match"
      playBusyLabel="Searching…"
      canPlay={Boolean(isSignedIn)}
      children={
        <AiDifficultyPicker
          gameKey="tic-tac-toe"
          value={aiDifficulty}
          onChange={setAiDifficulty}
          hint={{
            easy: "The bot plays a random empty cell and never blocks or wins on purpose.",
            normal: "The bot plays to win, but slips occasionally — it is beatable.",
            hard: "A perfect opponent: it never loses and forces a draw at worst.",
          }}
        />
      }
      extraActions={
        <button
          type="button"
          onClick={playAi}
          disabled={busy}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-cyan-400/40 bg-cyan-400/10 py-2 text-sm font-bold text-cyan-200 transition hover:bg-cyan-400/20 disabled:opacity-50"
        >
          Play Free vs AI
        </button>
      }
      myOpenId={myOpenId}
      onResume={(id: string) => router.push(`/casino/tic-tac-toe/${id}`)}
      onCancel={cancelLobby}
      cancelling={cancelling}
      lobbies={lobbies}
      lobbiesLoading={lobbiesLoading}
      lobbyEmptyText="No open Tic-Tac-Toe lobbies right now. Create one and an opponent will be matched in."
      lobbyKey={(row: LobbyRow) => row.matchId}
      lobbyTitle={(row: LobbyRow) => <>Table #{String(row.matchId).slice(0, 8)}</>}
      lobbyMeta={(row: LobbyRow) => (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>Host: {String(row.player1Id).slice(0, 12)}…</span>
          <span>3×3 · three in a row</span>
          <span className="text-emerald-300">Free ranked</span>
        </span>
      )}
      onJoin={() => createOrJoin()}
      joinLabel="Join"
      onRefresh={fetchLobbies}
      error={error}
    />
  );
}
