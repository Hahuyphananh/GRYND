"use client";

// src/app/casino/tic-tac-toe/[matchId]/PageClient.tsx
//
// The Tic-Tac-Toe Duel match view.
//
// ── AUTHORITY ─────────────────────────────────────────────────────────────
//
// The server owns the board. The ONLY thing this page ever sends is
// `{ cellIndex, expectedVersion }` — never a mark, a board, a winner, a result
// or a turn. The board it renders is the one in the snapshot, the winning line
// it highlights is the snapshot's, and the result screen is driven by the
// snapshot's `result` / `winnerId`, so a forfeited match (where the board holds
// no winning line at all) still reports the correct winner.
//
// Optimism is limited to FEEDBACK: clicking an empty cell paints a translucent
// "pending" mark until the next authoritative snapshot replaces it. A rejected
// move drops the ghost and resyncs — the local view is never allowed to drift
// from the server, and it never decides that a match is over.
//
// ── FLOW ──────────────────────────────────────────────────────────────────
//
//   poll GET /api/tic-tac-toe/match/<id>  (adaptive interval, aborted on push)
//   socket `lobby:updated` on `tic-tac-toe:match:<id>` → immediate refetch
//   click an offered cell → POST /move → adopt the returned authoritative
//   snapshot → emit `tic-tac-toe:ready` so the opponent refreshes in ~50 ms
//   waiting/ready → MatchWaiting · finished → the shared PvpResultScreen
//
// There is no clock, no countdown and no animation timeline: a tic-tac-toe turn
// is one discrete, instantly-resolved move.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import {
  IconAlertTriangle,
  IconDoorExit,
  IconFlag,
  IconTicTac,
} from "@tabler/icons-react";

import { useSocket } from "../../../../context/SocketProvider";
import EmotePicker, { EmoteBubble } from "../../../../components/game/EmotePicker";
import useGameEmotes from "../../../../hooks/useGameEmotes";
import TicTacToeBoard from "../../../../components/tic-tac-toe/TicTacToeBoard";
import SeatAvatar from "../../../../components/game/SeatAvatar";
import MatchLoading from "../../../../components/game/MatchLoading";
import MatchWaiting from "../../../../components/lobby/MatchWaiting";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import ReportModal from "../../../../components/ReportModal";
import GameSessionHost from "../../../../components/GameSessionHost";
import {
  TIC_TAC_TOE_MATCH_UPDATED,
  TIC_TAC_TOE_READY,
  ticTacToeMatchRoom,
} from "../../../../lib/tic-tac-toe/rooms";
import { CELL_COUNT } from "../../../../lib/tic-tac-toe/constants";
import {
  durationSeconds,
  isCellPlayable,
  isIncomingSnapshotStale,
  markForSeat,
  outcomeFor,
  progressLabel,
  seatColor,
  seatLabel,
  seatForMark,
  statusLabel,
  turnLabel,
  viewerMarkLabel,
} from "../../../../lib/tic-tac-toe/ui";
import type { Seat } from "../../../../lib/tic-tac-toe/types";

const ACTIVE_POLL_MS = 1800;
const IDLE_POLL_MS = 5000;

/** "Row 2 · Col 3" — the board cell a logged move landed on. */
function moveCellLabel(cellIndex: unknown): string {
  const index = Number(cellIndex);
  if (!Number.isInteger(index) || index < 0 || index >= CELL_COUNT) return "—";
  return `Row ${Math.floor(index / 3) + 1} · Col ${(index % 3) + 1}`;
}

type PendingMove = { cell: number; version: number };

