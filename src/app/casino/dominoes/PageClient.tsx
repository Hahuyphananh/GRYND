"use client";

// src/app/casino/dominoes/PageClient.tsx
//
// The online Dominoes lobby — the free 1v1 half of the game. It reuses the shared
// casino lobby chrome (`PvpLobbyPage`, the same component every other 1v1 game
// mounts) and wires it to the Dominoes matchmaking endpoints:
//
//   POST /api/dominoes/create-or-join     — match into the oldest open lobby, or
//                                           open a new one
//   GET  /api/dominoes/available          — open lobbies (event-driven refresh)
//   GET  /api/dominoes/match/<id>         — the caller's own lobby, while waiting
//   POST /api/dominoes/match/<id>/cancel  — close the caller's own lobby
//
// ── WHAT THIS PAGE DECIDES ────────────────────────────────────────────────
//
// Nothing about a match. It asks the server to seat the caller and navigates to
// the id it is given. The deal, the chain, the turn and the result are all
// rendered from the authoritative snapshot in the match view.
//
// ── FIND A MATCH DOES NOT DROP YOU ON AN EMPTY BOARD ──────────────────────
//
// The route answers in two different situations and they must not look the same:
//
//   * `joined: true` — the caller took an OPEN seat, so the match is live the
//     moment it answers. Navigate straight to it.
//   * `joined: false` — the caller now owns a fresh WAITING lobby. Stay on the
//     matchmaking screen and navigate only once the SERVER reports the match is
//     playing. The wait is watched through the authoritative snapshot, so the
//     client never decides on its own that a match has begun.
//
// ── UNSTAKED ──────────────────────────────────────────────────────────────
//
// Dominoes is a free duel: no stake picker, no escrow, no payout. The lobby
// therefore passes no `wager`, and the match row has no stake column at all.
//
// ── FREE PRACTICE ─────────────────────────────────────────────────────────
//
// There is none yet: this step ships the ONLINE table only. A signed-out visitor
// gets the shared "sign in to play" action (the lobby is public to READ, which is
// why /casino/dominoes is in `GAME_ROUTE_PATTERNS` in src/proxy.ts).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { usePostHog } from "posthog-js/react";

import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import MatchWaiting from "../../../components/lobby/MatchWaiting";
import { useSocket } from "../../../context/SocketProvider";
import { useTranslation } from "../../../hooks/useTranslation";
import { useSocketAwarePoll, useVisiblePoll } from "../../../hooks/useVisiblePoll";
import { MATCH_STATUS } from "../../../lib/dominoes/constants";
import {
  DOMINOES_LOBBY_ROOM,
  DOMINOES_MATCH_UPDATED,
} from "../../../lib/dominoes/rooms";

/**
 * The lobby's own name. It is a translation KEY, not a string: the page passes
 * the resolved name to the shared lobby chrome and to the waiting takeover so a
 * French or Spanish player sees "Dominos" / "Dominó" everywhere it appears.
 */
const GAME_NAME_KEY = "games.dominoes_name";

/**
 * How often the waiting screen re-reads the caller's own match.
 *
 * The socket push is what normally ends the wait, so this is the backstop
 * cadence for a dropped socket — tightened because "an opponent just arrived" is
 * the most time-sensitive thing on the screen. It runs ONLY while a wait is in
 * progress and only while the tab is visible (see `useVisiblePoll`), so an idle
 * lobby costs nothing.
 */
const WAITING_POLL_MS = 2500;

type LobbyRow = {
  matchId: string;
  player1Id: string;
  status: string;
  createdAt?: string;
};

