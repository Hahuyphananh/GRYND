"use client";

// src/app/casino/dominoes/[matchId]/PageClient.tsx
//
// The online Dominoes match view.
//
// ── AUTHORITY ─────────────────────────────────────────────────────────────
//
// The server owns the position. The ONLY gameplay request this page ever sends is
// an ACTION plus the version it was shown:
//
//   { action: { type: "play", tile, end } | { type: "draw" } | { type: "pass" },
//     expectedVersion }
//
// No hand, chain, open end, turn owner, deadline, winner, pips total or result is
// ever sent — and none is ever derived locally. What the player sees is the
// server's projection: their own hand, the opponent's tile COUNT, the public
// chain and its open ends, the pile COUNT, `isViewerTurn`, `turnDeadlineAt` and
// the settled `result`/`winnerId`/`resultReason`.
//
// ── THE LIVE LINK IS A HINT, NOT A SOURCE ─────────────────────────────────
//
// The socket room (`dominoes:match:<id>`) carries `lobby:updated` notifications
// from the existing relay. A notification means "something changed, re-read" —
// the board is ONLY ever drawn from the authoritative GET that follows. There is
// NO recurring poll: `useMatchSync` performs exactly one read when the socket
// reconnects and one when the tab becomes visible again, which covers the two
// edges where a push can genuinely have been missed.
//
// ── THE CLOCK ─────────────────────────────────────────────────────────────
//
// `turnDeadlineAt` is the server's instant. The countdown on screen is drawn from
// it (`useTurnCountdown`) purely visually; when it passes, `useDeadlineRead` arms
// ONE bounded read so the SERVER's resolver runs (`applyTimeout`: draw a tile if
// the pile allows, otherwise pass, and finalise if that ends the round). This page
// never draws, passes or forfeits on its own initiative — a late move is refused
// by the server with a 409 and this page simply re-syncs.
//
// ── RECONNECT ─────────────────────────────────────────────────────────────
//
// A reconnect is the same path as a first load: the snapshot is re-read, the
// socket re-joins its room on every `connect` (which is also what cancels the
// realtime server's disconnect-forfeit grace timer for this seat), and the
// server's deal is restored from its columns — never re-shuffled.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { IconAlertTriangle } from "@tabler/icons-react";

import { useSocket } from "../../../../context/SocketProvider";
import { useTranslation } from "../../../../hooks/useTranslation";
import { useMatchSync } from "../../../../hooks/useMatchSync";
import { useTurnCountdown } from "../../../../hooks/useTurnCountdown";
import { useDeadlineRead } from "../../../../hooks/useDeadlineRead";
import MatchLoading from "../../../../components/game/MatchLoading";
import GameSessionHost from "../../../../components/GameSessionHost";
import MatchWaiting from "../../../../components/lobby/MatchWaiting";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import DominoMatchView, {
  type DominoSnapshot,
} from "../../../../components/dominoes/DominoMatchView";
import {
  DOMINOES_MATCH_UPDATED,
  DOMINOES_READY,
  dominoesMatchRoom,
} from "../../../../lib/dominoes/rooms";
import {
  durationSeconds,
  isIncomingSnapshotStale,
  outcomeFor,
  tileLabel,
  type Outcome,
} from "../../../../lib/dominoes/ui";

/**
 * The canonical lobby URL. Bare `/casino/dominoes` 308-redirects to
 * `/games/dominoes`, which is the PUBLIC LANDING page — so the lobby has to be
 * addressed at `/games/dominoes/play`, rewritten (next.config.js `beforeFiles`)
 * to `/casino/dominoes`. That is exactly how every other game's lobby is
 * reached, and it is the URL the landing page's Play CTA uses.
 */
const LOBBY_PATH = "/games/dominoes/play";

/** A logged action, as `GET /api/dominoes/match/<id>` decorates the snapshot. */
type MoveRow = {
  ply?: number;
  playerId?: string;
  action?: string;
  tile?: string | null;
  chainEnd?: string | null;
  timedOut?: boolean;
  createdAt?: string;
};

