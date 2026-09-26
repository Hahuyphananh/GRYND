"use client";

// src/app/casino/mini-golf/PageClient.tsx
//
// Mini Golf lobby. Reuses the shared casino lobby chrome (PvpLobbyPage) so the
// page looks like every other 1v1 game, and wires it to the Mini Golf
// matchmaking endpoints:
//
//   POST /api/mini-golf/create-or-join  — match the caller into the oldest open
//                                          lobby, or open a new one
//   GET  /api/mini-golf/available       — open lobbies (cheap polling list)
//   POST /api/mini-golf/match/<id>/cancel — close the caller's own lobby
//
// Entry is free (stakes are retired platform-wide) and Mini Golf is unstaked,
// so there is no wager picker, no balance and no escrow note.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { usePostHog } from "posthog-js/react";
import { IconGolf } from "@tabler/icons-react";
import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import { useSocket } from "../../../context/SocketProvider";
import { MINI_GOLF_LOBBY_ROOM, MINI_GOLF_MATCH_UPDATED } from "../../../lib/mini-golf/rooms";

const POLL_MS = 3000;

type LobbyRow = {
  matchId: string;
  player1Id: string;
  status: string;
  createdAt?: string;
};

export default function MiniGolfLobbyPage() {
  const { isSignedIn, user } = useUser();
  const { socket } = useSocket();
  const router = useRouter();
  const posthog = usePostHog();

  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lobbies, setLobbies] = useState<LobbyRow[]>([]);

  const fetchLobbies = useCallback(async () => {
    try {
      const res = await fetch("/api/mini-golf/available", { cache: "no-store" });
      const data = await res.json();
      if (data?.success) setLobbies(Array.isArray(data.data) ? data.data : []);
    } catch {
      // silent — the poll retries
    }
  }, []);

  useEffect(() => {
    fetchLobbies();
    const id = setInterval(fetchLobbies, POLL_MS);
    return () => clearInterval(id);
  }, [fetchLobbies, isSignedIn, user?.id]);

  // Near-instant lobby refresh: the shared `lobby:mini-golf` room carries the
  // generic `lobby:updated` relay, exactly like the other PvP lobbies.
  useEffect(() => {
    if (!socket) return undefined;
    const refresh = () => fetchLobbies();
    socket.emit("join_room", { roomId: MINI_GOLF_LOBBY_ROOM });
    socket.on(MINI_GOLF_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId: MINI_GOLF_LOBBY_ROOM });
      socket.off(MINI_GOLF_MATCH_UPDATED, refresh);
    };
  }, [socket, fetchLobbies]);

  const myOpenId = useMemo(() => {
    if (!user?.id) return null;
    return lobbies.find((row) => row.player1Id === user.id)?.matchId ?? null;
  }, [lobbies, user?.id]);

  const pokeLobby = useCallback(() => {
    socket?.emit("room_event", { roomId: MINI_GOLF_LOBBY_ROOM, event: MINI_GOLF_MATCH_UPDATED });
  }, [socket]);

  const createOrJoin = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/mini-golf/create-or-join", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(data?.error || "Unable to find a match");
        return;
      }
      pokeLobby();
      posthog?.capture("mini_golf_match_started", {
        mode: data.data?.joined ? "join" : "create",
      });
      router.push(`/casino/mini-golf/${data.data.matchId}`);
    } catch {
      setError("Unable to find a match");
    } finally {
      setBusy(false);
    }
  }, [busy, pokeLobby, posthog, router]);

  const cancelLobby = useCallback(
    async (matchId: string) => {
      if (cancelling) return;
      setCancelling(true);
      try {
        await fetch(`/api/mini-golf/match/${matchId}/cancel`, { method: "POST" });
        pokeLobby();
        await fetchLobbies();
      } finally {
        setCancelling(false);
      }
    },
    [cancelling, pokeLobby, fetchLobbies],
  );

  return (
    <PvpLobbyPage
      title="Mini Golf"
      subtitle="Best of 5 holes, first to 3 hole wins. Fewest strokes takes the hole — hole it in fewer than your rival."
      icon={<IconGolf className="h-9 w-9 flex-shrink-0 text-emerald-400 drop-shadow-[0_0_12px_rgba(52,211,153,0.6)] sm:h-10 sm:w-10" />}
      rulesKey="mini-golf"
      rules={{
        title: "How to Play Mini Golf",
        sections: [
          {
            heading: "Best of 5 — first to 3",
            body: (
              <>
                Every match is five holes. Win a hole by taking{" "}
                <b>fewer strokes</b> than your opponent; the first player to win
                three holes takes the match immediately. Equal strokes halve the
                hole and award nobody.
              </>
            ),
          },
          {
            heading: "Aim and power",
            body: (
              <>
                Drag on the course to aim — the line shows your direction and how
                hard you will hit it. Dial the power meter for precision, then
                press <b>Shoot</b>. Sand slows the ball; water costs a penalty
                stroke and replays the shot.
              </>
            ),
          },
          {
            heading: "Both balls, one cup",
            body: (
              <>
                Each player putts their own ball, taking turns. A hole finishes
                only when <b>both</b> balls are in the cup, so the trailing
                player always gets the strokes to catch up.
              </>
            ),
          },
        ],
      }}
      waitingSubtitle="Pairing you with another Mini Golf player…"
      busy={busy}
      onPlay={createOrJoin}
      playLabel="Find a Match"
      playBusyLabel="Searching…"
      canPlay={Boolean(isSignedIn)}
      extraActions={
        <button
          type="button"
          onClick={createOrJoin}
          disabled={busy}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-cyan-500/40 bg-cyan-500/10 py-2 text-sm font-bold text-cyan-200 transition hover:bg-cyan-500/20 disabled:opacity-50"
        >
          {busy ? "Joining…" : "Quick Join"}
        </button>
      }
      myOpenId={myOpenId}
      onResume={(id: string) => router.push(`/casino/mini-golf/${id}`)}
      onCancel={cancelLobby}
      cancelling={cancelling}
      lobbies={lobbies}
      lobbyEmptyText="No open Mini Golf lobbies right now. Create one and an opponent will be matched in."
      lobbyKey={(row: LobbyRow) => row.matchId}
      lobbyTitle={(row: LobbyRow) => <>Hole #{String(row.matchId).slice(0, 8)}</>}
      lobbyMeta={(row: LobbyRow) => (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>Host: {String(row.player1Id).slice(0, 12)}…</span>
          <span>Best of 5 · first to 3</span>
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
