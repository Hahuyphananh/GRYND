"use client";

// src/app/casino/hillstrike/PageClient.tsx
//
// The Hillstrike lobby — the online 1v1 half of the game. It reuses the shared
// casino lobby chrome (`PvpLobbyPage`, the same component every other 1v1 game
// mounts) and wires it to the Hillstrike matchmaking endpoints:
//
//   POST /api/hillstrike/create-or-join     — match into the oldest open lobby,
//                                             or open a new one
//   GET  /api/hillstrike/available          — open lobbies (cheap poll)
//   GET  /api/hillstrike/match/<id>         — the caller's own lobby, while the
//                                             waiting screen is up
//   POST /api/hillstrike/match/<id>/cancel  — close the caller's own lobby
//
// ── WHAT THIS PAGE DECIDES ────────────────────────────────────────────────
//
// Nothing about a match. It asks the server to seat the caller and navigates to
// the id it is given. The battlefield, whose turn it is, both HP pools and the
// result are all rendered from the authoritative snapshot in the match view.
//
// ── FIND A MATCH DOES NOT DROP YOU ON AN EMPTY BOARD ──────────────────────
//
//   * `joined: true` — the caller took an OPEN seat, so the match is live the
//     moment it answers. Navigate straight to it.
//   * `joined: false` — the caller now owns a fresh WAITING lobby. Stay on the
//     matchmaking screen and navigate only once the server reports the match is
//     actually `playing`; the wait is watched through the authoritative snapshot,
//     so the client never decides on its own that a match has begun.
//
// ── GUEST POLICY ──────────────────────────────────────────────────────────
//
// Online Hillstrike requires a real, age-verified account (the same gate every
// other ranked duel uses). A signed-out visitor is pointed at free practice,
// which is entirely client-side and needs no match, no socket and no database.
// Hillstrike PvP is UNSTAKED: there is no wager picker here and nothing to
// escrow.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMatchRouter } from "../../../hooks/useMatchRouter";
import { useUser } from "@clerk/nextjs";
import { IconRobot, IconTargetArrow } from "@tabler/icons-react";

import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import MatchWaiting from "../../../components/lobby/MatchWaiting";
import { useSocket } from "../../../context/SocketProvider";
import { useSocketAwarePoll, useVisiblePoll } from "../../../hooks/useVisiblePoll";
import {
  DEFAULT_MATCH_DURATION_MS,
  MATCH_DURATION_OPTIONS_MS,
  MATCH_STATUS,
} from "../../../lib/hillstrike/constants";
import {
  HILLSTRIKE_LOBBY_ROOM,
  HILLSTRIKE_MATCH_UPDATED,
} from "../../../lib/hillstrike/rooms";

const PRACTICE_PATH = "/casino/hillstrike/play-ai";

/** The lobby's own name, in the one place the page states it. */
const GAME_NAME = "Hillstrike";

/** Backstop cadence for the waiting screen if the socket push is missed. */
const WAITING_POLL_MS = 2500;

type LobbyRow = {
  matchId: string;
  player1Id: string;
  status: string;
  seed?: number;
  durationMs?: number;
  createdAt?: string;
};

/** "10 min" for a lobby's clock. */
function durationLabel(ms: unknown): string {
  const minutes = Math.round(Number(ms) / 60_000);
  return Number.isFinite(minutes) && minutes > 0 ? `${minutes} min` : "—";
}

