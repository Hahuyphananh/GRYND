"use client";

// src/app/casino/barrier-blitz/PageClient.tsx
//
// The Barrier Blitz lobby — the online 1v1 half of the game. It reuses the
// shared casino lobby chrome (`PvpLobbyPage`, the same component every other
// 1v1 game mounts) and wires it to the Barrier Blitz matchmaking endpoints:
//
//   POST /api/barricade/create-or-join     — match into the oldest open lobby,
//                                            or open a new one
//   GET  /api/barricade/available          — open lobbies (cheap poll)
//   GET  /api/barricade/match/<id>         — the caller's own lobby, while the
//                                            waiting screen is up
//   POST /api/barricade/match/<id>/cancel  — close the caller's own lobby
//
// ── WHAT THIS PAGE DECIDES ────────────────────────────────────────────────
//
// Nothing about a match. It asks the server to seat the caller and navigates to
// the id it is given. The board, the turn, the barrier reserves and the result
// are all rendered from the authoritative snapshot in the match view.
//
// ── FIND A MATCH DOES NOT DROP YOU ON AN EMPTY BOARD ──────────────────────
//
// The route answers in two different situations and they must not look the
// same:
//
//   * `joined: true` — the caller took an OPEN seat, so the match is live the
//     moment it answers. Navigate straight to it.
//   * `joined: false` — the caller now owns a fresh WAITING lobby. Sending them
//     to /casino/barrier-blitz/<id> here is what previously dropped a player
//     onto a board with no opponent (and a "waiting" banner) instead of the
//     matchmaking screen they had just asked for. So instead we stay put and
//     show the shared waiting takeover, and navigate only once the server
//     reports the match has actually started.
//
// The wait is watched through the authoritative snapshot — GET
// /api/barricade/match/<id>, the same read the match view polls — so the client
// never decides on its own that a match has begun. The lobby room's own
// `lobby:updated` push (fired by the joining player's `pokeLobby`) also
// refreshes the lobby list, which is the earliest client-visible hint somebody
// arrived; the waiting check re-runs on that list change, so a pair-up lands in
// roughly a socket round-trip, with the interval as the backstop.
//
// ── GUEST POLICY ──────────────────────────────────────────────────────────
//
// Online Barrier Blitz requires a real, age-verified account (the same gate
// every other ranked duel uses, see /api/barricade/create-or-join). A signed-out
// visitor is therefore pointed at free practice, which is entirely client-side
// and needs no match, no socket and no database — `canPlay` gates the button and
// the practice route stays one click away.
//
// Entry is free: Barrier Blitz is unstaked, so there is no wager picker, no
// balance and no escrow note, and there is no bot on this route (practice is its
// own route at /casino/barrier-blitz/play-ai).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { usePostHog } from "posthog-js/react";
import { IconRobot, IconWall } from "@tabler/icons-react";

import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import MatchWaiting from "../../../components/lobby/MatchWaiting";
import { useSocket } from "../../../context/SocketProvider";
import { useSocketAwarePoll, useVisiblePoll } from "../../../hooks/useVisiblePoll";
import { MATCH_STATUS } from "../../../lib/barricade/constants";
import {
  BARRICADE_LOBBY_ROOM,
  BARRICADE_MATCH_UPDATED,
} from "../../../lib/barricade/rooms";

const PRACTICE_PATH = "/casino/barrier-blitz/play-ai";

/** The lobby's own name, in the one place the page states it. */
const GAME_NAME = "Barrier Blitz";

/**
 * How often the waiting screen re-reads the caller's own match.
 *
 * The socket push (see the file header) is what normally ends the wait, so this
 * is the backstop cadence for a dropped socket — the same role the 30s lobby
 * poll plays, tightened because "an opponent just arrived" is the single most
 * time-sensitive thing on the screen. It runs ONLY while a wait is in progress
 * and only while the tab is visible (see `useVisiblePoll`), so it costs nothing
 * on an idle lobby.
 */
const WAITING_POLL_MS = 2500;

type LobbyRow = {
  matchId: string;
  player1Id: string;
  status: string;
  createdAt?: string;
};

