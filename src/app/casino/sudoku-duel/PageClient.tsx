"use client";

// src/app/casino/sudoku-duel/PageClient.tsx
//
// Sudoku Duel lobby.
//
// The page reuses the shared casino lobby chrome (`PvpLobbyPage`) — the same
// component every other 1v1 game mounts — so its rules modal, navigation bar,
// footer and Quick Queue panel are the EXISTING ones, not a new lobby system.
//
// One entry point: POST /api/sudoku-duel/create-or-join, which is the store's own
// `createOrJoin` (per-game advisory lock + FOR UPDATE) either joining the oldest
// open lobby or opening one. The server mints the seed and derives the single
// shared puzzle at row creation, so the lobby has nothing to decide about the
// puzzle and there is no difficulty picker here — the match's difficulty is part
// of the puzzle the server already generated.
//
// The Open Lobbies card mirrors the other PvP lobbies exactly: it polls
// GET /api/sudoku-duel/available (a deliberately narrow list — id, difficulty,
// clues and age, never a puzzle, a solution or a player id) and joins the shared
// `lobby:sudoku-duel` room, which carries the generic `lobby:updated` relay so a
// newly opened / closed lobby appears without waiting for the next poll.
//
// Where a pairing lands: `./[matchId]/PageClient` — the race itself. It waits for
// the opponent, counts down from the server's absolute GO instant, renders the
// server's single board, streams the server-derived opponent progress and hands
// off to the shared `PvpResultScreen` with the SNAPSHOT's verdict. Nothing on
// either screen decides a result.
//
// Sudoku Duel is unstaked — the platform retired stakes — so there is no wager
// picker, no balance and no escrow note anywhere on this screen.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { IconGridDots } from "@tabler/icons-react";
import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import AiDifficultyPicker from "../../../components/lobby/AiDifficultyPicker";
import {
  type AiDifficulty,
  readStoredAiDifficulty,
} from "../../../lib/aiDifficulty";
import { useSocket } from "../../../context/SocketProvider";
import {
  SUDOKU_DUEL_EVENTS,
  SUDOKU_DUEL_LOBBY_ROOM,
} from "../../../lib/sudoku-duel/rooms";
import { difficultyLabel, givensLabel } from "../../../lib/sudoku-duel/ui";
import { useSocketAwarePoll } from "../../../hooks/useVisiblePoll";

/**
 * One row of the narrow `/api/sudoku-duel/available` payload.
 *
 * Deliberately no `player1Id`: an open lobby is visible to anyone, so the list
 * exposes nothing that could identify (or be used to target) its host.
 */
type LobbyRow = {
  matchId: string;
  variant?: string;
  difficulty?: string;
  givens?: number;
  status?: string;
  createdAt?: string;
};

