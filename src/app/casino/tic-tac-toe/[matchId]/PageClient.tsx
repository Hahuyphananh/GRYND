"use client";

// src/app/casino/tic-tac-toe/[matchId]/PageClient.tsx
//
// The Mega Tic-Tac-Toe match view.
//
// ── AUTHORITY ─────────────────────────────────────────────────────────────
//
// The server owns the lattice. The ONLY thing this page ever sends is
// `{ boardIndex, cellIndex, expectedVersion }` where `boardIndex` is a move
// ADDRESS (a lattice slot 0..8, or -1 for the sudden-death board) — never a
// mark, a board state, a round, a winner or a result. The lattice it renders is
// the one in the snapshot, the per-board control and winning lines are the
// snapshot's, the Mega winning line is the snapshot's `winningBoards`, and the
// result screen is driven by the snapshot's `result` / `winnerId`, so a
// forfeited match (where no line exists) still reports the correct winner.
//
// Optimism is limited to FEEDBACK: clicking an empty cell paints a translucent
// "pending" mark until the next authoritative snapshot replaces it. A rejected
// move drops the ghost and resyncs — the local view is never allowed to drift
// from the server, and it never decides that a board or the match is over.
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
// is one discrete, instantly-resolved move. Expansion (Round 1 → 2 → 3) is a
// consequence of the SERVER's stage, animated client-side only.

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
import MegaBoard from "../../../../components/tic-tac-toe/MegaBoard";
import TiebreakSummary from "../../../../components/tic-tac-toe/TiebreakSummary";
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
import {
  CELL_COUNT,
  SUDDEN_DEATH_BOARD_INDEX,
} from "../../../../lib/tic-tac-toe/constants";
import {
  durationSeconds,
  isCellPlayable,
  isIncomingSnapshotStale,
  markForSeat,
  megaControlCounts,
  normaliseLattice,
  normaliseSlotList,
  normaliseStage,
  outcomeFor,
  progressLabel,
  resultReason,
  roundCellBudget,
  roundLabel,
  roundName,
  seatColor,
  seatLabel,
  seatForMark,
  serverBoardAt,
  stageSlots,
  statusLabel,
  tiebreakHeading,
  tiebreakRows,
  turnLabel,
  viewerMarkLabel,
} from "../../../../lib/tic-tac-toe/ui";
import type { Seat } from "../../../../lib/tic-tac-toe/types";

const ACTIVE_POLL_MS = 1800;
const IDLE_POLL_MS = 5000;

// Fast, non-blocking progression beats: long enough to read the announcement,
// short enough that a turn is never waiting on an animation to finish.
const EXPANSION_MS = 1200;
const BOARD_EVENT_MS = 1800;

/** "Row 2 · Col 3" — the board cell a logged move landed on. */
function moveCellLabel(cellIndex: unknown): string {
  const index = Number(cellIndex);
  if (!Number.isInteger(index) || index < 0 || index >= CELL_COUNT) return "—";
  return `Row ${Math.floor(index / 3) + 1} · Col ${(index % 3) + 1}`;
}

/** "Board 3" / "Sudden death" — the board a logged move targeted. */
function moveBoardLabel(boardIndex: unknown): string {
  const slot = Number(boardIndex);
  if (slot === SUDDEN_DEATH_BOARD_INDEX) return "Sudden death";
  if (!Number.isInteger(slot) || slot < 0) return "—";
  return `Board ${slot + 1}`;
}

type PendingMove = { boardIndex: number; cellIndex: number; version: number };