export default function BarrierBlitzLobbyPage() {
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
  // The caller's OWN waiting lobby, while the waiting takeover is up. Non-null
  // means "we are matchmaking": the board is NOT entered until the server says
  // this match is playing (see the file header).
  const [waitingMatchId, setWaitingMatchId] = useState<string | null>(null);

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

  const matchPath = useCallback(
    (id: string) => `/casino/barrier-blitz/${id}`,
    [],
  );

  /**
   * Ask the server whether the lobby we are waiting in has actually started.
   *
   * The STATUS is the server's, never inferred: `playing` is the only evidence
   * that an opponent took the other seat. A `cancelled`/`finished` lobby (which
   * only happens if the wait was ended elsewhere) drops the waiting screen
   * instead of navigating, and a transient failure simply leaves the wait up —
   * the next tick retries.
   */
  const checkWaitingMatch = useCallback(async () => {
    if (!waitingMatchId) return;
    try {
      const res = await fetch(`/api/barricade/match/${waitingMatchId}`, {
        cache: "no-store",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) return;
      const status = String(data.data?.status ?? "");
      if (status === MATCH_STATUS.PLAYING) {
        setWaitingMatchId(null);
        router.push(matchPath(waitingMatchId));
        return;
      }
      if (
        status === MATCH_STATUS.CANCELLED ||
        status === MATCH_STATUS.FINISHED
      ) {
        setWaitingMatchId(null);
        void fetchLobbies();
      }
    } catch {
      // Transient — the interval retries.
    }
  }, [fetchLobbies, matchPath, router, waitingMatchId]);

  // The backstop cadence, plus an immediate check the moment the wait begins.
  useVisiblePoll(checkWaitingMatch, WAITING_POLL_MS, Boolean(waitingMatchId));

  // …and an immediate re-check whenever the lobby list changes. That list is
  // what the joining player's `lobby:updated` poke refreshes, so this is the
  // fast path: whoever clicks Join makes both players leave the waiting screen
  // within a socket round-trip.
  useEffect(() => {
    if (!waitingMatchId) return;
    void checkWaitingMatch();
    // `lobbies` is intentionally part of this: a new list identity IS the push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingMatchId, lobbies, checkWaitingMatch]);

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
      if (data.data?.joined) {
        // We took an open seat: the match is already live, so go and play it.
        router.push(matchPath(data.data.matchId));
        return;
      }
      // We opened (or already owned) a lobby nobody has joined. The match is
      // WAITING — stay on the matchmaking screen and let the server tell us
      // when it starts, instead of dropping the player onto an empty board.
      setWaitingMatchId(String(data.data.matchId));
    } catch {
      setError("Unable to find a match");
    } finally {
      setBusy(false);
    }
  }, [busy, matchPath, pokeLobby, posthog, router]);

  const cancelLobby = useCallback(
    async (matchId: string) => {
      if (cancelling) return;
      setCancelling(true);
      try {
        await fetch(`/api/barricade/match/${matchId}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        // Leaving the waiting screen must also end the WAIT — otherwise the
        // poll would keep asking about a lobby the player just closed.
        setWaitingMatchId((current) => (current === matchId ? null : current));
        pokeLobby();
        await fetchLobbies();
      } finally {
        setCancelling(false);
      }
    },
    [cancelling, pokeLobby, fetchLobbies],
  );

  const myName =
    user?.username || user?.firstName || user?.fullName || "You";

  const waitingSeats = useMemo(
    () => [
      { label: "You", name: myName, occupied: true },
      { label: "Opponent", occupied: false },
    ],
    [myName],
  );

  // Rules copy. Barrier Blitz is turn-based with no timers and no randomness, so
  // these stay to the four things a new player actually has to know: the race,
  // the one-action turn, what a barrier blocks, and that no wall may seal the
  // board.
  const rules = useMemo(
    () => ({
      title: "How to Play Barrier Blitz",
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
              <b>one barrier</b>. Facing the opponent with an open groove between
              you, you may instead <b>jump</b> straight over them — or, if the
              square behind them is blocked, move diagonally to one of the two
              squares beside them.
            </>
          ),
        },
        {
          heading: "Barriers block everyone",
          body: (
            <>
              A barrier is <b>two squares long</b> and sits in the groove between
              squares, so it blocks <b>both</b> players, in both directions. You
              have <b>ten</b> of them. Two barriers may never overlap or cross.
            </>
          ),
        },
        {
          heading: "No wall may seal a route",
          body: (
            <>
              Every legal barrier must leave <b>both</b> pawns a route to their
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
    <>
      <PvpLobbyPage
        title={GAME_NAME}
        subtitle="A free 1v1 race on a 9×9 board: ten barriers each, one action per turn, and the first pawn to cross to the far side wins."
        icon={
          <IconWall className="h-9 w-9 flex-shrink-0 text-cyan-300 drop-shadow-[0_0_12px_rgba(34,211,238,0.55)] sm:h-10 sm:w-10" />
        }
        rulesKey="barricade"
        rules={rules}
        waitingSubtitle={`Pairing you with another ${GAME_NAME} player…`}
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
        // Resuming an open lobby lands on the SAME matchmaking screen as
        // creating one: the lobby is still waiting for somebody, so the board
        // is not where the player should end up (see the file header).
        onResume={(id: string) => setWaitingMatchId(id)}
        onCancel={cancelLobby}
        cancelling={cancelling}
        lobbies={lobbies}
        lobbiesLoading={lobbiesLoading}
        lobbyEmptyText={`No open ${GAME_NAME} lobbies right now. Create one and an opponent will be matched in.`}
        lobbyKey={(row: LobbyRow) => row.matchId}
        lobbyTitle={(row: LobbyRow) => <>Table #{String(row.matchId).slice(0, 8)}</>}
        lobbyMeta={(row: LobbyRow) => (
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>Host: {String(row.player1Id).slice(0, 12)}…</span>
            <span>9×9 · ten barriers each</span>
            <span className="text-emerald-300">Free</span>
          </span>
        )}
        onJoin={() => createOrJoin()}
        joinLabel="Join"
        onRefresh={fetchLobbies}
        error={error}
      />

      {/* The matchmaking takeover, held open for as long as the server says the
          lobby is still waiting. Cancel is the only way out — and it closes the
          lobby, so the player is never left owning a table they walked away
          from. */}
      {waitingMatchId && (
        <MatchWaiting
          state="waiting"
          gameName={GAME_NAME}
          icon={
            <IconWall
              size={30}
              className="text-cyan-300"
              aria-hidden="true"
            />
          }
          subtitle="Your table is open. The match starts the moment an opponent takes the seat."
          seats={waitingSeats}
          onCancel={() => cancelLobby(waitingMatchId)}
          cancelLabel="Cancel table"
          cancelling={cancelling}
        />
      )}
    </>
  );
}