export default function SudokuDuelLobbyPage() {
  const { isSignedIn } = useUser();
  const { socket } = useSocket();
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lobbies, setLobbies] = useState<LobbyRow[]>([]);
  // False once the first list response lands, so the empty state never
  // flashes before the request resolves.
  const [lobbiesLoading, setLobbiesLoading] = useState(true);
  const [aiDifficulty, setAiDifficulty] = useState<AiDifficulty>(() =>
    readStoredAiDifficulty("sudoku-duel"),
  );

  const fetchLobbies = useCallback(async () => {
    try {
      const res = await fetch("/api/sudoku-duel/available", { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (data?.success) setLobbies(Array.isArray(data.data) ? data.data : []);
    } catch {
      // silent — the poll retries
    } finally {
      setLobbiesLoading(false);
    }
  }, []);

  // The shared `lobby:sudoku-duel` room already pushes an instant refresh, so
  // the HTTP poll is only a backstop: one read on mount, then the socket-aware,
  // visibility-gated cadence (30s healthy / 5s if the socket drops) instead of
  // a flat 3s cadence hammering Postgres from an idle lobby tab.
  useSocketAwarePoll(() => void fetchLobbies(), socket, Boolean(isSignedIn));

  // Near-instant lobby refresh: the shared `lobby:sudoku-duel` room carries the
  // generic `lobby:updated` relay, exactly like the other PvP lobbies.
  useEffect(() => {
    if (!socket) return undefined;
    const refresh = () => void fetchLobbies();
    socket.emit("join_room", { roomId: SUDOKU_DUEL_LOBBY_ROOM });
    socket.on(SUDOKU_DUEL_EVENTS.MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId: SUDOKU_DUEL_LOBBY_ROOM });
      socket.off(SUDOKU_DUEL_EVENTS.MATCH_UPDATED, refresh);
    };
  }, [socket, fetchLobbies]);

  // Tell the other lobby browsers something changed. The realtime server relays
  // this bare hint to the room; the list is re-fetched from the authoritative
  // `/available` route, so nothing a client sends is ever trusted as state.
  const pokeLobby = useCallback(() => {
    socket?.emit("room_event", {
      roomId: SUDOKU_DUEL_LOBBY_ROOM,
      event: SUDOKU_DUEL_EVENTS.MATCH_UPDATED,
    });
  }, [socket]);

  const createOrJoin = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sudoku-duel/create-or-join", {
        method: "POST",
        // The proxy rejects POSTs without a JSON content-type (415), even
        // bodyless ones — declare it so matchmaking reaches the route.
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(data?.error || "Unable to find a match");
        return;
      }
      pokeLobby();
      router.push(`/casino/sudoku-duel/${data.data.matchId}`);
    } catch {
      setError("Unable to find a match");
    } finally {
      setBusy(false);
    }
  }, [busy, pokeLobby, router]);

  const playAi = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sudoku-duel/create-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ difficulty: aiDifficulty }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(data?.error || "Unable to start the practice match");
        return;
      }
      router.push(`/casino/sudoku-duel/${data.data.matchId}`);
    } catch {
      setError("Unable to start the practice match");
    } finally {
      setBusy(false);
    }
  }, [aiDifficulty, busy, router]);

  const rules = useMemo(
    () => ({
      title: "How to Play Sudoku Duel",
      sections: [
        {
          heading: "One puzzle, two players, same board",
          body: (
            <>
              The server generates <b>one deterministic 9x9 Sudoku</b> and hands
              the <b>exact same clues</b> to both players. You solve your own
              copy — you cannot see, touch or interfere with your opponent&apos;s
              board, and neither of you can see the solution.
            </>
          ),
        },
        {
          heading: "First to solve it wins",
          body: (
            <>
              Fill every row, column and 3x3 box with 1-9. The{" "}
              <b>first player to complete the puzzle correctly wins
              immediately</b> — the server verifies the completion against its own
              board, so a board that merely looks finished locally is not a win.
              Every mistake adds a <b>one-second penalty</b> to your finish time,
              which is recorded and shown on the result screen.
            </>
          ),
        },
        {
          heading: "No clock — but don't go idle",
          body: (
            <>
              A match has <b>no time limit</b>: it ends when someone completes
              the puzzle, concedes, or disconnects. To keep a race from
              stalling, a seat that makes no move for <b>15 minutes</b> is
              warned, and one that stays idle for <b>20 minutes forfeits</b> —
              the opponent takes the win. Every verdict is the server&apos;s.
            </>
          ),
        },
        {
          heading: "How you play",
          body: (
            <>
              Select a cell on the board, then tap a number on the pad (or press
              1-9 on a keyboard). There is <b>no Submit button</b> — the number
              IS the move, and it goes straight to the server. A wrong value is
              never written to your board and the answer is never revealed: you
              lose a second, and you try again. Clues are shown in white; your
              own verified entries in amber.
            </>
          ),
        },
        {
          heading: "Simultaneous play — and the server decides",
          body: (
            <>
              Both players solve at the same time, each on their own board, and
              neither can see or affect the other&apos;s grid — only their
              progress bar. The board you see is the server&apos;s projection of
              your own seat, and it only ever holds clues and values the server
              has already verified. The server owns the puzzle, the clock, the
              progress and the winner.
            </>
          ),
        },
        {
          heading: "No stakes, pure skill",
          body: (
            <>
              There are <b>no wagers, no betting, no tokens and no payouts</b> in
              Sudoku Duel. Ranked matches move your rating and trophies, and
              nothing else — the outcome turns only on how fast and how
              accurately you solve the same puzzle your opponent is looking at.
            </>
          ),
        },
      ],
    }),
    [],
  );

  return (
    <PvpLobbyPage
      title="Sudoku Duel"
      subtitle="A rated 1v1 Sudoku race. Both players receive the exact same server-generated 9x9 puzzle and solve it simultaneously — finish the board first, or lead on verified progress when the clock runs out."
      icon={
        <IconGridDots className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />
      }
      rules={rules}
      rulesKey="sudoku-duel"
      waitingSubtitle="Pairing you with another Sudoku Duel player…"
      busy={busy}
      onPlay={createOrJoin}
      playLabel="Find a Match"
      playBusyLabel="Searching…"
      canPlay={Boolean(isSignedIn)}
      lobbies={lobbies}
      lobbiesLoading={lobbiesLoading}
      lobbyEmptyText="No open Sudoku Duel lobbies right now. Start a match and an opponent will be paired in."
      children={
        <AiDifficultyPicker
          gameKey="sudoku-duel"
          value={aiDifficulty}
          onChange={setAiDifficulty}
          hint={{
            easy: "A slow solver — a careful player can finish first.",
            normal: "A steady solver of the same puzzle. Beat it with a clean run.",
            hard: "A fast, near-optimal solver of the shared puzzle.",
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
      lobbyKey={(row: LobbyRow) => row.matchId}
      lobbyTitle={(row: LobbyRow) => <>Table #{String(row.matchId).slice(0, 8)}</>}
      lobbyMeta={(row: LobbyRow) => (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{difficultyLabel(row.difficulty) || "Sudoku"}</span>
          {givensLabel(row.givens) && <span>{givensLabel(row.givens)}</span>}
          <span className="text-emerald-300">Free ranked</span>
        </span>
      )}
      onJoin={() => createOrJoin()}
      joinLabel="Join"
      onRefresh={() => void fetchLobbies()}
      error={error}
    />
  );
}