/** The snapshot plus the route's adornments (seat identity + the move log). */
type Snapshot = DominoSnapshot & {
  matchId?: string;
  player1Id?: string | null;
  player2Id?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  pips?: Record<string, number> | null;
  moves?: MoveRow[];
  timedOut?: boolean;
};

type Action =
  | { type: "play"; tile: string; end?: "left" | "right" }
  | { type: "draw" }
  | { type: "pass" };

export default function DominoesMatchPage() {
  const { t } = useTranslation();
  const params = useParams<{ matchId: string }>();
  const router = useRouter();
  const { socket } = useSocket();
  const shouldReduce = useReducedMotion();

  const matchId = params?.matchId;
  const apiMatch = `/api/dominoes/match/${matchId}`;
  // No sign-in gate on this page: the match routes accept a GUEST practice
  // player (the store authorises by seat), and a signed-out tab with no guest
  // cookie gets the route's own 401, which renders as a normal load error.

  const [match, setMatch] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showResignConfirm, setShowResignConfirm] = useState(false);
  const [resigning, setResigning] = useState(false);
  const [cancellingLobby, setCancellingLobby] = useState(false);
  // True only after a live socket drops, so a deployment with no realtime server
  // never renders a permanent "Reconnecting…" banner.
  const [linkDown, setLinkDown] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const matchRef = useRef<Snapshot | null>(null);

  useEffect(() => {
    matchRef.current = match;
  }, [match]);

  // The App Router reuses this page instance when only `[matchId]` differs, so
  // every piece of per-match state is reset — otherwise the previous match's hand
  // and selection would flash into the new one.
  useEffect(() => {
    setMatch(null);
    setLoadError(null);
    setSelected(null);
    setPending(false);
    setNotice(null);
    setShowResignConfirm(false);
    setResigning(false);
    setCancellingLobby(false);
  }, [matchId]);

  /* ---------------------------------------------------------------------- *
   * Reads (also the reconnect path)
   * ---------------------------------------------------------------------- */

  const fetchSnapshot = useCallback(
    async (signal?: AbortSignal) => {
      if (!matchId) return;
      try {
        const res = await fetch(apiMatch, { cache: "no-store", signal });
        if (signal?.aborted) return;
        const data = await res.json().catch(() => null);
        if (signal?.aborted) return;
        if (!res.ok || !data?.success) {
          setLoadError(data?.error || t("games.dominoes.error_load"));
          return;
        }
        // Several reads can be in flight at once (the mount read, a socket push,
        // a post-move resync, the deadline read). The version is monotonic and a
        // same-version terminal snapshot must never be rolled back.
        setMatch((prev) =>
          isIncomingSnapshotStale(prev, data.data) ? prev : (data.data as Snapshot),
        );
        setLoadError(null);
        // The selection is dropped when it is no longer in the hand the server
        // just sent (it was played, or the hand changed under us).
        setSelected((prev) =>
          prev && Array.isArray(data.data?.hand) && data.data.hand.includes(prev) ? prev : null,
        );
      } catch (error: any) {
        if (error?.name === "AbortError") return;
        // A failed read is not a lost match: the last snapshot stays on screen and
        // the next push / reconnect reads again.
      }
    },
    [apiMatch, matchId, t],
  );

  const refresh = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    void fetchSnapshot(controller.signal);
  }, [fetchSnapshot]);

  useEffect(() => {
    if (!matchId) return undefined;
    refresh();
    return () => abortRef.current?.abort();
  }, [matchId, refresh]);

  /* ---------------------------------------------------------------------- *
   * The live link: one room, notifications only
   * ---------------------------------------------------------------------- */

  useEffect(() => {
    if (!socket || !matchId) return undefined;
    const roomId = dominoesMatchRoom(matchId);

    const join = () => socket.emit("join_room", { roomId });
    join();
    // Socket.IO does not restore room membership across a reconnect, so re-join
    // on every `connect` — which is also what cancels the realtime server's
    // disconnect-forfeit grace timer for this seat.
    socket.on("connect", join);

    // A notification is an invalidation hint. The board is redrawn from the read
    // it triggers, never from the payload.
    const onUpdate = () => refresh();
    socket.on(DOMINOES_MATCH_UPDATED, onUpdate);

    // `linkDown` is ONLY set by an actual disconnect. It used to be seeded from
    // `socket.connected` at mount time, which is false for the second or two a
    // fresh handshake takes — and the board treated it as "reconnecting", so a
    // match could open with every control frozen. A missing live link is anyway
    // only a loss of freshness (every read and action is HTTP), never a reason
    // to stop the player playing.
    const onConnect = () => setLinkDown(false);
    const onDisconnect = () => setLinkDown(true);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);

    return () => {
      socket.off("connect", join);
      socket.off(DOMINOES_MATCH_UPDATED, onUpdate);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.emit("leave_room", { roomId });
    };
  }, [socket, matchId, refresh]);

  const status = String(match?.status ?? "");
  const ended = status === "finished" || status === "cancelled";
  const viewerSeat = match?.viewerSeat ?? null;

  // Exactly one read on socket reconnect and one when the tab becomes visible
  // again. There is no interval anywhere in this page.
  useMatchSync(refresh, socket, Boolean(matchId) && Boolean(match) && !ended);

  /* ---------------------------------------------------------------------- *
   * The clock (visual) + the bounded deadline read (server resolution)
   * ---------------------------------------------------------------------- */

  const isLive = Boolean(match?.isLive) && !ended;
  const nowMs = useTurnCountdown(isLive ? match?.turnDeadlineAt ?? null : null);

  // When the stamped instant passes, the SERVER resolves the turn. One bounded
  // read brings that back; the page never acts for the seat.
  useDeadlineRead(isLive ? match?.turnDeadlineAt ?? null : null, refresh);

  /* ---------------------------------------------------------------------- *
   * Submission
   * ---------------------------------------------------------------------- */

  const adoptAuthoritative = useCallback(
    (snapshot: any) => {
      if (!snapshot) return;
      setMatch((prev) => ({ ...(prev ?? {}), ...(snapshot as Snapshot) }));
      setPending(false);
      setSelected(null);
      // A bare poke so the opponent's notification fires in a socket round-trip.
      // It carries the match id and nothing else.
      socket?.emit(DOMINOES_READY, { matchId });
      // …and one read to pick up the GET-only adornments (seat identity, the log).
      refresh();
    },
    [matchId, refresh, socket],
  );

  const submit = useCallback(
    async (action: Action) => {
      const current = matchRef.current;
      if (!current || pending) return;
      if (String(current.status) !== "playing" || !current.isViewerTurn) {
        setNotice(t("games.dominoes.notice_not_turn"));
        return;
      }
      const expectedVersion = current.version;
      setPending(true);
      setNotice(null);
      try {
        const res = await fetch(`${apiMatch}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The whole request. No hand, no chain, no winner.
          body: JSON.stringify({ action, expectedVersion }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          // Refused (stale tab, wrong turn, a late action, a replayed ply, an
          // action the engine forbids) — drop the pending state and resync
          // instead of guessing at the outcome.
          setPending(false);
          setNotice(data?.error || t("games.dominoes.notice_refused"));
          refresh();
          return;
        }
        adoptAuthoritative(data.data?.match);
        if (data.data?.matchCompleted) {
          setNotice(null);
        }
      } catch {
        setPending(false);
        setNotice(t("games.dominoes.notice_send_failed"));
        refresh();
      }
    },
    [adoptAuthoritative, apiMatch, pending, refresh, t],
  );

  const handlePlay = useCallback(
    (tile: string, end?: "left" | "right") => {
      void submit(end ? { type: "play", tile, end } : { type: "play", tile });
    },
    [submit],
  );

  const handleDraw = useCallback(() => {
    void submit({ type: "draw" });
  }, [submit]);

  const handlePass = useCallback(() => {
    void submit({ type: "pass" });
  }, [submit]);

  const forfeit = useCallback(async () => {
    if (resigning) return;
    setShowResignConfirm(false);
    setResigning(true);
    try {
      const res = await fetch(`${apiMatch}/forfeit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => null);
      if (data?.success) adoptAuthoritative(data.data?.match);
      else refresh();
    } catch {
      refresh();
    } finally {
      setResigning(false);
    }
  }, [adoptAuthoritative, apiMatch, refresh, resigning]);

  const cancelLobby = useCallback(async () => {
    setShowResignConfirm(false);
    setCancellingLobby(true);
    try {
      await fetch(`${apiMatch}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      refresh();
    } catch {
      refresh();
    } finally {
      setCancellingLobby(false);
    }
  }, [apiMatch, refresh]);

  /* ---------------------------------------------------------------------- *
   * Derived view model
   * ---------------------------------------------------------------------- */

  const outcome = outcomeFor({
    result: match?.result,
    winnerId: match?.winnerId,
    viewerSeat,
    // The server's own ids for the seats; Clerk is only a fallback.
    userId:
      viewerSeat === "player1"
        ? (match?.player1Id ?? null)
        : viewerSeat === "player2"
          ? (match?.player2Id ?? null)
          : null,
  });

  const opponentSeat = match?.opponentSeat ?? null;
  const opponentIdentity = opponentSeat ? (match?.players?.[opponentSeat] ?? null) : null;
  // A practice opponent is the bot, named as such — it has no `users` row, so the
  // seat-identity resolver returns null for it.
  const opponentName = match?.isAi
    ? t("games.dominoes.ai_opponent")
    : opponentIdentity?.name || t("games.dominoes.opponent");

  const moves = useMemo<MoveRow[]>(
    () => (Array.isArray(match?.moves) ? (match?.moves as MoveRow[]) : []),
    [match?.moves],
  );

  /**
   * The action log, in the player's language. A played tile is public (it is on
   * the table), so naming it here leaks nothing; a draw names no tile, and the
   * clock's own actions are marked as such.
   */
  const actionLabel = (row: MoveRow): string => {
    const side = t(
      row.chainEnd === "right"
        ? "games.dominoes.side_right"
        : "games.dominoes.side_left",
    );
    const timedOut = row.timedOut === true;
    if (row.action === "play") {
      return t(
        timedOut ? "games.dominoes.log_play_clock" : "games.dominoes.log_play",
        { tile: tileLabel(row.tile), side },
      );
    }
    if (row.action === "draw") {
      return t(timedOut ? "games.dominoes.log_draw_clock" : "games.dominoes.log_draw");
    }
    if (row.action === "pass") {
      return t(timedOut ? "games.dominoes.log_pass_clock" : "games.dominoes.log_pass");
    }
    return "—";
  };

  /** Why the round ended, as a sentence in the player's language. */
  const reasonText = (verdict: Outcome | null): string => {
    switch (String(match?.resultReason ?? "")) {
      case "emptied-hand":
        return t(
          verdict === "win"
            ? "games.dominoes.reason_emptied_win"
            : "games.dominoes.reason_emptied_loss",
        );
      case "blocked-pips":
        return t(
          verdict === "draw"
            ? "games.dominoes.reason_blocked_draw"
            : verdict === "win"
              ? "games.dominoes.reason_blocked_win"
              : "games.dominoes.reason_blocked_loss",
        );
      case "resigned":
        return t(
          verdict === "win"
            ? "games.dominoes.reason_resigned_win"
            : "games.dominoes.reason_resigned_loss",
        );
      case "abandoned":
        return t(
          verdict === "win"
            ? "games.dominoes.reason_abandoned_win"
            : "games.dominoes.reason_abandoned_loss",
        );
      case "timed-out":
        return t("games.dominoes.reason_timed_out");
      default:
        return t(
          verdict === "win"
            ? "games.dominoes.reason_win"
            : verdict === "loss"
              ? "games.dominoes.reason_loss"
              : "games.dominoes.reason_complete",
        );
    }
  };

  const waiting = status === "waiting";
  const finished = status === "finished";
  const cancelled = status === "cancelled";

  /* ---------------------------------------------------------------------- *
   * Render
   * ---------------------------------------------------------------------- */

  if (!match && !loadError) {
    return (
      <MatchLoading
        label={t("games.dominoes.loading_match")}
        currentPath={LOBBY_PATH}
      />
    );
  }

  if (!match && loadError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gradient-to-b from-[#0d1226] to-[#04060f] px-6 text-center text-white">
        <IconAlertTriangle className="h-8 w-8 text-amber-300" aria-hidden="true" />
        <p className="text-sm text-white/80">{loadError}</p>
        <button
          type="button"
          onClick={() => router.push(LOBBY_PATH)}
          className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-black"
        >
          {t("games.dominoes.back_to_game")}
        </button>
      </div>
    );
  }

  return (
    <>
      {waiting && (
        <MatchWaiting
          state="waiting"
          gameName={t("games.dominoes_name")}
          icon={<span className="text-2xl">🁫</span>}
          subtitle={t("games.dominoes.match_waiting_subtitle")}
          seats={[
            {
              label: t("games.dominoes.you"),
              name:
                match?.players?.[viewerSeat ?? "player1"]?.name ||
                t("games.dominoes.you"),
              occupied: true,
              wager: t("games.dominoes.free"),
            },
            { label: t("games.dominoes.opponent"), occupied: false },
          ]}
          onCancel={viewerSeat === "player1" ? cancelLobby : null}
          cancelLabel={t("games.dominoes.cancel_match")}
          cancelling={cancellingLobby}
        />
      )}

      {/* Presence and "recently played" come from the SHARED host, driven by the
          server's own status: a waiting lobby is not a game yet, and a settled
          match must stop counting immediately. */}
      <GameSessionHost
        autoStart={status === "playing"}
        autoStop={finished}
        gameLabel="dominoes"
      >
      <div
        data-testid="dominoes-match"
        data-status={status}
        data-viewer-seat={viewerSeat ?? ""}
        className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001628] to-[#03040c] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8"
      >
        <div className="mx-auto max-w-4xl">
          {/* ── Header ─────────────────────────────────────────────────── */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="logo-text flex items-center gap-2 text-2xl font-black uppercase tracking-[0.08em] text-[#7cefff] drop-shadow-[0_0_16px_rgba(0,229,255,0.45)] sm:text-3xl">
                {t("games.dominoes_name")}
              </h1>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-widest text-white/55">
                <span>{t("games.dominoes.subtitle")}</span>
                <span className="rounded-full border border-emerald-400/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold tracking-wider text-emerald-200">
                  {t("games.dominoes.free")}
                </span>
              </p>
            </div>
            <span
              className="rounded-full border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-cyan-200"
              data-testid="match-status"
            >
              {status === "playing" ? t("games.dominoes.status_playing") : null}
              {finished ? t("games.dominoes.status_finished") : null}
              {cancelled ? t("games.dominoes.status_cancelled") : null}
              {waiting ? t("games.dominoes.status_waiting") : null}
              {!status ? t("games.dominoes.status_loading") : null}
            </span>
          </div>

          {!waiting && !cancelled ? (
            <DominoMatchView
              snapshot={match}
              nowMs={nowMs}
              selected={selected}
              onSelect={setSelected}
              onPlay={handlePlay}
              onDraw={handleDraw}
              onPass={handlePass}
              onResign={() => setShowResignConfirm(true)}
              pending={pending}
              notice={notice}
              reconnecting={linkDown}
            />
          ) : null}

          {cancelled ? (
            <p className="mt-6 text-center text-sm text-white/60" data-testid="dominoes-cancelled">
              {t("games.dominoes.cancelled_closed")}
            </p>
          ) : null}

          {moves.length > 0 ? (
            <div
              className="mt-3 rounded-2xl border border-white/10 bg-white/5 p-3"
              data-testid="dominoes-move-log"
            >
              <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-white/60">
                {t("games.dominoes.move_log_title")}
              </h2>
              <ol className="flex flex-col gap-1 text-[11px] text-white/70">
                {moves
                  .slice(-8)
                  .reverse()
                  .map((row, index) => (
                    <li
                      key={`${row.ply ?? index}-${row.createdAt ?? ""}`}
                      className="flex items-start justify-between gap-2"
                    >
                      <span className="text-white/40">#{Number(row.ply ?? 0) + 1}</span>
                      <span className="flex-1 text-right">
                        <span className="mr-1 font-semibold text-cyan-200">
                          {row.playerId === match?.player1Id
                            ? t("games.dominoes.player_1")
                            : t("games.dominoes.player_2")}
                        </span>
                        {actionLabel(row)}
                      </span>
                    </li>
                  ))}
              </ol>
            </div>
          ) : null}
        </div>

        {/* ── Resign confirmation ──────────────────────────────────────── */}
        <AnimatePresence>
          {showResignConfirm && (
            <motion.div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
              initial={shouldReduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={shouldReduce ? undefined : { opacity: 0 }}
              onClick={() => setShowResignConfirm(false)}
            >
              <motion.div
                className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0b1226] p-5 text-white"
                initial={shouldReduce ? false : { scale: 0.94, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={shouldReduce ? undefined : { scale: 0.96, opacity: 0 }}
                onClick={(event) => event.stopPropagation()}
              >
                <h2 className="text-lg font-bold">{t("games.dominoes.resign_title")}</h2>
                <p className="mt-2 text-sm text-white/70">
                  {t("games.dominoes.resign_body")}
                </p>
                <div className="mt-5 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShowResignConfirm(false)}
                    className="flex-1 rounded-xl bg-white/10 py-2.5 text-sm font-bold hover:bg-white/20"
                  >
                    {t("games.dominoes.keep_playing")}
                  </button>
                  <button
                    type="button"
                    data-testid="confirm-forfeit"
                    onClick={forfeit}
                    disabled={resigning}
                    className="flex-1 rounded-xl bg-red-500 py-2.5 text-sm font-bold text-black disabled:opacity-60"
                  >
                    {resigning
                      ? t("games.dominoes.resigning")
                      : t("games.dominoes.resign")}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Result: the server's verdict, never a local one ──────────── */}
        <PvpResultScreen
          open={finished}
          outcome={outcome ?? "loss"}
          headline={
            outcome === "win"
              ? t("games.dominoes.result_won")
              : outcome === "draw"
                ? t("games.dominoes.result_drawn")
                : t("games.dominoes.result_lost")
          }
          subline={reasonText(outcome)}
          gameName={t("games.dominoes_name")}
          durationSeconds={durationSeconds(match?.startedAt, match?.endedAt)}
          opponent={{
            name: opponentName,
            iconKey: opponentIdentity?.iconKey ?? null,
            profileFrame: opponentIdentity?.profileFrame ?? null,
          }}
          summary={[
            {
              label: t("games.dominoes.result_label"),
              value:
                outcome === "win"
                  ? t("games.dominoes.result_win")
                  : outcome === "draw"
                    ? t("games.dominoes.result_draw")
                    : outcome === "loss"
                      ? t("games.dominoes.result_loss")
                      : "—",
            },
            {
              label: t("games.dominoes.your_tiles_left"),
              value: t(
                Number(match?.hand?.length ?? 0) === 1
                  ? "games.dominoes.tiles_count_one"
                  : "games.dominoes.tiles_count",
                { count: Number(match?.hand?.length ?? 0) },
              ),
            },
            {
              label: t("games.dominoes.opponent_tiles_left"),
              value: t(
                Number(match?.opponentTileCount ?? 0) === 1
                  ? "games.dominoes.tiles_count_one"
                  : "games.dominoes.tiles_count",
                { count: Number(match?.opponentTileCount ?? 0) },
              ),
            },
            {
              label: t("games.dominoes.actions_played"),
              value: String(Number(match?.ply ?? 0)),
            },
          ]}
          details={[
            { label: t("games.dominoes.match_id"), value: String(matchId) },
            {
              label: t("games.dominoes.reason"),
              value: reasonText(outcome),
            },
            ...moves.map((row) => ({
              label: t("games.dominoes.action_n", { n: Number(row.ply ?? 0) + 1 }),
              value: `${row.playerId === match?.player1Id ? t("games.dominoes.player_1") : t("games.dominoes.player_2")} — ${actionLabel(row)}`,
            })),
          ]}
        />
      </div>
      </GameSessionHost>
    </>
  );
}
