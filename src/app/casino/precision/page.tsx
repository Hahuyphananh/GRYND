"use client";

// ── Lobby page for the Precision PvP casino game ─────────────────────────
//
// Mirrors the architecture of /casino/pool-masters:
//   * Top-level wager picker + PvP / AI create buttons
//   * Live list of open lobbies (polled every 3s)
//   * On "Create PvP", redirect to /casino/precision/game/[lobbyId] which
//     then renders the waiting room while the host waits for an opponent.
//
// The multi-step flow (lobby → match page) keeps the matchmaking state on
// the server and avoids duplicating it client-side.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";
import {
  createLobby,
  joinLobby,
  listLobbies,
  emitLobbyListUpdate,
} from "../../../lib/precision/multiplayer";
import { useSocket } from "../../../context/SocketProvider";
import {
  DEFAULT_WAGER,
  DEFAULT_WAGER_OPTIONS,
  LOBBY_LIST_POLL_INTERVAL_MS,
} from "../../../lib/precision/constants";
import type { PrecisionLobby } from "../../../lib/precision/types";

export default function PrecisionLobbyPage() {
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();
  const [lobbies, setLobbies] = useState<PrecisionLobby[]>([]);
  const [wager, setWager] = useState<number>(DEFAULT_WAGER);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Subscribe to lobby-list updates pushed by other clients via the
  // realtime server. Mirrors the Uno `lobby:uno` room pattern.
  useEffect(() => {
    if (!socket) return;
    const roomId = "lobby:precision";
    socket.emit("join_room", { roomId });
    socket.on("precision:lobby:updated", () => {
      void reload();
    });
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("precision:lobby:updated");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  const reload = async () => {
    try {
      const list = await listLobbies();
      setLobbies(list);
    } catch {
      // ignore — list will be retried on the next interval
    }
  };

  /**
   * Write the locally owned seat ("1" or "2") to sessionStorage. The
   * match page reads this on mount so it knows which player record is
   * "self" — auth hasn't landed in the scaffold yet.
   */
  const persistLocalSeat = (seat: 1 | 2) => {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem("precision:localSeat", String(seat));
    } catch {
      // sessionStorage may be unavailable (private mode, sandboxed iframe)
      // — silence the error so the navigation still fires.
    }
  };

  // Poll the public lobby list as a fallback for clients that miss the
  // realtime nudge.
  useEffect(() => {
    void reload();
    const id = setInterval(reload, LOBBY_LIST_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const handleCreatePvP = async () => {
    setCreating(true);
    setError(null);
    try {
      posthog?.capture("precision_find_match", { wager, mode: "pvp" });
      const res = await createLobby({ wager, gameMode: "pvp" });
      if (!res.success || !res.gameId) {
        setError(res.error ?? "Unable to find a match.");
        return;
      }
      posthog?.capture("precision_matchmaking_status", {
        status: res.status,
        wager,
        opponentUserId: res.opponent?.userId,
      });
      // Record which seat we own so the match page can decide whether
      // WE are the Ready button. "waiting" = host = seat 1, "matched" =
      // joiner (we found an existing wait) = seat 2.
      persistLocalSeat(res.status === "matched" ? 2 : 1);
      if (res.status !== "waiting") {
        emitLobbyListUpdate(socket);
      }
      router.push(`/casino/precision/game/${res.gameId}`);
    } finally {
      setCreating(false);
    }
  };

  const handleCreateAI = async () => {
    setCreating(true);
    setError(null);
    try {
      posthog?.capture("precision_find_match", { wager, mode: "ai" });
      const res = await createLobby({ wager, gameMode: "ai" });
      if (!res.success || !res.gameId) {
        setError(res.error ?? "AI match creation is not yet available.");
        return;
      }
      // AI matches: caller is always seat 1; AI stub occupies seat 2.
      persistLocalSeat(1);
      router.push(`/casino/precision/game/${res.gameId}?ai=1`);
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = async (lobbyId: string) => {
    setJoining(lobbyId);
    setError(null);
    try {
      const res = await joinLobby(lobbyId);
      if (!res.success || !res.matchId) {
        setError(res.error ?? "Unable to join lobby.");
        return;
      }
      // Joining an open lobby from the public list means we're the
      // joiner (seat 2). The lobby's host is already seat 1.
      persistLocalSeat(2);
      emitLobbyListUpdate(socket);
      router.push(`/casino/precision/game/${res.matchId}`);
    } finally {
      setJoining(null);
    }
  };

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-b from-[#06120f] to-[#050816] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto mt-4 max-w-6xl rounded-2xl border border-cyan-500/40 bg-black/30 p-4 sm:mt-8 sm:p-5">
        <h1 className="text-2xl font-black text-fuchsia-300 sm:text-3xl md:text-4xl">
          Precision Lobby
        </h1>
        <p className="mt-2 text-sm text-cyan-100/90">
          Wager tokens and face another player in a 1v1 precision duel.
          Gameplay is currently in scaffolding — lobbies, matchmaking and
          the waiting room are wired up but the actual duel is on the way.
        </p>

        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-fuchsia-500/40 bg-black/30 p-4">
            <h2 className="text-xl font-bold">Create game</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {DEFAULT_WAGER_OPTIONS.map((v) => (
                <button
                  key={v}
                  onClick={() => setWager(v)}
                  className={`min-h-11 rounded px-3 py-2 ${
                    wager === v ? "bg-fuchsia-600" : "bg-slate-800"
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
            <button
              onClick={handleCreatePvP}
              disabled={creating}
              className="mt-4 w-full rounded bg-cyan-400 py-2 font-bold text-black disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create PvP Game"}
            </button>
            <button
              onClick={handleCreateAI}
              disabled={creating}
              className="mt-2 w-full rounded bg-pink-500 py-2 font-bold text-black disabled:opacity-50"
            >
              Create AI Game
            </button>
            {error && (
              <p className="mt-3 rounded border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                {error}
              </p>
            )}
          </div>

          <div className="rounded-xl border border-cyan-500/40 bg-black/30 p-4 lg:col-span-2">
            <h2 className="text-xl font-bold">Available Games</h2>
            <div className="mt-3 space-y-3">
              {lobbies.length === 0 && (
                <p className="text-slate-300">No open lobbies.</p>
              )}
              {lobbies.map((l) => (
                <div
                  key={l.id}
                  className="flex flex-col gap-2 rounded border border-slate-700 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p>Wager: {l.wager}</p>
                    <p className="text-xs text-slate-400">
                      Mode: {l.gameMode} · Waiting for player
                    </p>
                  </div>
                  <button
                    onClick={() => handleJoin(l.id)}
                    disabled={joining === l.id}
                    className="min-h-11 rounded bg-fuchsia-600 px-3 py-2 disabled:opacity-50"
                  >
                    {joining === l.id ? "Joining…" : "Join"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <Footer />
    </div>
  );
}