export default function HillstrikeLobbyPage() {
  const { isSignedIn, user } = useUser();
  const { socket } = useSocket();
  const router = useMatchRouter();

  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // The clock the caller wants. Matchmaking only pairs seats that asked for the
  // same one, so this is part of the offer, exactly like a chess time control.
  const [durationMs, setDurationMs] = useState<number>(DEFAULT_MATCH_DURATION_MS);
  const [error, setError] = useState<string | null>(null);
  const [lobbies, setLobbies] = useState<LobbyRow[]>([]);
  const [lobbiesLoading, setLobbiesLoading] = useState(true);
  // The caller's OWN waiting lobby, while the waiting takeover is up.
  const [waitingMatchId, setWaitingMatchId] = useState<string | null>(null);

  const fetchLobbies = useCallback(async () => {
    try {
      const res = await fetch("/api/hillstrike/available", { cache: "no-store" });
      const data = await res.json();
      if (data?.success) setLobbies(Array.isArray(data.data) ? data.data : []);
    } catch {
      // silent — the poll retries
    } finally {
      setLobbiesLoading(false);
    }
  }, []);

  // One read on mount, then the socket-aware, visibility-gated cadence, with the
  // lobby room's push on top. Gated on being signed in: this route is readable by
  // a signed-out visitor (so the free-practice link works) and the lobby list is
  // account-gated, so an anonymous tab must not poll a 401 every few seconds.
  useSocketAwarePoll(fetchLobbies, socket, Boolean(isSignedIn));

  useEffect(() => {
    if (!socket) return undefined;
    const refresh = () => fetchLobbies();
    socket.emit("join_room", { roomId: HILLSTRIKE_LOBBY_ROOM });
    socket.on(HILLSTRIKE_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId: HILLSTRIKE_LOBBY_ROOM });
      socket.off(HILLSTRIKE_MATCH_UPDATED, refresh);
    };
  }, [socket, fetchLobbies]);

  useEffect(() => {
    if (isSignedIn === false) setLobbiesLoading(false);
  }, [isSignedIn]);

  const myOpenId = useMemo(() => {
    if (!user?.id) return null;
    return lobbies.find((row) => row.player1Id === user.id)?.matchId ?? null;
  }, [lobbies, user?.id]);

  const pokeLobby = useCallback(() => {
    socket?.emit("room_event", {
      roomId: HILLSTRIKE_LOBBY_ROOM,
      event: HILLSTRIKE_MATCH_UPDATED,
    });
  }, [socket]);

  const matchPath = useCallback(
    (id: string) => `/casino/hillstrike/${id}`,
    [],
  );

  /**
   * Ask the server whether the lobby we are waiting in has actually started.
   *
   * The STATUS is the server's, never inferred: `playing` is the only evidence
   * that an opponent took the other seat.
   */
  const checkWaitingMatch = useCallback(async () => {
    if (!waitingMatchId) return;
    try {
      const res = await fetch(`/api/hillstrike/match/${waitingMatchId}`, {
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

  useVisiblePoll(checkWaitingMatch, WAITING_POLL_MS, Boolean(waitingMatchId));

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
      const res = await fetch("/api/hillstrike/create-or-join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The whole request: the clock only. Hillstrike is unstaked.
        body: JSON.stringify({ durationMs }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(data?.error || "Unable to find a match");
        return;
      }
      pokeLobby();
      if (data.data?.joined) {
        // We took an open seat: the match is already live, so go and play it.
        router.push(matchPath(data.data.matchId));
        return;
      }
      // We opened (or already owned) a lobby nobody has joined. Stay on the
      // matchmaking screen and let the server tell us when it starts.
      setWaitingMatchId(String(data.data.matchId));
    } catch {
      setError("Unable to find a match");
    } finally {
      setBusy(false);
    }
  }, [busy, durationMs, matchPath, pokeLobby, router]);

  const cancelLobby = useCallback(
    async (matchId: string) => {
      if (cancelling) return;
      setCancelling(true);
      try {
        await fetch(`/api/hillstrike/match/${matchId}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        setWaitingMatchId((current) => (current === matchId ? null : current));
        pokeLobby();
        await fetchLobbies();
      } finally {
        setCancelling(false);
      }
    },
    [cancelling, pokeLobby, fetchLobbies],
  );

  const myName = user?.username || user?.firstName || user?.fullName || "You";

  const waitingSeats = useMemo(
    () => [
      { label: "You", name: myName, occupied: true },
      { label: "Opponent", occupied: false },
    ],
    [myName],
  );

  const rules = useMemo(
    () => ({
      title: "How to Play Hillstrike",
      sections: [
        {
          heading: "Two hills, 100 HP each",
          body: (
            <>
              You and your opponent drive one tank each on opposite hills of one
              battlefield, with <b>100 HP</b> apiece. Every match deals a fresh
              layout, and the two halves are <b>mirror images</b> — neither seat
              gets better ground or stronger cover.
            </>
          ),
        },
        {
          heading: "Aim, then fire",
          body: (
            <>
              Drag away from your target to set <b>direction and power</b>, then
              fire. The projectile flies a real arc: it can be stopped by a built
              block, clipped by a hill, or fly clean out of bounds.
            </>
          ),
        },
        {
          heading: "Two actions per turn",
          body: (
            <>
              A randomly drawn opening seat takes <b>one</b> action; the other
              answers with <b>two</b>. From then on the seats alternate{" "}
              <b>two-action turns</b>, and each action is one of two things:{" "}
              <b>fire</b>, or <b>drive</b> closer or farther.
            </>
          ),
        },
        {
          heading: "The tower gates the map",
          body: (
            <>
              A <b>giant tower</b> stands in the middle of the battlefield, from the
              ground to the sky. Nothing crosses it — a lob over its top simply
              leaves the battlefield — so a lane has to be shot through its blocks
              before either tank can be hit. Each tower block takes two hits and
              never collapses into the hole you make. One of each power-up sits on
              each side of the tower, and each is dealt <b>once</b>: no respawns.
            </>
          ),
        },
        {
          heading: "The clock",
          body: (
            <>
              Every match is timed — <b>5</b>, <b>10</b> or <b>15</b> minutes, chosen
              when the lobby is opened, and you are only matched with players who
              picked the same clock. When it runs out the tank with <b>more HP</b>{" "}
              wins; level HP is a draw, which awards nothing.
            </>
          ),
        },
        {
          heading: "Range costs power",
          body: (
            <>
              A shell loses power the longer it flies: the HP a direct hit takes
              drops with it — up to <b>50</b> at point-blank range, about <b>25</b>
              from the middle, and about <b>16</b> from a full-map lob. Driving
              forward is how you buy damage, and driving away is how you give it up.
              <br />
              <br />
              Ground and blocks never cost HP by themselves, at any range. Each
              spawn sits under an indestructible roof, and the map climbs away
              from it, so neither tank can be sniped from its own corner: the
              slopes, the tower lane and the power-ups are what a win is made of.
              The first tank knocked out to 0 HP loses immediately. Whose turn it
              is, where the shell landed, the damage, both HP pools and the winner
              are all resolved <b>server-side</b> by the shared engine, so a stale
              tab can never invent a hit. Online matches are free and rated;
              practice against the bot at <b>/casino/hillstrike/play-ai</b> is free
              and unrated.
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
        subtitle="A free 1v1 artillery duel: 100 HP tanks, three actions per turn, mirrored battlefields, and every shot resolved by the server."
        icon={
          <IconTargetArrow className="h-9 w-9 flex-shrink-0 text-cyan-300 drop-shadow-[0_0_12px_rgba(34,211,238,0.55)] sm:h-10 sm:w-10" />
        }
        rulesKey="hillstrike"
        rules={rules}
        waitingSubtitle="Your hill is ready. The duel starts the moment an opponent takes the other seat."
        busy={busy}
        onPlay={createOrJoin}
        playLabel="Find a Match"
        playBusyLabel="Searching…"
        canPlay={Boolean(isSignedIn)}
        extraActions={
          <div className="flex w-full flex-col gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-bold uppercase tracking-widest text-white/45">
                Match clock
              </span>
              <div className="grid grid-cols-3 gap-2" data-testid="hillstrike-duration-picker">
                {MATCH_DURATION_OPTIONS_MS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    data-testid={`hillstrike-lobby-duration-${option}`}
                    data-selected={option === durationMs ? "1" : "0"}
                    onClick={() => setDurationMs(option)}
                    className={`rounded-lg border py-1.5 text-xs font-bold transition ${
                      option === durationMs
                        ? "border-cyan-300 bg-cyan-400/20 text-cyan-100"
                        : "border-white/15 text-white/60 hover:bg-white/10"
                    }`}
                  >
                    {option / 60_000} min
                  </button>
                ))}
              </div>
              <span className="text-[10px] leading-tight text-white/40">
                You are matched with players who picked the same clock. Most HP wins
                when it runs out.
              </span>
            </div>
            <button
              type="button"
              onClick={() => router.push(PRACTICE_PATH)}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-cyan-400/40 bg-cyan-400/10 py-2 text-sm font-bold text-cyan-200 transition hover:bg-cyan-400/20"
            >
              <IconRobot size={16} aria-hidden="true" /> Play Free vs AI
            </button>
          </div>
        }
        myOpenId={myOpenId}
        onResume={(id: string) => setWaitingMatchId(id)}
        onCancel={cancelLobby}
        cancelling={cancelling}
        lobbies={lobbies}
        lobbiesLoading={lobbiesLoading}
        lobbyEmptyText="No open Hillstrike lobbies right now. Create one and an opponent will be matched in."
        lobbyKey={(row: LobbyRow) => row.matchId}
        lobbyTitle={(row: LobbyRow) => <>Table #{String(row.matchId).slice(0, 8)}</>}
        lobbyMeta={(row: LobbyRow) => (
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>Host: {String(row.player1Id).slice(0, 12)}…</span>
            <span>1v1 · 100 HP each</span>
            <span>Clock: {durationLabel(row.durationMs)}</span>
            <span className="text-emerald-300">Free</span>
          </span>
        )}
        onJoin={() => createOrJoin()}
        joinLabel="Join"
        onRefresh={fetchLobbies}
        error={error}
      />

      {waitingMatchId && (
        <MatchWaiting
          state="waiting"
          gameName={GAME_NAME}
          icon={
            <IconTargetArrow size={30} className="text-cyan-300" aria-hidden="true" />
          }
          subtitle="Your table is open. The duel starts the moment an opponent takes the other hill."
          seats={waitingSeats}
          onCancel={() => cancelLobby(waitingMatchId)}
          cancelLabel="Cancel table"
          cancelling={cancelling}
        />
      )}
    </>
  );
}