export default function TicTacToeMatchPage() {
  const params = useParams<{ matchId: string }>();
  const router = useRouter();
  const { socket } = useSocket();
  const { user } = useUser();
  const matchId = params?.matchId;
  const apiMatch = `/api/tic-tac-toe/match/${matchId}`;

  const [match, setMatch] = useState<any>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Optimistic FEEDBACK only (see the header note): the board + cell the viewer
  // just clicked, kept until an authoritative snapshot moves past that version.
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Which lattice board the viewer is interacting with (hover / focus / tap).
  const [focusedBoard, setFocusedBoard] = useState<number | null>(null);
  // The expansion transition: the SERVER's stage grew (Round 1 → 2 → 3).
  const [transition, setTransition] = useState<number | null>(null);
  // The board that just resolved on the latest snapshot, for a brief highlight.
  const [boardEvent, setBoardEvent] = useState<{ slot: number; control: string } | null>(null);
  const [showForfeitConfirm, setShowForfeitConfirm] = useState(false);
  const [forfeiting, setForfeiting] = useState(false);
  const [cancellingLobby, setCancellingLobby] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const matchRef = useRef<any>(null);
  // The last stage / lattice we observed, so a transition or a board event only
  // fires when the SERVER actually moved — never on first load or a re-poll.
  const prevStageRef = useRef<number | null>(null);
  const prevBoardsRef = useRef<any>(null);
  const boardEventTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    matchRef.current = match;
  }, [match]);

  // The App Router reuses this page instance when only `[matchId]` differs, so
  // every piece of per-match state is reset, otherwise the previous match's
  // lattice and pending ghost would flash into the new one.
  useEffect(() => {
    setMatch(null);
    setLoadError(null);
    setPending(null);
    setSubmitting(false);
    setFocusedBoard(null);
    setTransition(null);
    setBoardEvent(null);
    setShowForfeitConfirm(false);
    setForfeiting(false);
    setShowReportModal(false);
    prevStageRef.current = null;
    prevBoardsRef.current = null;
    if (boardEventTimerRef.current) clearTimeout(boardEventTimerRef.current);
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
      // A hidden tab cannot play: issue no snapshot reads while hidden, and
      // resume with one immediate catch-up when the tab is visible again.
      if (typeof document !== "undefined" && document.hidden) return;
      refresh();
      const idle =
        matchRef.current?.status === "finished" ||
        matchRef.current?.status === "cancelled";
      timer = setTimeout(tick, idle ? IDLE_POLL_MS : ACTIVE_POLL_MS);
    };
    tick();

    const onVisibilityChange = () => {
      if (cancelled) return;
      if (document.hidden) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      } else if (timer === null) {
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
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

  // ── Derived view model (all from the snapshot) ────────────────────────
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

  const stage = normaliseStage(match?.stage);
  const stageSlotList = normaliseSlotList(match?.stageBoardSlots);
  const slots = stageSlotList.length ? stageSlotList : stageSlots(stage);
  const lattice = useMemo(() => normaliseLattice(match?.boards), [match?.boards]);
  const counts = useMemo(() => megaControlCounts(lattice, slots), [lattice, slots]);
  const activeSlots = useMemo(() => {
    const fromServer = normaliseSlotList(match?.activeBoards);
    if (fromServer.length) return fromServer;
    return slots.filter((slot) => lattice[slot]?.control === "active");
  }, [match?.activeBoards, lattice, slots]);
  const cellBudget = roundCellBudget(stage);
  const effectiveFocus =
    focusedBoard !== null && slots.includes(focusedBoard)
      ? focusedBoard
      : activeSlots[0] ?? slots[0] ?? null;

  // The expansion transition, driven ONLY by the server's stage growing. The
  // first observed stage is recorded silently, so reconnecting into a match
  // that is already Round 2/3 does not replay an expansion.
  // `hasMatch` (not `match` itself) is the dependency: the poll hands back a NEW
  // object every tick, and keying the effect on its identity would clear the
  // timer mid-beat and leave the overlay stuck.
  const hasMatch = Boolean(match);
  useEffect(() => {
    if (!hasMatch) return undefined;
    const previous = prevStageRef.current;
    prevStageRef.current = stage;
    if (previous === null || stage <= previous) return undefined;
    setTransition(stage);
    const timer = setTimeout(() => setTransition(null), EXPANSION_MS);
    return () => clearTimeout(timer);
  }, [stage, hasMatch]);

  // A small-board win or draw, detected purely by a control flip in the
  // SERVER's lattice. At most one board resolves per ply, so this is a single
  // event; a single surviving timer drops it after a beat (a re-poll must not
  // cancel it).
  useEffect(() => {
    const boards = match?.boards;
    if (!Array.isArray(boards)) return undefined;
    const previous = prevBoardsRef.current;
    prevBoardsRef.current = boards;
    if (!previous) return undefined;
    for (let slot = 0; slot < boards.length; slot += 1) {
      const after = boards[slot]?.control;
      if (after !== "X" && after !== "O" && after !== "draw") continue;
      if (previous[slot]?.control === "active") {
        setBoardEvent({ slot, control: after });
        if (boardEventTimerRef.current) clearTimeout(boardEventTimerRef.current);
        boardEventTimerRef.current = setTimeout(() => setBoardEvent(null), BOARD_EVENT_MS);
        break;
      }
    }
    return undefined;
  }, [match?.boards]);

  useEffect(
    () => () => {
      if (boardEventTimerRef.current) clearTimeout(boardEventTimerRef.current);
    },
    [],
  );

  // The server's own gate, narrowed only by "a request is in flight" and
  // "the match is over" — this page never invents a third condition.
  const inTransition = transition !== null;
  const boardUnlocked =
    Boolean(match) &&
    !finished &&
    !cancelled &&
    !submitting &&
    !inTransition &&
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
  // those adornments are re-derived server-side. The lattice, the turn, the
  // status and the outcome still come ONLY from the response.
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

  // The ONLY way a move is ever requested. It first re-checks the target board
  // and cell against the snapshot the viewer is looking at, so a click on an
  // occupied cell, a locked board, or a click outside the viewer's turn is a
  // no-op here as well as server-side.
  const submitMove = useCallback(
    async (boardIndex: number, cellIndex: number) => {
      const current = matchRef.current;
      if (!current || submitting) return;
      const target = serverBoardAt(current, boardIndex);
      if (!target || target.control !== "active") return;
      if (
        !isCellPlayable({
          board: target.cells,
          cellIndex,
          viewerCanMove: Boolean(current.viewerCanMove),
        })
      ) {
        return;
      }
      const expectedVersion = current.version;

      setFocusedBoard(boardIndex);
      setSubmitting(true);
      setPending({
        boardIndex,
        cellIndex,
        version: Number(expectedVersion) || 0,
      });
      setLoadError(null);
      try {
        const res = await fetch(`${apiMatch}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The whole request. No mark, no board state, no result.
          body: JSON.stringify({ boardIndex, cellIndex, expectedVersion }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          // Rejected (stale tab, wrong turn, occupied cell, locked board) —
          // drop the ghost and resync rather than guessing what happened.
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
    [adoptAuthoritative, apiMatch, refresh, submitting],
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
    return <MatchLoading label="Loading Mega Tic-Tac-Toe…" currentPath="/casino/tic-tac-toe" />;
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
          gameName="Mega Tic-Tac-Toe"
          icon={<IconTicTac className="h-8 w-8 text-amber-400" />}
          subtitle={
            match.status === "ready"
              ? "Opponent found — X opens Round 1…"
              : "Waiting for an opponent to join your Mega Tic-Tac-Toe table…"
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
          data-stage={stage}
          className="min-h-screen overflow-x-clip bg-gradient-to-b from-[#0d1226] via-[#080d1c] to-[#04060f] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8"
        >
          <div className="mx-auto max-w-6xl">
            {/* ── Header ────────────────────────────────────────────── */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-amber-200 via-amber-300 to-yellow-200 sm:text-3xl">
                  <IconTicTac className="h-7 w-7 text-amber-400" />
                  Mega Tic-Tac-Toe
                </h1>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-widest text-amber-200/70">
                  <span>1 → 4 → 9 boards · win the lattice</span>
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
                    {boardUnlocked && effectiveFocus !== null && (
                      <span className="text-[11px] font-normal text-white/55">
                        · focused on Board {effectiveFocus + 1}
                      </span>
                    )}
                  </span>
                  <span className="text-[11px] uppercase tracking-wider text-white/45">
                    {roundLabel(stage)} · {viewerMarkLabel(viewerSeat)} ·{" "}
                    {progressLabel(match.boards?.[effectiveFocus]?.cells ?? [])}
                  </span>
                </div>

                {/* Small-board feedback — a win or a draw, briefly announced. */}
                <AnimatePresence>
                  {boardEvent !== null && transition === null && (
                    <motion.div
                      key={`${boardEvent.slot}-${boardEvent.control}`}
                      data-testid="board-event"
                      data-kind={boardEvent.control === "draw" ? "draw" : "win"}
                      data-slot={boardEvent.slot}
                      initial={{ opacity: 0, y: -6, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.18 }}
                      className={`mb-3 rounded-xl border px-3 py-2 text-center text-sm font-bold ${
                        boardEvent.control === "draw"
                          ? "border-white/20 bg-white/10 text-white/80"
                          : "border-emerald-400/50 bg-emerald-500/15 text-emerald-100"
                      }`}
                    >
                      {boardEvent.control === "draw"
                        ? `Board ${boardEvent.slot + 1} drawn — locked`
                        : `Board ${boardEvent.slot + 1} — ${boardEvent.control} controls it!`}
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* The lattice, with the expansion transition over it. */}
                <div className="relative">
                  <MegaBoard
                    boards={match.boards}
                    stage={stage}
                    slots={slots}
                    winningBoards={match.winningBoards}
                    lastMove={match.lastMove}
                    suddenDeath={match.suddenDeath}
                    viewerSeat={viewerSeat}
                    viewerCanMove={boardUnlocked}
                    busy={submitting}
                    pending={pending}
                    focusedBoard={effectiveFocus}
                    highlightSlot={boardEvent?.slot ?? null}
                    onFocusBoard={setFocusedBoard}
                    onPlay={(boardIndex, cellIndex) => void submitMove(boardIndex, cellIndex)}
                  />

                  {/* Strong, fast expansion announcement. Input is locked for the
                      beat (via `boardUnlocked`), then control returns. */}
                  <AnimatePresence>
                    {transition !== null && (
                      <motion.div
                        key={transition}
                        data-testid="mega-transition"
                        data-to={transition}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.16 }}
                        className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-[#04060f]/70 backdrop-blur-[3px]"
                      >
                        <motion.div
                          initial={{ scale: 0.82, opacity: 0, y: 8 }}
                          animate={{ scale: 1, opacity: 1, y: 0 }}
                          exit={{ scale: 1.06, opacity: 0 }}
                          transition={{ type: "spring", stiffness: 340, damping: 24 }}
                          className="mx-3 rounded-2xl border border-amber-400/60 bg-gradient-to-b from-amber-500/25 to-black/70 px-8 py-6 text-center shadow-[0_0_60px_rgba(251,191,36,0.4)]"
                        >
                          <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-amber-200/80">
                            {transition === 2 ? "Board expanding" : "Final expansion"}
                          </p>
                          <p
                            data-testid="mega-transition-title"
                            className="mt-1 bg-clip-text text-4xl font-black tracking-wider text-transparent bg-gradient-to-r from-amber-200 via-yellow-100 to-amber-200 sm:text-5xl"
                          >
                            {transition === 2 ? "ROUND 2" : "MEGA BOARD"}
                          </p>
                          <p className="mt-1 text-xs font-semibold text-white/70">
                            {transition === 2
                              ? "Four boards · control three in a line"
                              : "Nine boards · control three in a line"}
                          </p>
                        </motion.div>
                      </motion.div>
                    )}
                  </AnimatePresence>
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
                            ? "Your turn — click any empty cell on any open board."
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
                      ? "Every click is verified by the server: it decides the mark, whose turn it is, which board is locked and when the Mega line wins. Empty cells are outlined; occupied, locked and out-of-turn cells do nothing."
                      : "The lattice is the server's. Open boards are outlined on your turn, a completed board locks while keeping every mark, and the winner is decided server-side."}
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
                    <Row label="Round" value={`${roundLabel(stage)} · ${roundName(stage)}`} />
                    <Row label="Boards in play" value={`${slots.length}`} />
                    <Row label="Boards locked" value={`${counts.resolved} of ${slots.length}`} />
                    <Row label="Your mark" value={viewerMark ?? "—"} />
                    <Row label="Opponent" value={opponentName} />
                    <Row label="Opponent's mark" value={opponentMark ?? "—"} />
                    <Row label="Moves played" value={`${Number(match.ply) || 0} of ${cellBudget}`} />
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
                    Mega board
                  </h2>
                  <div className="space-y-1.5 text-xs">
                    <Row label="X controls" value={`${counts.x}`} />
                    <Row label="O controls" value={`${counts.o}`} />
                    <Row label="Draws" value={`${counts.draw}`} />
                    <Row label="Open boards" value={`${counts.active}`} />
                    {Number.isInteger(match.winningBoards?.[0]) ? (
                      <Row
                        label="Mega line"
                        value={(match.winningBoards as number[])
                          .map((slot: number) => `B${slot + 1}`)
                          .join(" · ")}
                      />
                    ) : (
                      <Row label="Mega line" value="—" />
                    )}
                  </div>
                  {match.tiebreak && <TiebreakSummary tiebreak={match.tiebreak} className="mt-2" />}
                </section>

                <section className="rounded-2xl border border-amber-500/20 bg-black/40 p-4">
                  <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-amber-300">
                    Move history
                  </h2>
                  {moves.length === 0 ? (
                    <p className="text-xs text-white/50">
                      No moves yet — X opens Round 1.
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
                            key={`${mv.ply}-${mv.boardIndex}-${mv.cellIndex}`}
                            className={`flex items-center justify-between rounded-lg border px-2 py-1.5 text-xs ${
                              isLastMove
                                ? "border-amber-400/40 bg-amber-500/10"
                                : "border-white/10 bg-white/5"
                            }`}
                          >
                            <span className="font-semibold text-white/70">
                              Move {Number(mv.ply) + 1}
                              <span className="ml-1.5 text-[10px] uppercase tracking-wider text-white/35">
                                {moveBoardLabel(mv.boardIndex)} · {moveCellLabel(mv.cellIndex)}
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
                ? "Draw — the lattice resolved level"
                : outcome === "win"
                  ? "You won the duel"
                  : "Your opponent won the duel"
            }
            subline={resultReason({
              winningBoards: match.winningBoards,
              tiebreak: match.tiebreak,
              ply: match.ply,
            })}
            gameName="Mega Tic-Tac-Toe"
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
              { label: "Round", value: `${stage}` },
              { label: "Moves played", value: `${Number(match.ply) || 0} of ${cellBudget}` },
            ]}
            details={[
              { label: "Match ID", value: String(matchId) },
              { label: "Your mark", value: `${viewerMark ?? "—"} (${viewerSeat ?? "—"})` },
              { label: "Opponent", value: opponentName },
              {
                label: "Mega line",
                value: match.winningBoards
                  ? (match.winningBoards as number[]).map((slot: number) => `Board ${slot + 1}`).join(" · ")
                  : "—",
              },
              ...(match.tiebreak
                ? [
                    { label: "Tiebreak", value: tiebreakHeading(match.tiebreak) },
                    ...tiebreakRows(match.tiebreak).map((row) => ({
                      label: row.label,
                      value: row.value,
                    })),
                  ]
                : []),
              ...moves.map((mv: any) => ({
                label: `Move ${Number(mv.ply) + 1}`,
                value: `${mv.playerId === match.player1Id ? "X" : "O"} → ${moveBoardLabel(
                  mv.boardIndex,
                )}, ${moveCellLabel(mv.cellIndex)}`,
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
