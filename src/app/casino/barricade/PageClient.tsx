"use client";

// src/app/casino/barricade/PageClient.tsx
//
// The Barricade lobby — the online 1v1 half of the game. It reuses the shared
// casino lobby chrome (`PvpLobbyPage`, the same component every other 1v1 game
// mounts) and wires it to the Barricade matchmaking endpoints:
//
//   POST /api/barricade/create-or-join     — match into the oldest open lobby,
//                                            or open a new one
//   GET  /api/barricade/available          — open lobbies (cheap poll)
//   POST /api/barricade/match/<id>/cancel  — close the caller's own lobby
//
// ── WHAT THIS PAGE DECIDES ────────────────────────────────────────────────
//
// Nothing about a match. It asks the server to seat the caller and navigates to
// the id it is given. The board, the turn, the barricade reserves and the result
// are all rendered from the authoritative snapshot in the match view.
//
// ── GUEST POLICY ──────────────────────────────────────────────────────────
//
// Online Barricade requires a real, age-verified account (the same gate every
// other ranked duel uses, see /api/barricade/create-or-join). A signed-out
// visitor is therefore pointed at free practice, which is entirely client-side
// and needs no match, no socket and no database — `canPlay` gates the button and
// the practice route stays one click away.
//
// Entry is free: Barricade is unstaked, so there is no wager picker, no balance
// and no escrow note, and there is no bot on this route (practice is its own
// route at /casino/barricade/play-ai).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { usePostHog } from "posthog-js/react";
import { IconRobot, IconWall } from "@tabler/icons-react";

import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import { useSocket } from "../../../context/SocketProvider";
import { useSocketAwarePoll } from "../../../hooks/useVisiblePoll";
import {
  BARRICADE_LOBBY_ROOM,
  BARRICADE_MATCH_UPDATED,
} from "../../../lib/barricade/rooms";

const PRACTICE_PATH = "/casino/barricade/play-ai";

type LobbyRow = {
  matchId: string;
  player1Id: string;
  status: string;
  createdAt?: string;
};