export default function DominoesLobbyPage() {
  const { t } = useTranslation();
  const { isSignedIn, user } = useUser();
  const { socket } = useSocket();
  const GAME_NAME = t(GAME_NAME_KEY);
  const router = useRouter();
  const posthog = usePostHog();

  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lobbies, setLobbies] = useState<LobbyRow[]>([]);
  const [lobbiesLoading, setLobbiesLoading] = useState(true);
  // The caller's OWN waiting lobby, while the waiting takeover is up. Non-null
  // means "we are matchmaking": the board is NOT entered until the server says
  // this match is playing.
  const [waitingMatchId, setWaitingMatchId] = useState<string | null>(null);

  const fetchLobbies = useCallback(async () => {
    try {
      const res = await fetch("/api/dominoes/available", { cache: "no-store" });
      const data = await res.json();
      if (data?.success) setLobbies(Array.isArray(data.data) ? data.data : []);
    } catch {
      // silent — the poll retries
    } finally {
      setLobbiesLoading(false);
    }
  }, []);

  // One read on mount, then the socket-aware, visibility-gated cadence (30s
  // healthy / 5s if the socket drops), with the `lobby:dominoes` room pushing an
  // instant refresh on top. Gated on being signed in: the route is readable by a
  // signed-out visitor and the lobby list is account-gated, so an anonymous tab
  // must not poll a 401 every few seconds.
  useSocketAwarePoll(fetchLobbies, socket, Boolean(isSignedIn));

  useEffect(() => {
    if (!socket) return undefined;
    const refresh = () => fetchLobbies();
    socket.emit("join_room", { roomId: DOMINOES_LOBBY_ROOM });
    socket.on(DOMINOES_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId: DOMINOES_LOBBY_ROOM });
      socket.off(DOMINOES_MATCH_UPDATED, refresh);
    };
  }, [socket, fetchLobbies]);

  // With no account there is no poll to finish, so the list must not sit on its
  // loading state forever.
  useEffect(() => {
    if (isSignedIn === false) setLobbiesLoading(false);
  }, [isSignedIn]);

  const myOpenId = useMemo(() => {
    if (!user?.id) return null;
    return lobbies.find((row) => row.player1Id === user.id)?.matchId ?? null;
  }, [lobbies, user?.id]);

  const pokeLobby = useCallback(() => {
    socket?.emit("room_event", {
      roomId: DOMINOES_LOBBY_ROOM,
      event: DOMINOES_MATCH_UPDATED,
    });
  }, [socket]);

  const matchPath = useCallback(
    // The canonical match URL: /games/dominoes/<id> is rewritten to this page by
    // next.config.js (`/games/:slug/:path+` → `/casino/:slug/:path+`), so there is
    // no redirect hop.
    (id: string) => `/games/dominoes/${id}`,
    [],
  );

  /**
   * Ask the server whether the lobby we are waiting in has actually started.
   *
   * The STATUS is the server's, never inferred: `playing` is the only evidence
   * that an opponent took the second seat. A cancelled/finished lobby drops the
   * waiting screen instead of navigating, and a transient failure leaves the wait
   * up so the next tick retries.
   */
  const checkWaitingMatch = useCallback(async () => {
    if (!waitingMatchId) return;
    try {
      const res = await fetch(`/api/dominoes/match/${waitingMatchId}`, {
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
      if (status === MATCH_STATUS.CANCELLED || status === MATCH_STATUS.FINISHED) {
        setWaitingMatchId(null);
        void fetchLobbies();
      }
    } catch {
      // Transient — the interval retries.
    }
  }, [fetchLobbies, matchPath, router, waitingMatchId]);

  // The backstop cadence, plus an immediate check the moment the wait begins.
  useVisiblePoll(checkWaitingMatch, WAITING_POLL_MS, Boolean(waitingMatchId));

  // …and an immediate re-check whenever the lobby list changes. That list is what
  // the joining player's `lobby:updated` poke refreshes, so this is the fast path:
  // whoever clicks Join makes both players leave the waiting screen within a
  // socket round-trip.
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
      const res = await fetch("/api/dominoes/create-or-join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // No body: there is no stake, no seat choice and nothing to declare.
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(data?.error || t("games.dominoes.error_find"));
        return;
      }
      pokeLobby();
      posthog?.capture("dominoes_match_started", {
        mode: data.data?.joined ? "join" : "create",
      });
      if (data.data?.joined) {
        router.push(matchPath(data.data.matchId));
        return;
      }
      setWaitingMatchId(String(data.data.matchId));
    } catch {
      setError(t("games.dominoes.error_find"));
    } finally {
      setBusy(false);
    }
  }, [busy, matchPath, pokeLobby, posthog, router]);

  const cancelLobby = useCallback(
    async (matchId: string) => {
      if (cancelling) return;
      setCancelling(true);
      try {
        await fetch(`/api/dominoes/match/${matchId}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        // Leaving the waiting screen must also end the WAIT — otherwise the poll
        // would keep asking about a lobby the player just closed.
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
    user?.username || user?.firstName || user?.fullName || t("games.dominoes.you");

  const waitingSeats = useMemo(
    () => [
      { label: t("games.dominoes.you"), name: myName, occupied: true },
      { label: t("games.dominoes.opponent"), occupied: false },
    ],
    [myName, t],
  );

  // The rules copy: the four things a new player has to know before the first
  // tile — matching, drawing, passing, and how the round ends.
  // The rules copy: the four things a new player has to know before the first
  // tile — matching, drawing, passing, and how the round ends. Every string is a
  // key under `games.dominoes` (see src/lib/appTextTranslations.js), so the
  // lobby reads in the player's language like the rest of the shared chrome.
  const rules = useMemo(
    () => ({
      title: t("games.dominoes.rules_title"),
      sections: [
        {
          heading: t("games.dominoes.rule_match_title"),
          body: t("games.dominoes.rule_match_body"),
        },
        {
          heading: t("games.dominoes.rule_draw_title"),
          body: t("games.dominoes.rule_draw_body"),
        },
        {
          heading: t("games.dominoes.rule_pass_title"),
          body: t("games.dominoes.rule_pass_body"),
        },
        {
          heading: t("games.dominoes.rule_win_title"),
          body: t("games.dominoes.rule_win_body"),
        },
      ],
    }),
    [t],
  );

  return (
    <>
      <PvpLobbyPage
        title={GAME_NAME}
        subtitle={t("games.dominoes.lobby_subtitle")}
        icon={<span className="text-3xl leading-none">🁫</span>}
        rulesKey="dominoes"
        rules={rules}
        busy={busy}
        onPlay={createOrJoin}
        playLabel={t("games.dominoes.find_match")}
        playBusyLabel={t("games.dominoes.searching")}
        canPlay={Boolean(isSignedIn)}
        myOpenId={myOpenId}
        // Resuming an open lobby lands on the SAME matchmaking screen as creating
        // one: the lobby is still waiting for somebody, so the board is not where
        // the player should end up.
        onResume={(id: string) => setWaitingMatchId(id)}
        onCancel={cancelLobby}
        cancelling={cancelling}
        lobbies={lobbies}
        lobbiesLoading={lobbiesLoading}
        lobbyEmptyText={t("games.dominoes.lobby_empty")}
        lobbyKey={(row: LobbyRow) => row.matchId}
        lobbyTitle={(row: LobbyRow) => (
          <>{t("games.dominoes.lobby_table", { id: String(row.matchId).slice(0, 8) })}</>
        )}
        lobbyMeta={(row: LobbyRow) => (
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{t("games.dominoes.lobby_host", { host: String(row.player1Id).slice(0, 12) })}</span>
            <span>{t("games.dominoes.lobby_meta")}</span>
            <span className="text-emerald-300">{t("games.dominoes.free")}</span>
          </span>
        )}
        onJoin={() => createOrJoin()}
        joinLabel={t("games.dominoes.join")}
        onRefresh={fetchLobbies}
        error={error}
      />

      {/* The matchmaking takeover, held open for as long as the server says the
          lobby is still waiting. Cancel is the only way out — and it closes the
          lobby, so a player is never left owning a table they walked away from. */}
      {waitingMatchId && (
        <MatchWaiting
          state="waiting"
          gameName={GAME_NAME}
          icon={<span className="text-2xl">🁫</span>}
          subtitle={t("games.dominoes.waiting_subtitle")}
          seats={waitingSeats}
          onCancel={() => cancelLobby(waitingMatchId)}
          cancelLabel={t("games.dominoes.cancel_table")}
          cancelling={cancelling}
        />
      )}
    </>
  );
}