export default function TicTacToeMatchPage() {
  const params = useParams<{ matchId: string }>();
  const router = useRouter();
  const { socket } = useSocket();
  const { user } = useUser();
  const matchId = params?.matchId;
  const apiMatch = `/api/tic-tac-toe/match/${matchId}`;

  const [match, setMatch] = useState<any>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Optimistic FEEDBACK only (see the header note): the cell the viewer just
  // clicked, kept until an authoritative snapshot moves past that version.
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForfeitConfirm, setShowForfeitConfirm] = useState(false);
  const [forfeiting, setForfeiting] = useState(false);
  const [cancellingLobby, setCancellingLobby] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const matchRef = useRef<any>(null);

  useEffect(() => {
    matchRef.current = match;
  }, [match]);

  // The App Router reuses this page instance when only `[matchId]` differs, so
  // every piece of per-match state is reset, otherwise the previous match's
  // board and pending ghost would flash into the new one.
  useEffect(() => {
    setMatch(null);
    setLoadError(null);
    setPending(null);
    setSubmitting(false);
    setShowForfeitConfirm(false);
    setForfeiting(false);
    setShowReportModal(false);
  }, [matchId]);

  // ── Fetching ──────────────────────────────────────────────────────────
  const fetchSnapshot = useCallback(
    async (signal?: AbortSignal) => {
      if (!matchId) return;
      try {
        const res = await fetch(apiMatch, { cache: "no-store", signal });
        if (signal?.aborted) return;
        const data = await res.json().catch(() => null);
        if (signal?.aborted) return;
        if (!res.ok || !data?.success) {
          setLoadError(data?.error || "Unable to load this match");
          return;
        }
        // Several refreshes (poll, socket push, post-move resync) can be in
        // flight at once; `version` is monotonic, and a same-version terminal
        // snapshot (forfeit/cancel) can never be rolled back.
        setMatch((prev: any) =>
          isIncomingSnapshotStale(prev, data.data) ? prev : data.data,
        );
        // The optimistic ghost survives only until the server has moved past
        // the version it was submitted against.
        setPending((prev) =>
          prev && Number(data.data?.version) > prev.version ? null : prev,
        );
        setLoadError(null);
      } catch (error: any) {
        if (error?.name === "AbortError") return;
      }
    },
    [apiMatch, matchId],
  );

  const refresh = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    void fetchSnapshot(controller.signal);
  }, [fetchSnapshot]);

  useEffect(() => {
    if (!matchId) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = () => {
      if (cancelled) return;
      refresh();
      const idle =
        matchRef.current?.status === "finished" ||
        matchRef.current?.status === "cancelled";
      timer = setTimeout(tick, idle ? IDLE_POLL_MS : ACTIVE_POLL_MS);
    };
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [matchId, refresh]);

  // ── Realtime sync ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket || !matchId) return undefined;
    const roomId = ticTacToeMatchRoom(matchId);
    const join = () => socket.emit("join_room", { roomId });
    join();
    // Socket.IO does not restore room membership across a reconnect, so re-join
    // on every connect — that is also what cancels the server's
    // disconnect-forfeit timer for this seat.
    socket.on("connect", join);

    const onUpdate = () => refresh();
    socket.on(TIC_TAC_TOE_MATCH_UPDATED, onUpdate);

    return () => {
      socket.off("connect", join);
      socket.off(TIC_TAC_TOE_MATCH_UPDATED, onUpdate);
      socket.emit("leave_room", { roomId });
    };
  }, [socket, matchId, refresh]);

  // ── Derived view model ────────────────────────────────────────────────
  const viewerSeat: Seat | null = match?.viewerSeat ?? null;
  const opponentSeat: Seat | null = viewerSeat
    ? viewerSeat === "player1"
      ? "player2"
      : "player1"
    : null;
  const viewerMark = markForSeat(viewerSeat);
  const opponentMark = markForSeat(opponentSeat);
  const finished = match?.status === "finished";
  const cancelled = match?.status === "cancelled";
  const isViewerTurn = Boolean(match?.isViewerTurn);

  // The server's own gate, narrowed only by "a request is in flight" and
  // "the match is over" — this page never invents a third condition.
  const boardUnlocked =
    Boolean(match) &&
    !finished &&
    !cancelled &&
    !submitting &&
    Boolean(match?.viewerCanMove);

  const seats = useMemo(() => {
    const players = match?.players ?? {};
    const identityFor = (seat: Seat | null) => (seat ? players?.[seat] ?? null : null);
    return { viewer: identityFor(viewerSeat), opponent: identityFor(opponentSeat) };
  }, [match?.players, viewerSeat, opponentSeat]);

  const opponentName =
    seats.opponent?.name || (opponentSeat ? seatLabel(opponentSeat, viewerSeat) : "Opponent");
  const opponentId =
    opponentSeat === "player1" ? match?.player1Id : match?.player2Id;

  const moves = Array.isArray(match?.moves) ? match.moves : [];
  const outcome = outcomeFor({
    result: match?.result,
    winnerId: match?.winnerId,
    viewerSeat,
    userId: user?.id,
  });

  const canCancelLobby = match?.status === "waiting" && viewerSeat === "player1";

  // ── Actions ───────────────────────────────────────────────────────────
  // Adopt the server's authoritative core state from a POST response WITHOUT
  // discarding the GET-only adornments (`players`, the move log, the
  // timestamps) that a move/forfeit response does not carry — then resync so
  // those adornments are re-derived server-side. The board, the turn, the
  // status and the outcome still come ONLY from the response; the merge never
  // invents state, it just preserves what the response omitted.
  const adoptAuthoritative = useCallback(
    (snapshot: any) => {
      setMatch((prev: any) => ({ ...(prev ?? {}), ...(snapshot ?? {}) }));
      setPending(null);
      // A bare invalidation nudge: the opponent refetches, and nothing about
      // the match is carried in it.
      socket?.emit(TIC_TAC_TOE_READY, { matchId });
      refresh();
    },
    [refresh, socket, matchId],
  );

  // The ONLY way a move is ever requested. It first re-checks the cell against
  // the snapshot the viewer is looking at, so a click on an occupied cell, or a
  // click outside the viewer's turn, is a no-op here as well as server-side.
  const submitMove = useCallback(
    async (cellIndex: number) => {
      const current = matchRef.current;
      if (!current || submitting) return;
      if (
        !isCellPlayable({
          board: current.board,
          cellIndex,
          viewerCanMove: Boolean(current.viewerCanMove),
        })
      ) {
        return;
      }
      const expectedVersion = current.version;

      setSubmitting(true);
      setPending({ cell: cellIndex, version: Number(expectedVersion) || 0 });
      setLoadError(null);
      try {
        const res = await fetch(`${apiMatch}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The whole request. No mark, no board, no result.
          body: JSON.stringify({ cellIndex, expectedVersion }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          // Rejected (stale tab, wrong turn, occupied cell) — drop the ghost
          // and resync rather than guessing what happened.
          setPending(null);
          setLoadError(data?.error || "Move rejected");
          refresh();
          return;
        }
        adoptAuthoritative(data.data.match);
      } catch {
        setPending(null);
        setLoadError("Move failed — retrying");
        refresh();
      } finally {
        setSubmitting(false);
      }
    },
    [adoptAuthoritative, apiMatch, matchId, refresh, submitting],
  );

  const forfeit = useCallback(async () => {
    if (!match || forfeiting) return;
    setShowForfeitConfirm(false);
    setForfeiting(true);
    try {
      const res = await fetch(`${apiMatch}/forfeit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => null);
      if (data?.success) {
        adoptAuthoritative(data.data.match);
      } else {
        refresh();
      }
    } finally {
      setForfeiting(false);
    }
  }, [match, forfeiting, apiMatch, refresh, adoptAuthoritative]);

  const cancelLobby = useCallback(async () => {
    setShowForfeitConfirm(false);
    setCancellingLobby(true);
    try {
      await fetch(`${apiMatch}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      refresh();
    } finally {
      setCancellingLobby(false);
    }
  }, [apiMatch, refresh]);

  const { incomingEmote, myEmote, sendEmote } = useGameEmotes({
    socket,
    roomId: matchId ? ticTacToeMatchRoom(matchId) : null,
    eventName: "tic-tac-toe:emote",
    selfId: viewerSeat,
  });

  const turnCopy = turnLabel({
    status: match?.status,
    moved: Boolean(match),
    isViewerTurn,
    isAi: Boolean(match?.isAi),
  });

  // ── Render ────────────────────────────────────────────────────────────
  if (!match && !loadError) {
    // Branded shell WITH the nav bar (this gate used to drop it entirely).
    return <MatchLoading label="Loading Tic-Tac-Toe…" currentPath="/casino/tic-tac-toe" />;
  }

  if (!match && loadError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gradient-to-b from-[#0d1226] to-[#04060f] px-6 text-center text-white">
        <IconAlertTriangle className="h-8 w-8 text-amber-300" />
        <p className="text-sm text-white/80">{loadError}</p>
        <button
          onClick={() => router.push("/casino/tic-tac-toe")}
          className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-black"
        >
          Back to Tic-Tac-Toe
        </button>
      </div>
    );
  }

  return (
    <>
      {(match.status === "waiting" || match.status === "ready") && (
        <MatchWaiting
          state={match.status === "ready" ? "ready" : "waiting"}
          gameName="Tic-Tac-Toe"
          icon={<IconTicTac className="h-8 w-8 text-amber-400" />}
          subtitle={
            match.status === "ready"
              ? "Opponent found — X opens…"
              : "Waiting for an opponent to join your Tic-Tac-Toe table…"
          }
          seats={[
            {
              label: "You",
              name: seats.viewer?.name || "You",
              occupied: true,
              wager: "Free ranked",
            },
            match.status === "ready"
              ? {
                  label: "Opponent",
                  name: opponentName,
                  occupied: true,
                  wager: "Free ranked",
                }
              : { label: "Opponent", occupied: false },
          ]}
          onCancel={canCancelLobby ? cancelLobby : null}
          cancelLabel="Cancel match"
          cancelling={cancellingLobby}
        />
      )}

      <GameSessionHost
        autoStart={match.status === "playing"}
        autoStop={finished || cancelled}
        gameLabel="tic-tac-toe"
      >
        <div
          data-testid="tic-tac-toe-match"
          data-status={match.status}
          className="min-h-screen overflow-x-clip bg-gradient-to-b from-[#0d1226] via-[#080d1c] to-[#04060f] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8"
        >
          <div className="mx-auto max-w-5xl">
            {/* ── Header ────────────────────────────────────────────── */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-amber-200 via-amber-300 to-yellow-200 sm:text-3xl">
                  <IconTicTac className="h-7 w-7 text-amber-400" />
                  Tic-Tac-Toe
                </h1>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-widest text-amber-200/70">
                  <span>3×3 · three in a row</span>
                  <span className="rounded-full border border-emerald-400/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold tracking-wider text-emerald-200">
                    Free · rated 1v1
                  </span>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  data-testid="match-status"
                  className="rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-amber-200"
                >
                  {statusLabel(match.status)}
                </span>
                <button
                  onClick={() => router.push("/casino/tic-tac-toe")}
                  className="rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-white/20"
                >
                  Lobby
                </button>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
              {/* ── Board column ───────────────────────────────────── */}
              <div className="rounded-2xl border border-amber-500/20 bg-black/40 p-3 shadow-[0_0_30px_rgba(251,191,36,0.10)] sm:p-4">
                {/* Seat cards: who is who, and which mark they hold. */}
                <div className="mb-3 grid grid-cols-2 gap-2">
                  {(["player1", "player2"] as Seat[]).map((seat) => {
                    const identity =
                      seat === "player1" ? match.players?.player1 : match.players?.player2;
                    const isViewer = seat === viewerSeat;
                    const isActive = match.currentTurn === seat && !finished && !cancelled;
                    const mark = markForSeat(seat);
                    const name = identity?.name || seatLabel(seat, viewerSeat);
                    const moveCount = moves.filter(
                      (mv: any) =>
                        mv.playerId ===
                        (seat === "player1" ? match.player1Id : match.player2Id),
                    ).length;
                    return (
                      <div
                        key={seat}
                        data-testid={`seat-${seat}`}
                        data-active={isActive ? "true" : "false"}
                        className={`rounded-xl border p-2.5 transition ${
                          isActive
                            ? "border-amber-400/60 bg-amber-500/10"
                            : "border-white/10 bg-white/5"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="relative inline-flex shrink-0">
                            <SeatAvatar
                              iconKey={identity?.iconKey ?? null}
                              profileFrame={identity?.profileFrame ?? null}
                              name={name}
                              isAi={Boolean(match.isAi) && !isViewer}
                              size="h-7 w-7"
                            />
                            {/* The seat's mark rides the avatar's corner: the
                                face says WHO, the badge says which mark they
                                hold — one chip, no extra column. */}
                            <span
                              aria-hidden="true"
                              className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border bg-[#0b0f1c] text-[9px] font-black leading-none"
                              style={{ borderColor: seatColor(seat), color: seatColor(seat) }}
                            >
                              {mark}
                            </span>
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-xs font-bold">
                              {name}
                              {isViewer && <span className="ml-1 text-amber-300">· you</span>}
                            </p>
                            <p className="text-[10px] uppercase tracking-wider text-white/45">
                              {mark} · {moveCount} {moveCount === 1 ? "move" : "moves"}
                            </p>
                          </div>
                          <EmoteBubble
                            emote={isViewer ? myEmote : incomingEmote}
                            side={isViewer ? "mine" : "incoming"}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Turn / status banner */}
                <div
                  data-testid="turn-status"
                  className={`mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm ${
                    boardUnlocked
                      ? "border-amber-400/50 bg-amber-500/10 text-amber-100"
                      : "border-white/10 bg-white/5 text-white/65"
                  }`}
                >
                  <span className="inline-flex items-center gap-2 font-semibold">
                    <span
                      aria-hidden="true"
                      className={`inline-block h-2.5 w-2.5 rounded-full ${
                        boardUnlocked ? "animate-pulse bg-amber-400" : "bg-white/30"
                      }`}
                    />
                    {turnCopy}
                  </span>
                  <span className="text-[11px] uppercase tracking-wider text-white/45">
                    {viewerMarkLabel(viewerSeat)} · {progressLabel(match.board)}
                  </span>
                </div>

                {/* The board. Cells are offered only when the snapshot says so. */}
                <div className="mx-auto w-full max-w-[min(78vw,420px)]">
                  <TicTacToeBoard
                    board={match.board}
                    winningLine={match.winningLine}
                    lastMove={match.lastMove}
                    viewerSeat={viewerSeat}
                    viewerCanMove={boardUnlocked}
                    busy={submitting}
                    pendingCell={pending?.cell ?? null}
                    onPlay={(cellIndex) => void submitMove(cellIndex)}
                  />
                </div>

                {/* Controls */}
                <div className="mt-3 rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-white/60">
                      {submitting
                        ? "Sending your move…"
                        : finished || cancelled
                          ? "Match over"
                          : boardUnlocked
                            ? "Your turn — click any empty cell."
                            : "Waiting for your opponent's move…"}
                    </span>
                    {!finished && !cancelled && match.status === "playing" && (
                      <button
                        data-testid="forfeit-button"
                        onClick={() => setShowForfeitConfirm(true)}
                        className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm font-bold text-red-300 transition hover:bg-red-500/20"
                      >
                        <span className="inline-flex items-center gap-1">
                          <IconDoorExit size={14} /> Forfeit
                        </span>
                      </button>
                    )}
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-white/45">
                    {boardUnlocked
                      ? "Every click is verified by the server: it decides the mark, the turn and the winner. Empty cells are outlined — occupied cells and out-of-turn clicks do nothing."
                      : "The board is the server's. A cell is only playable on your turn, and the winner is decided by the server once a line is complete."}
                  </p>
                  {loadError && (
                    <p className="mt-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                      {loadError}
                    </p>
                  )}
                </div>
              </div>

              {/* ── Sidebar ────────────────────────────────────────── */}
              <aside className="space-y-3">
                <section className="rounded-2xl border border-amber-500/20 bg-black/40 p-4">
                  <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-amber-300">
                    Match
                  </h2>
                  <div className="space-y-1.5 text-xs">
                    <Row label="Status" value={statusLabel(match.status)} />
                    <Row label="Your mark" value={viewerMark ?? "—"} />
                    <Row label="Opponent" value={opponentName} />
                    <Row label="Opponent's mark" value={opponentMark ?? "—"} />
                    <Row label="Moves played" value={`${Number(match.ply) || 0} of ${CELL_COUNT}`} />
                    <Row
                      label="Turn"
                      value={
                        finished || cancelled
                          ? "—"
                          : isViewerTurn
                            ? "Your turn"
                            : `${opponentName}'s turn`
                      }
                    />
                    {match.winner && (
                      <Row label="Winner" value={match.winner === viewerSeat ? "You" : opponentName} />
                    )}
                  </div>
                </section>

                <section className="rounded-2xl border border-amber-500/20 bg-black/40 p-4">
                  <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-amber-300">
                    Move history
                  </h2>
                  {moves.length === 0 ? (
                    <p className="text-xs text-white/50">
                      No moves yet — X opens the match.
                    </p>
                  ) : (
                    <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                      {moves.map((mv: any, index: number) => {
                        const mark =
                          mv.playerId === match.player1Id ? "X" : "O";
                        const seat = seatForMark(mark);
                        const isLastMove = index === moves.length - 1;
                        return (
                          <div
                            key={`${mv.ply}-${mv.cellIndex}`}
                            className={`flex items-center justify-between rounded-lg border px-2 py-1.5 text-xs ${
                              isLastMove
                                ? "border-amber-400/40 bg-amber-500/10"
                                : "border-white/10 bg-white/5"
                            }`}
                          >
                            <span className="font-semibold text-white/70">
                              Move {Number(mv.ply) + 1}
                              <span className="ml-1.5 text-[10px] uppercase tracking-wider text-white/35">
                                {moveCellLabel(mv.cellIndex)}
                              </span>
                            </span>
                            <span
                              className="font-mono font-bold"
                              style={{ color: seatColor(seat) }}
                            >
                              {mark}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section className="rounded-2xl border border-amber-500/20 bg-black/40 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-white/50">Emotes</span>
                    <EmotePicker
                      compact
                      hideBubbles
                      incomingEmote={incomingEmote}
                      myEmote={myEmote}
                      onSend={(emote) => sendEmote(emote)}
                    />
                  </div>
                  {opponentId && match.status === "playing" && (
                    <button
                      onClick={() => setShowReportModal(true)}
                      className="mt-3 w-full rounded-lg border border-red-500/30 bg-red-500/10 py-2 text-[11px] font-bold text-red-300 transition hover:bg-red-500/20"
                    >
                      <span className="inline-flex items-center gap-1">
                        <IconFlag size={12} /> Report {opponentName}
                      </span>
                    </button>
                  )}
                </section>
              </aside>
            </div>
          </div>

          {/* ── Cancelled lobby / match ────────────────────────────── */}
          {cancelled && (
            <div
              data-testid="tic-tac-toe-cancelled"
              className="mx-auto mt-6 max-w-lg rounded-2xl border border-white/15 bg-white/5 p-6 text-center"
            >
              <p className="text-sm font-bold text-white">This match was cancelled.</p>
              <p className="mt-2 text-xs text-white/60">
                Nothing was rated. Find another opponent whenever you are ready.
              </p>
              <button
                type="button"
                onClick={() => router.push("/casino/tic-tac-toe")}
                className="mt-4 inline-flex items-center justify-center rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-bold text-amber-200 transition hover:bg-amber-500/20"
              >
                Back to the Tic-Tac-Toe lobby
              </button>
            </div>
          )}

          {/* ── Forfeit confirmation ───────────────────────────────── */}
          <AnimatePresence>
            {showForfeitConfirm && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
                onClick={(e) => {
                  if (e.target === e.currentTarget && !forfeiting) setShowForfeitConfirm(false);
                }}
              >
                <motion.div
                  initial={{ scale: 0.94, y: 10, opacity: 0 }}
                  animate={{ scale: 1, y: 0, opacity: 1 }}
                  exit={{ scale: 0.96, opacity: 0 }}
                  role="dialog"
                  aria-modal="true"
                  className="w-full max-w-sm rounded-2xl border border-red-500/40 bg-[#141021] p-6 text-center"
                >
                  <h3 className="text-lg font-extrabold text-red-300">Forfeit this match?</h3>
                  <p className="mt-2 text-sm text-white/70">
                    Your opponent is awarded the win and the match settles immediately.
                  </p>
                  <div className="mt-5 flex gap-2">
                    <button
                      onClick={() => setShowForfeitConfirm(false)}
                      className="flex-1 rounded-xl bg-white/10 py-2.5 text-sm font-bold hover:bg-white/20"
                    >
                      Keep playing
                    </button>
                    <button
                      data-testid="confirm-forfeit"
                      onClick={forfeit}
                      disabled={forfeiting}
                      className="flex-1 rounded-xl bg-red-500 py-2.5 text-sm font-bold text-black disabled:opacity-60"
                    >
                      {forfeiting ? "Forfeiting…" : "Forfeit"}
                    </button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Result ─────────────────────────────────────────────── */}
          <PvpResultScreen
            open={finished}
            outcome={outcome}
            headline={
              outcome === "draw"
                ? "Draw — the board filled with no line"
                : outcome === "win"
                  ? "You won the duel"
                  : "Your opponent won the duel"
            }
            subline={
              match.winningLine
                ? `${match.winner === viewerSeat ? "Your" : "Their"} ${
                    markForSeat(match.winner) ?? ""
                  } completed a line in ${Number(match.ply) || 0} moves.`
                : Number(match.ply) >= CELL_COUNT
                  ? "All nine cells were played and nobody completed a line."
                  : "The match was conceded before the board was decided."
            }
            gameName="Tic-Tac-Toe"
            gameKey="tic-tac-toe"
            durationSeconds={durationSeconds(match.startedAt, match.endedAt)}
            opponent={{
              name: opponentName,
              iconKey: seats.opponent?.iconKey ?? null,
              profileFrame: seats.opponent?.profileFrame ?? null,
            }}
            summary={[
              {
                label: "Result",
                value: outcome === "win" ? "Win" : outcome === "loss" ? "Loss" : "Draw",
              },
              { label: "Your mark", value: viewerMark ?? "—" },
              { label: "Moves played", value: `${Number(match.ply) || 0} of ${CELL_COUNT}` },
            ]}
            details={[
              { label: "Match ID", value: String(matchId) },
              { label: "Your mark", value: `${viewerMark ?? "—"} (${viewerSeat ?? "—"})` },
              { label: "Opponent", value: opponentName },
              {
                label: "Winning line",
                value: match.winningLine
                  ? (match.winningLine as number[]).join(" · ")
                  : "—",
              },
              ...moves.map((mv: any) => ({
                label: `Move ${Number(mv.ply) + 1}`,
                value: `${mv.playerId === match.player1Id ? "X" : "O"} → ${moveCellLabel(mv.cellIndex)}`,
              })),
            ]}
            playAgain={{
              label: "Play again",
              onClick: () => router.push("/casino/tic-tac-toe"),
            }}
            onReturnToLobby={() => router.push("/casino")}
          />

          {/* ── Report ─────────────────────────────────────────────── */}
          <ReportModal
            isOpen={showReportModal}
            onClose={() => setShowReportModal(false)}
            reportedPlayerName={opponentName}
            gameType="tic-tac-toe"
            onSubmit={async (reason: string, details: string) => {
              try {
                await fetch("/api/reports/submit", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    reportedClerkId: opponentId,
                    reason,
                    details,
                    gameType: "tic-tac-toe",
                  }),
                });
              } catch {
                // best-effort
              }
              setShowReportModal(false);
            }}
          />
        </div>
      </GameSessionHost>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-white/45">{label}</span>
      <span className="font-semibold text-white">{value}</span>
    </div>
  );
}