export default function BarricadeLobbyPage() {
  const { isSignedIn, user } = useUser();
  const { socket } = useSocket();
  const router = useRouter();
  const posthog = usePostHog();

  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lobbies, setLobbies] = useState<LobbyRow[]>([]);
  // False once the first list response lands, so the empty state never flashes
  // before the request resolves.
  const [lobbiesLoading, setLobbiesLoading] = useState(true);

  const fetchLobbies = useCallback(async () => {
    try {
      const res = await fetch("/api/barricade/available", { cache: "no-store" });
      const data = await res.json();
      if (data?.success) setLobbies(Array.isArray(data.data) ? data.data : []);
    } catch {
      // silent — the poll retries
    } finally {
      setLobbiesLoading(false);
    }
  }, []);

  // One read on mount, then the socket-aware, visibility-gated cadence (30s
  // healthy / 5s if the socket drops) — the shared `lobby:barricade` room pushes
  // an instant refresh on top of it. The poll is gated on being signed in: this
  // route is readable by a signed-out visitor (so the free-practice link works),
  // and the lobby list is account-gated, so an anonymous tab must not sit there
  // polling a 401 every few seconds.
  useSocketAwarePoll(fetchLobbies, socket, Boolean(isSignedIn));

  useEffect(() => {
    if (!socket) return undefined;
    const refresh = () => fetchLobbies();
    socket.emit("join_room", { roomId: BARRICADE_LOBBY_ROOM });
    socket.on(BARRICADE_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId: BARRICADE_LOBBY_ROOM });
      socket.off(BARRICADE_MATCH_UPDATED, refresh);
    };
  }, [socket, fetchLobbies]);

  // With no account there is no poll to finish (see the gate above), so the list
  // must not sit on its loading skeleton forever: the lobby shows its normal
  // empty-state copy next to the shared "Sign in to play" action instead.
  useEffect(() => {
    if (isSignedIn === false) setLobbiesLoading(false);
  }, [isSignedIn]);

  const myOpenId = useMemo(() => {
    if (!user?.id) return null;
    return lobbies.find((row) => row.player1Id === user.id)?.matchId ?? null;
  }, [lobbies, user?.id]);

  const pokeLobby = useCallback(() => {
    socket?.emit("room_event", {
      roomId: BARRICADE_LOBBY_ROOM,
      event: BARRICADE_MATCH_UPDATED,
    });
  }, [socket]);

  const createOrJoin = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/barricade/create-or-join", {
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
      posthog?.capture("barricade_match_started", {
        mode: data.data?.joined ? "join" : "create",
      });
      router.push(`/casino/barricade/${data.data.matchId}`);
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
        await fetch(`/api/barricade/match/${matchId}/cancel`, {
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

  // Rules copy. Barricade is turn-based with no timers and no randomness, so
  // these stay to the four things a new player actually has to know: the race,
  // the one-action turn, what a barricade blocks, and that no wall may seal the
  // board.
  const rules = useMemo(
    () => ({
      title: "How to Play Barricade",
      sections: [
        {
          heading: "Race to the far baseline",
          body: (
            <>
              You and your opponent each start on the <b>centre square of your own
              baseline</b> of a <b>9×9 board</b>. The first pawn to reach{" "}
              <b>any square of the opposite row</b> wins immediately.
            </>
          ),
        },
        {
          heading: "One action per turn",
          body: (
            <>
              Every turn is exactly one of two things: walk your pawn{" "}
              <b>one square</b> (up, down or sideways — never diagonally), or place{" "}
              <b>one barricade</b>. Facing the opponent with an open groove between
              you, you may instead <b>jump</b> straight over them — or, if the
              square behind them is blocked, move diagonally to one of the two
              squares beside them.
            </>
          ),
        },
        {
          heading: "Barricades block everyone",
          body: (
            <>
              A barricade is <b>two squares long</b> and sits in the groove between
              squares, so it blocks <b>both</b> players, in both directions. You
              have <b>ten</b> of them. Two barricades may never overlap or cross.
            </>
          ),
        },
        {
          heading: "No wall may seal a route",
          body: (
            <>
              Every legal barricade must leave <b>both</b> pawns a route to their
              goal — a placement that traps a player for good is refused by the
              server. Whose turn it is, what is legal and who won are all decided
              server-side, so a stale tab can never play out of turn or invent a
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
      title="Barricade"
      subtitle="A free 1v1 race on a 9×9 board: ten barricades each, one action per turn, and the first pawn to cross to the far side wins."
      icon={
        <IconWall className="h-9 w-9 flex-shrink-0 text-cyan-300 drop-shadow-[0_0_12px_rgba(34,211,238,0.55)] sm:h-10 sm:w-10" />
      }
      rulesKey="barricade"
      rules={rules}
      waitingSubtitle="Pairing you with another Barricade player…"
      busy={busy}
      onPlay={createOrJoin}
      playLabel="Find a Match"
      playBusyLabel="Searching…"
      canPlay={Boolean(isSignedIn)}
      extraActions={
        <button
          type="button"
          onClick={() => router.push(PRACTICE_PATH)}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-cyan-400/40 bg-cyan-400/10 py-2 text-sm font-bold text-cyan-200 transition hover:bg-cyan-400/20"
        >
          <IconRobot size={16} aria-hidden="true" /> Play Free vs AI
        </button>
      }
      myOpenId={myOpenId}
      onResume={(id: string) => router.push(`/casino/barricade/${id}`)}
      onCancel={cancelLobby}
      cancelling={cancelling}
      lobbies={lobbies}
      lobbiesLoading={lobbiesLoading}
      lobbyEmptyText="No open Barricade lobbies right now. Create one and an opponent will be matched in."
      lobbyKey={(row: LobbyRow) => row.matchId}
      lobbyTitle={(row: LobbyRow) => <>Table #{String(row.matchId).slice(0, 8)}</>}
      lobbyMeta={(row: LobbyRow) => (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>Host: {String(row.player1Id).slice(0, 12)}…</span>
          <span>9×9 · ten barricades each</span>
          <span className="text-emerald-300">Free</span>
        </span>
      )}
      onJoin={() => createOrJoin()}
      joinLabel="Join"
      onRefresh={fetchLobbies}
      error={error}
    />
  );
}
