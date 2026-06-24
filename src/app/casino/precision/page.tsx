"use client";

// ── Lobby page for the Precision PvP casino game ─────────────────────────
//
// Mirrors the architecture of /casino/pool-masters:
//   * Top-level wager picker + PvP / AI create buttons
//   * Live list of open lobbies (polled every 3s)
//   * On "Create PvP", redirect to /casino/precision/game/[lobbyId] which
//     then renders the waiting room while the host waits for an opponent.
//   * On "Test Mode", redirect to /casino/precision/test — a self-contained
//     solo reaction-time sandbox that runs entirely client-side (no wager,
//     no opponent, no server interaction). See that page's header comment
//     for the rationale.
//
// The multi-step flow (lobby → match page) keeps the matchmaking state on
// the server and avoids duplicating it client-side.

import { useEffect, useState } from "react";
import Link from "next/link";
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

  // The Test button is a plain `<Link>` navigation, not a server call.
  // See `src/app/casino/precision/test/page.tsx` for the solo sandbox.
  // We capture analytics on click so the funnel / "test_to_pvp"
  // conversion ratio can be measured without leaning on hover-tracking.
  const handleTestClick = () => {
    posthog?.capture("precision_test_clicked", { source: "lobby" });
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
          Step into <span className="font-bold text-fuchsia-300">Test Mode</span>{" "}
          first if you want to sharpen your reaction time solo — no wager,
          no opponent.
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
              data-testid="precision-create-pvp-button"
              onClick={handleCreatePvP}
              disabled={creating}
              className="mt-4 w-full rounded bg-cyan-400 py-2 font-bold text-black disabled:opacity-50"
            >
              {creating ? "Creating…" : "Find PvP Match"}
            </button>
            <Link
              href="/casino/precision/test"
              data-testid="precision-test-link"
              onClick={handleTestClick}
              className="mt-2 block w-full rounded border border-fuchsia-400/60 bg-fuchsia-500/10 py-2 text-center font-bold text-fuchsia-200 transition hover:bg-fuchsia-500/20"
            >
              🎯 Test Mode (solo, no wager)
            </Link>
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
                      PvP · Waiting for player
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
