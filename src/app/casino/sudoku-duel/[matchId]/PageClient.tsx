"use client";

// src/app/casino/sudoku-duel/[matchId]/PageClient.tsx
//
// The Sudoku Duel race view — one large board, one opponent bar.
//
// ── AUTHORITY ───────────────────────────────────────────────────────────
//
// Every competitive value on this page is the SERVER's: the board (a projection
// that carries only clues and the viewer's already-verified entries, never the
// solution), the progress figures, the mistake count, the penalty, the
// completion, the GO instant, the inactivity clock, the result and the winner.
//
// The only thing this page ever SENDS is an action — a cell and a value, or a
// cell to clear, plus the per-seat ply cursor. It never sends a board, a
// progress value, a mistake count, a completion, a completion time, a score, a
// winner, a result, an Elo value or a trophy.
//
// There is no local prediction of the board either: the server only ever writes
// a value it has verified, so the client cannot render an optimistic digit —
// a wrong value is not a value at all. A wrong move shows as a brief red flash
// on the cell and a quiet penalty line, and the correct answer is never
// revealed.
//
// ── FLOW ────────────────────────────────────────────────────────────────
//
//   poll GET /api/sudoku-duel/match/<id>       (backstop, 1.5 s while live)
//   socket `lobby:updated` on `sudoku-duel:match:<id>` → immediate refetch
//   socket `sudoku-duel:opponent-progress`     → the opponent's bar, instantly
//   socket `sudoku-duel:countdown`/`match-started` → the server's GO instant
//   socket `sudoku-duel:match-finished`        → refetch the settled row
//   select a cell, tap a number → POST /move → adopt the returned snapshot
//   the inactivity clock runs out → STOP; the server resolves and this page
//   renders the result it is handed (fetchMatch resolves an idle match on read)
//
// The timer ticks locally at 200 ms but is anchored to the server's clock
// (`serverNow` in every snapshot), so a client with a wrong clock or a slow
// connection still counts to the server's GO instant and its inactivity clock.
// There is no server tick per frame and no server call per tick, and nothing the
// client does can move the official clock.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useParams, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  IconAlertTriangle,
  IconCheck,
  IconDoorExit,
  IconFlag,
  IconGridDots,
  IconHourglassHigh,
  IconSwords,
} from "@tabler/icons-react";

import NavigationBar from "../../../../components/navigation-bar";
import GameSessionHost from "../../../../components/GameSessionHost";
import MatchWaiting from "../../../../components/lobby/MatchWaiting";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import CompetitiveHud from "../../../../components/sudoku-duel/CompetitiveHud";
import SudokuBoard from "../../../../components/sudoku-duel/SudokuBoard";
import SudokuNumberPad from "../../../../components/sudoku-duel/SudokuNumberPad";
import { useSocket } from "../../../../context/SocketProvider";
import {
  SUDOKU_DUEL_EVENTS,
  sudokuDuelMatchRoom,
  type OpponentProgressEvent,
} from "../../../../lib/sudoku-duel/rooms";
import {
  CELL_COUNT,
  EMPTY,
  INACTIVITY_COUNTDOWN_MS,
  SIZE,
} from "../../../../lib/sudoku-duel/constants";
import {
  adjustedFinishMs,
  clockLabel,
  difficultyLabel,
  durationSeconds,
  givensLabel,
  mistakeLabel,
  progressLabel,
  resolutionLabel,
  solveMs,
  statusLabel,
  tiebreakLabel,
  viewerOutcome,
  type ViewerOutcome,
} from "../../../../lib/sudoku-duel/ui";
import type {
  Seat,
  SeatProgress,
  SudokuAction,
  SudokuView,
} from "../../../../lib/sudoku-duel/types";

// ── The server's snapshot, as this page consumes it ───────────────────────

type SeatIdentity = {
  name?: string | null;
  iconKey?: string | null;
  nameColor?: string | null;
  profileFrame?: unknown;
} | null;

type OpponentProgress = {
  seatKey: Seat;
  correctCells: number;
  mistakes: number;
  progressPercent: number;
  completed: boolean;
  completedAtMs: number | null;
};

/**
 * The rating/trophy movement the settlement wrote for this viewer, read off the
 * shared journals by the match route. Present only on a settled, rated match —
 * absent (null) means nothing rated, never "zero".
 */
type SettlementDto = {
  outcome: "win" | "loss" | "draw";
  elo: { before: number; after: number; delta: number } | null;
  trophies: { before: number; after: number; delta: number } | null;
} | null;

type MatchDto = {
  matchId: string;
  variant: string;
  variantVersion: number;
  difficulty: string;
  givens: number;
  status: string;
  result: string | null;
  resolutionReason: string | null;
  winnerId: string | null;
  seat: Seat | null;
  isParticipant: boolean;
  /** True for a free practice match against the built-in bot. */
  isAi?: boolean;
  aiDifficulty?: string | null;
  seedHash: string | null;
  serverSeed: string | null;
  puzzleSeed: number | null;
  goAtMs: number | null;
  /** The viewer's own inactivity alarm instant (15 min without an action). */
  inactivityAlarmAtMs: number | null;
  /** The viewer's own inactivity-forfeit instant (20 min without an action). */
  inactivityForfeitAtMs: number | null;
  /** The opponent's inactivity alarm instant, so a waiting seat can be told. */
  opponentInactivityAlarmAtMs: number | null;
  /** The opponent's inactivity-forfeit instant. */
  opponentInactivityForfeitAtMs: number | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  createdAtMs: number | null;
  serverNow: number;
  view: SudokuView | null;
  progress: SeatProgress | null;
  completed: boolean;
  /** The viewer's own server-stamped completion instant, or null. */
  completedAtMs: number | null;
  mistakeCount: number;
  penaltyMs: number;
  opponent: OpponentProgress | null;
  players?: { player1: SeatIdentity; player2: SeatIdentity } | null;
  settlement?: SettlementDto;
};

type OpponentProgressPayload = OpponentProgressEvent & { matchId?: string | number };

const LIVE_POLL_MS = 1500;
/** How long the "GO" flash stays up once the countdown reaches zero. */
const GO_FLASH_MS = 700;
/** How long a notice (a refusal, a mistake line) lingers. */
const NOTICE_MS = 2200;
/** How long a cell stays flagged after the server called it wrong. */
const INVALID_FLASH_MS = 900;

const TERMINAL = new Set(["finished", "cancelled"]);

/** True when `next` must not replace `prev` — a stale poll losing to a move. */
function isStaleSnapshot(prev: MatchDto | null, next: MatchDto | null): boolean {
  if (!prev || !next) return false;
  // The viewer's OWN ply only ever grows, so a lower one is an older read that
  // raced a move response. (The opponent's figures are not used for this: their
  // progress is a separate number that can lag a snapshot.)
  const prevPly = Number(prev.view?.ply ?? -1);
  const nextPly = Number(next.view?.ply ?? -1);
  if (prevPly >= 0 && nextPly >= 0 && nextPly < prevPly) return true;
  // A settled match can never be un-settled by a late read.
  if (TERMINAL.has(String(prev.status)) && !TERMINAL.has(String(next.status))) return true;
  return false;
}

export default function SudokuDuelMatchPage() {
  const params = useParams<{ matchId: string }>();
  const router = useRouter();
  const { socket } = useSocket();
  const matchId = params?.matchId;
  const apiMatch = `/api/sudoku-duel/match/${matchId}`;

  const [match, setMatch] = useState<MatchDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [liveOpponent, setLiveOpponent] = useState<OpponentProgressPayload | null>(null);
  const [goAtOverride, setGoAtOverride] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [invalidIndex, setInvalidIndex] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [goFlash, setGoFlash] = useState(false);
  const [showResign, setShowResign] = useState(false);
  const [resigning, setResigning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [requeueing, setRequeueing] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const loadedRef = useRef(false);
  const matchRef = useRef<MatchDto | null>(null);
  const selectedRef = useRef<number | null>(null);
  // The server's clock, as an offset from this browser's. Every snapshot
  // carries `serverNow`, so the countdown and the timer are anchored to the
  // server's timeline rather than to the local clock.
  const skewRef = useRef(0);
  const inFlightRef = useRef(false);
  const loadRef = useRef<() => void>(() => {});

  useEffect(() => {
    matchRef.current = match;
  }, [match]);
  useEffect(() => {
    selectedRef.current = selectedIndex;
  }, [selectedIndex]);

  // The App Router reuses this component when only `[matchId]` differs, so
  // every per-match value is reset — a rematch must never inherit the previous
  // race's board, selection, timer or result.
  useEffect(() => {
    setMatch(null);
    setLoadError(null);
    setLiveOpponent(null);
    setGoAtOverride(null);
    setNotice(null);
    setPending(false);
    setPendingIndex(null);
    setSelectedIndex(null);
    setInvalidIndex(null);
    setGoFlash(false);
    setShowResign(false);
    setResigning(false);
    setCancelling(false);
    setLeaving(false);
    loadedRef.current = false;
    skewRef.current = 0;
    inFlightRef.current = false;
    setLoading(true);
  }, [matchId]);

  // ── The snapshot (the one authoritative read) ───────────────────────────
  const adopt = useCallback((snapshot: MatchDto | null) => {
    if (!snapshot) return;
    const serverNow = Number(snapshot.serverNow);
    if (Number.isFinite(serverNow) && serverNow > 0) {
      skewRef.current = serverNow - Date.now();
    }
    setNow(Date.now());
    // The snapshot is authoritative for the clock too: once it carries the
    // server's own GO instant, any realtime override is redundant. Dropping it
    // here is what stops a stray (or forged) countdown instant from pinning the
    // board in the countdown phase — the next authoritative read always wins.
    if (snapshot.goAtMs != null) setGoAtOverride(null);
    setMatch((prev) => (isStaleSnapshot(prev, snapshot) ? prev : { ...(prev ?? {}), ...snapshot }));
    // The snapshot is authoritative for the opponent too, so a socket-only
    // progress value is retired as soon as one arrives.
    setLiveOpponent(null);
  }, []);

  const load = useCallback(async () => {
    if (!matchId) return;
    try {
      const res = await fetch(apiMatch, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setLoadError(data?.error || "Unable to load this match");
        return;
      }
      loadedRef.current = true;
      setLoadError(null);
      adopt(data.data as MatchDto);
    } catch {
      setLoadError("Unable to load this match");
    } finally {
      setLoading(false);
    }
  }, [adopt, apiMatch, matchId]);

  useEffect(() => {
    loadRef.current = () => void load();
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Derived lifecycle ──────────────────────────────────────────────────
  const status = match?.status ?? "";
  const finished = status === "finished";
  const cancelled = status === "cancelled";
  const terminal = TERMINAL.has(status);
  const seat: Seat | null = match?.seat ?? null;
  const view = match?.view ?? null;
  const serverNowMs = now + skewRef.current;
  const goAtMs = goAtOverride ?? match?.goAtMs ?? null;
  // The match is untimed, so the clock is the VIEWER'S OWN inactivity clock:
  // time until the seat forfeits for not acting, derived per viewer by the
  // server. `clockAnchorMs` is anchored to GO, so it reads the full window
  // through the countdown instead of counting the pre-GO window as race time.
  const inactivityForfeitAtMs = match?.inactivityForfeitAtMs ?? null;
  const inactivityAlarmAtMs = match?.inactivityAlarmAtMs ?? null;
  const countdownMs = goAtMs == null ? null : Math.max(0, goAtMs - serverNowMs);
  const clockAnchorMs = goAtMs == null ? serverNowMs : Math.max(serverNowMs, goAtMs);
  const remainingMs =
    inactivityForfeitAtMs == null ? null : Math.max(0, inactivityForfeitAtMs - clockAnchorMs);
  const expired = remainingMs != null && remainingMs <= 0;
  const myCompleted = Boolean(match?.completed);

  const phase = useMemo(() => {
    if (!match) return loadError && !loadedRef.current ? ("error" as const) : ("loading" as const);
    if (terminal) return "result" as const;
    if (status === "waiting" || status === "ready") return "waiting" as const;
    if (countdownMs == null || countdownMs > 0) return "countdown" as const;
    return "racing" as const;
  }, [match, loadError, terminal, status, countdownMs]);

  const alarmActive =
    phase === "racing" &&
    !terminal &&
    inactivityAlarmAtMs != null &&
    serverNowMs >= inactivityAlarmAtMs;
  // The clock counts UP as a stopwatch for almost the whole untimed match, and
  // only flips to the forfeit countdown in the last five minutes before the
  // viewer's OWN inactivity forfeit. That instant is `INACTIVITY_COUNTDOWN_MS`
  // away from the server's forfeit instant, which is where the alarm goes live.
  const countdownActive =
    phase === "racing" &&
    !terminal &&
    remainingMs != null &&
    remainingMs <= INACTIVITY_COUNTDOWN_MS;
  // The stopwatch the clock shows until the forfeit countdown begins.
  const elapsedMs = goAtMs == null ? null : Math.max(0, serverNowMs - goAtMs);
  // The OPPONENT's idle state, so a waiting seat is told the other side may soon
  // forfeit. Never raised for a completed opponent or in untimed practice.
  const opponentAlarmAtMs = match?.opponentInactivityAlarmAtMs ?? null;
  const opponentForfeitAtMs = match?.opponentInactivityForfeitAtMs ?? null;
  const opponentRemainingMs =
    opponentForfeitAtMs == null ? null : Math.max(0, opponentForfeitAtMs - serverNowMs);
  const opponentAlarmActive =
    phase === "racing" &&
    !terminal &&
    opponentAlarmAtMs != null &&
    serverNowMs >= opponentAlarmAtMs &&
    !match?.opponent?.completed;

  // ── Clock (only while a clock is on screen) ────────────────────────────
  useEffect(() => {
    if (phase !== "countdown" && phase !== "racing") return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [phase]);

  // A short "GO" flash on the countdown → racing edge, so the moment the board
  // unlocks is explicit without blocking play (it is pointer-events-none).
  useEffect(() => {
    if (phase !== "racing") return undefined;
    setGoFlash(true);
    const id = window.setTimeout(() => setGoFlash(false), GO_FLASH_MS);
    return () => window.clearTimeout(id);
  }, [phase]);

  // A notice is transient by design — the board must never be blocked by one.
  useEffect(() => {
    if (!notice) return undefined;
    const id = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(id);
  }, [notice]);

  // The red flash on a wrongly-judged cell clears itself; it reveals nothing.
  useEffect(() => {
    if (invalidIndex == null) return undefined;
    const id = window.setTimeout(() => setInvalidIndex(null), INVALID_FLASH_MS);
    return () => window.clearTimeout(id);
  }, [invalidIndex]);

  // ── Poll backstop ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!matchId || !match || terminal) return undefined;
    const id = window.setInterval(() => void load(), LIVE_POLL_MS);
    return () => window.clearInterval(id);
  }, [matchId, match, terminal, load]);

  // When the local inactivity clock says the forfeit is due, the server still
  // owns the verdict — ask it, and let it resolve. Nothing is decided here.
  useEffect(() => {
    if (!expired || terminal) return;
    void load();
  }, [expired, terminal, load]);

  // ── Realtime sync ──────────────────────────────────────────────────────
  const mySeatKey = seat ?? null;
  useEffect(() => {
    if (!socket || !matchId) return undefined;
    const roomId = sudokuDuelMatchRoom(matchId);
    const join = () => socket.emit("join_room", { roomId });
    join();
    // Socket.IO does not restore room membership across a reconnect, so
    // re-join on every connect — that is also what cancels the realtime
    // server's disconnect-forfeit timer for this seat.
    socket.on("connect", join);

    const onUpdate = () => loadRef.current();
    const forThisMatch = (payload: { matchId?: unknown } | null | undefined) =>
      !payload ||
      payload.matchId == null ||
      String(payload.matchId) === String(matchId);
    const onCountdown = (payload: { goAtMs?: number; matchId?: string | number }) => {
      if (!forThisMatch(payload)) return;
      if (typeof payload?.goAtMs === "number" && Number.isFinite(payload.goAtMs)) {
        setGoAtOverride(payload.goAtMs);
        setNow(Date.now());
      }
    };
    const onProgress = (payload: OpponentProgressPayload) => {
      // Only ever the OTHER seat's numbers, only ever server-derived ones, and
      // only ever for this match.
      if (!payload || payload.seatKey === mySeatKey) return;
      if (!forThisMatch(payload)) return;
      setLiveOpponent(payload);
    };

    socket.on(SUDOKU_DUEL_EVENTS.MATCH_UPDATED, onUpdate);
    socket.on(SUDOKU_DUEL_EVENTS.COUNTDOWN, onCountdown);
    socket.on(SUDOKU_DUEL_EVENTS.MATCH_STARTED, onCountdown);
    socket.on(SUDOKU_DUEL_EVENTS.OPPONENT_PROGRESS, onProgress);
    socket.on(SUDOKU_DUEL_EVENTS.MATCH_FINISHED, onUpdate);

    return () => {
      socket.off("connect", join);
      socket.off(SUDOKU_DUEL_EVENTS.MATCH_UPDATED, onUpdate);
      socket.off(SUDOKU_DUEL_EVENTS.COUNTDOWN, onCountdown);
      socket.off(SUDOKU_DUEL_EVENTS.MATCH_STARTED, onCountdown);
      socket.off(SUDOKU_DUEL_EVENTS.OPPONENT_PROGRESS, onProgress);
      socket.off(SUDOKU_DUEL_EVENTS.MATCH_FINISHED, onUpdate);
      socket.emit("leave_room", { roomId });
    };
  }, [socket, matchId, mySeatKey]);

  // ── Sending: the ONLY thing this page ever tells the server ────────────
  const sendAction = useCallback(
    async (action: SudokuAction) => {
      const current = matchRef.current;
      if (!matchId || !current) return;
      const expectedPly = Number(current.view?.ply ?? 0);

      inFlightRef.current = true;
      setPending(true);
      setPendingIndex(action.index);
      setNotice(null);
      try {
        const res = await fetch(`${apiMatch}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The whole request: an action and this seat's own cursor.
          body: JSON.stringify({ action, expectedPly }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          // Refused by the server (a stale cursor, the clock, a finished seat, a
          // clue cell) — say so quietly and resync rather than guessing.
          setNotice(data?.error || "That move was refused");
          void load();
          return;
        }

        // The authoritative post-action snapshot. Its board holds only values
        // the server verified; a wrong value was never written, so there is
        // nothing to roll back and nothing to reveal.
        adopt(data.data.match as MatchDto);
        // A bare nudge so the opponent's view refreshes immediately; the
        // realtime server only relays the match id.
        socket?.emit(SUDOKU_DUEL_EVENTS.READY, { matchId });

        if (data.data.correct === false && data.data.verdict === "incorrect") {
          // A wrong value: not written, answer not revealed. Just the cost.
          setInvalidIndex(action.index);
          setNotice("Not that one — +1 mistake, +1s penalty");
        } else if (data.data.completed || data.data.raceResolved) {
          void load();
        }
      } catch {
        setNotice("Connection hiccup — resyncing");
        void load();
      } finally {
        inFlightRef.current = false;
        setPending(false);
        setPendingIndex(null);
      }
    },
    [adopt, apiMatch, load, matchId, socket],
  );

  const canPlayNow =
    phase === "racing" && !expired && !pending && !myCompleted;

  // ── Interaction (selection is local; the VALUE never is) ───────────────
  const selectCell = useCallback((index: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= CELL_COUNT) return;
    setSelectedIndex(index);
  }, []);

  const moveSelection = useCallback((delta: number) => {
    setSelectedIndex((prev) => {
      if (prev == null) return 0;
      const next = prev + delta;
      if (next < 0 || next >= CELL_COUNT) return prev;
      // A left/right step must not wrap onto the next row — it reads as a jump.
      if (Math.abs(delta) === 1 && Math.floor(next / SIZE) !== Math.floor(prev / SIZE)) {
        return prev;
      }
      return next;
    });
  }, []);

  const placeValue = useCallback(
    (value: number) => {
      const current = matchRef.current;
      const index = selectedRef.current;
      if (!current || index == null) return;
      if (!canPlayNow || inFlightRef.current) return;
      const currentView = current.view;
      if (!currentView) return;
      if (currentView.puzzle[index] !== EMPTY) return; // a clue: never editable
      if (currentView.entries[index] === value) return; // already correct there
      void sendAction({ kind: "place", index, value });
    },
    [canPlayNow, sendAction],
  );

  const eraseCell = useCallback(() => {
    const current = matchRef.current;
    const index = selectedRef.current;
    if (!current || index == null) return;
    if (!canPlayNow || inFlightRef.current) return;
    const currentView = current.view;
    if (!currentView) return;
    if (currentView.puzzle[index] !== EMPTY) return;
    if (currentView.entries[index] === EMPTY) return;
    void sendAction({ kind: "clear", index });
  }, [canPlayNow, sendAction]);

  // Keyboard play: arrows move the selection, 1-9 places, Backspace erases.
  useEffect(() => {
    if (phase !== "racing" || terminal) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (event.key >= "1" && event.key <= "9") {
        event.preventDefault();
        placeValue(Number(event.key));
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        eraseCell();
        return;
      }
      const deltas: Record<string, number> = {
        ArrowUp: -SIZE,
        ArrowDown: SIZE,
        ArrowLeft: -1,
        ArrowRight: 1,
      };
      const delta = deltas[event.key];
      if (delta !== undefined) {
        event.preventDefault();
        moveSelection(delta);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, terminal, placeValue, eraseCell, moveSelection]);

  // ── Exits ──────────────────────────────────────────────────────────────
  const resign = useCallback(async () => {
    if (resigning) return;
    setShowResign(false);
    setResigning(true);
    try {
      const res = await fetch(`${apiMatch}/forfeit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => null);
      if (data?.success) {
        adopt(data.data.match as MatchDto);
        socket?.emit(SUDOKU_DUEL_EVENTS.READY, { matchId });
      }
      void load();
    } finally {
      setResigning(false);
    }
  }, [adopt, apiMatch, load, matchId, resigning, socket]);

  const cancelLobby = useCallback(async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      await fetch(`${apiMatch}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      // Best effort — an abandoned lobby is reaped either way.
    } finally {
      setCancelling(false);
      setLeaving(true);
      router.push("/casino/sudoku-duel");
    }
  }, [apiMatch, cancelling, router]);

  const leaveWaiting = useCallback(() => {
    setLeaving(true);
    router.push("/casino/sudoku-duel");
  }, [router]);

  // A rematch is a NEW match: the server mints a new seed and derives a new
  // puzzle, and this page's per-match state is reset by the `matchId` effect.
  const requeue = useCallback(async () => {
    if (requeueing) return;
    setRequeueing(true);
    try {
      const res = await fetch("/api/sudoku-duel/create-or-join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        router.push(`/casino/sudoku-duel/${data.data.matchId}`);
      }
    } catch {
      // Fall through to the lobby below.
    } finally {
      setRequeueing(false);
    }
  }, [requeueing, router]);

  // ── View model ─────────────────────────────────────────────────────────
  const myProgress = match?.progress ?? null;
  const opponentProgress: OpponentProgress | null = liveOpponent ?? match?.opponent ?? null;
  const opponentSeat: Seat = mySeatKey === "player1" ? "player2" : "player1";
  const opponentIdentity: SeatIdentity = match?.players?.[opponentSeat] ?? null;
  const opponentName = match?.isAi ? "GRYND AI" : opponentIdentity?.name || "Opponent";

  const givens = Math.max(0, Math.trunc(Number(match?.givens) || 0));
  const totalEntries = Math.max(0, CELL_COUNT - givens);
  const myPercent = myProgress?.progressPercent ?? 0;
  const opponentPercent = opponentProgress?.progressPercent ?? 0;
  const outcome: ViewerOutcome = viewerOutcome(seat, match?.result) ?? "draw";
  const finishedBySolve = match?.resolutionReason === "finish";

  const countdownSeconds =
    countdownMs == null ? 0 : Math.max(0, Math.ceil(countdownMs / 1000));
  const showCountdown = phase === "countdown" || goFlash;

  const selectedGiven = Boolean(
    view && selectedIndex != null && view.puzzle[selectedIndex] !== EMPTY,
  );
  const selectedValue =
    view && selectedIndex != null ? Number(view.entries[selectedIndex]) || EMPTY : EMPTY;

  // How many of each digit are already visible on the viewer's own board —
  // clues plus the viewer's verified entries, never anything hidden.
  const placedCounts = useMemo(() => {
    const counts: Record<number, number> = {};
    if (!view) return counts;
    for (let i = 0; i < CELL_COUNT; i += 1) {
      const value = Number(view.entries[i]) || EMPTY;
      if (value !== EMPTY) counts[value] = (counts[value] ?? 0) + 1;
    }
    return counts;
  }, [view]);

  const padDisabled = !canPlayNow || selectedIndex == null || selectedGiven;
  const padHint = !view
    ? "Waiting for the server's board…"
    : myCompleted
      ? "You finished — the result is the server's."
      : terminal
        ? "The match is over."
        : expired
          ? "You've been idle too long — the server is resolving your forfeit."
          : selectedIndex == null
            ? "Select a cell first."
            : selectedGiven
              ? "That's a fixed clue — pick an empty cell."
              : "Tap a number to place it.";

  // Anchored to the server's GO instant, not the join instant: the race clock
  // (and `solveMs`) both start at GO, and the 3s countdown before it is not part
  // of the match. A timeout therefore reads exactly 10:00, never 10:03.
  const resultDuration = useMemo(
    () => durationSeconds(match?.goAtMs, match?.endedAtMs),
    [match?.goAtMs, match?.endedAtMs],
  );

  // ── The settled result, read off the server's journals ─────────────────
  //
  // Elementio/trophies are the movement the SETTLEMENT wrote for this viewer
  // (`rating_events` / `trophy_events`, keyed by user + game + match). The
  // client never computes a delta and never asks for one: when the journals
  // hold nothing (an unrated match, a cancelled lobby) it shows nothing.
  const settlement = match?.settlement ?? null;
  const eloMovement = settlement?.elo ?? null;
  const trophyMovement = settlement?.trophies ?? null;

  const progression = useMemo(() => {
    const rows: { label: string; from: string; to: string; percent: number }[] = [];
    // A pure DISPLAY meter: how large the swing was against the nominal ±30.
    // It is not a rating, a rating scale or a competitive value.
    const meter = (delta: number) =>
      Math.min(100, Math.max(8, Math.round((Math.abs(delta) / 30) * 100)));
    if (eloMovement) {
      rows.push({
        label: "Sudoku Duel Elo",
        from: String(eloMovement.before),
        to: String(eloMovement.after),
        percent: meter(eloMovement.delta),
      });
    }
    if (trophyMovement) {
      rows.push({
        label: "Sudoku Duel Trophies",
        from: String(trophyMovement.before),
        to: String(trophyMovement.after),
        percent: meter(trophyMovement.delta),
      });
    }
    return rows;
  }, [eloMovement, trophyMovement]);

  // The completion facts the settlement compared: the plain solve time (the
  // server's completion instant minus the server's GO instant) and the ADJUSTED
  // competitive time (solve + the per-mistake penalty). Both are formatting
  // subtractions over authoritative instants — nothing is decided here.
  const solve = solveMs(match?.goAtMs, match?.completedAtMs);
  const adjusted = adjustedFinishMs(match?.goAtMs, match?.completedAtMs, match?.penaltyMs);
  const penaltySeconds = Math.max(0, Math.round((match?.penaltyMs ?? 0) / 1000));
  const signed = (value: number) => `${value > 0 ? "+" : ""}${value}`;

  const phaseLabel = expired && !terminal
    ? "Inactive"
    : phase === "countdown"
      ? "Get ready"
      : phase === "racing"
        ? "Solving"
        : phase === "waiting"
          ? "Waiting"
          : terminal
            ? finished
              ? "Finished"
              : "Cancelled"
            : "Loading";

  const phaseTone: "live" | "waiting" | "muted" =
    phase === "racing" && !expired ? "live" : terminal ? "muted" : "waiting";

  const canCancelLobby = status === "waiting" && seat === "player1";

  const statusLine = terminal
    ? "Match over"
    : expired
      ? "You've been idle too long — the server is resolving your forfeit."
      : pending
        ? "Verifying your move…"
        : myCompleted
          ? "Board complete — waiting for the server's result."
          : phase === "racing"
            ? "Race to a complete board — fastest verified solve takes it."
            : "Waiting for the countdown…";

  return (
    <GameSessionHost
      autoStart={status === "playing"}
      autoStop={terminal}
      gameLabel="sudoku-duel"
    >
      <div className="min-h-screen overflow-x-clip bg-gradient-to-b from-[#100c02] via-[#0b0902] to-[#070502] px-2 pb-24 pt-20 text-white sm:px-6 md:pb-8">
        <NavigationBar currentPath="/casino" />

        <div className="mx-auto mt-4 w-full max-w-5xl">
          {/* ── Header: identity · lobby ─────────────────────────────── */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/25 bg-white/[0.04] px-3 py-2.5 sm:px-4">
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 text-lg font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-amber-200 via-amber-300 to-yellow-200 sm:text-2xl">
                <IconGridDots className="h-6 w-6 shrink-0 text-amber-400 sm:h-7 sm:w-7" />
                Sudoku Duel
              </h1>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-semibold uppercase tracking-widest text-amber-200/60">
                <span>Rated 1v1</span>
                <span aria-hidden="true">·</span>
                <span>Same puzzle for both seats</span>
                {difficultyLabel(match?.difficulty) && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{difficultyLabel(match?.difficulty)}</span>
                  </>
                )}
              </p>
            </div>

            <span
              data-testid="sudoku-status"
              className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-white/70"
            >
              {statusLabel(status) || "Loading"}
            </span>
          </div>

          {loading && !match && (
            <p className="mt-6 text-sm text-white/60" data-testid="sudoku-loading">
              Loading the match…
            </p>
          )}

          {loadError && !match && (
            <div
              data-testid="sudoku-error"
              className="mt-6 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200"
            >
              {loadError}
            </div>
          )}

          {match && (
            <div data-testid="sudoku-match" data-status={match.status}>
              {/* The inactivity alarm: raised once the viewer's OWN seat has been
                  idle for 15 minutes, with the 20-minute forfeit counting down. */}
              {alarmActive && (
                <div
                  role="alert"
                  data-testid="sudoku-inactivity-alarm"
                  className="mt-3 flex items-start gap-2 rounded-xl border border-amber-400/50 bg-amber-500/15 px-3 py-2.5 text-xs font-semibold text-amber-100"
                >
                  <IconAlertTriangle
                    size={16}
                    className="mt-0.5 shrink-0 text-amber-300"
                    aria-hidden="true"
                  />
                  <span>
                    You&apos;ve been idle too long. Make a move now or you&apos;ll
                    forfeit the match in {clockLabel(remainingMs ?? 0)}.
                  </span>
                </div>
              )}

              {/* The opponent's inactivity alarm: raised for the seat still
                  playing when the other side has been idle for 15 minutes. */}
              {opponentAlarmActive && (
                <div
                  role="status"
                  data-testid="sudoku-opponent-idle-alarm"
                  className="mt-3 flex items-start gap-2 rounded-xl border border-sky-400/40 bg-sky-500/10 px-3 py-2.5 text-xs font-semibold text-sky-100"
                >
                  <IconAlertTriangle
                    size={16}
                    className="mt-0.5 shrink-0 text-sky-300"
                    aria-hidden="true"
                  />
                  <span>
                    Your opponent has gone idle. Unless they move within{" "}
                    {clockLabel(opponentRemainingMs ?? 0)}, you win by forfeit.
                  </span>
                </div>
              )}

              {/* A dropped connection never tears the race down: the row is held
                  for this seat and the next poll restores everything. */}
              {loadError && (
                <p
                  data-testid="sudoku-stale"
                  className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
                >
                  Reconnecting to the match… your seat is held and your board will
                  be restored.
                </p>
              )}

              {phase === "waiting" && (
                <MatchWaiting
                  state={status === "ready" ? "ready" : "waiting"}
                  gameName="Sudoku Duel"
                  icon={<IconGridDots className="h-8 w-8 text-amber-400" />}
                  title="Waiting for an opponent"
                  subtitle="Pairing you with another Sudoku Duel player…"
                  seats={[
                    { label: "You", name: "You", occupied: true },
                    { label: "Opponent", occupied: false },
                  ]}
                  onCancel={canCancelLobby ? cancelLobby : null}
                  cancelLabel="Cancel lobby"
                  cancelling={cancelling}
                  onLeave={canCancelLobby ? null : leaveWaiting}
                  leaving={leaving}
                />
              )}

              {/* A cancelled lobby shows ONLY the cancellation card below: there
                  is no race to render, so the HUD, board and pad are suppressed
                  rather than left as an empty, disabled shell behind it. */}
              {phase !== "waiting" && !cancelled && (
                <div className="mt-3">
                  {/* ── The competitive HUD (the only place the opponent
                      appears — never their board) ──────────────────── */}
                  <CompetitiveHud
                    myPercent={myPercent}
                    myDetail={progressLabel(myProgress, totalEntries)}
                    myCompleted={myCompleted}
                    myMistakes={match.mistakeCount}
                    opponentPercent={opponentPercent}
                    opponentDetail={
                      opponentProgress
                        ? progressLabel(opponentProgress, totalEntries)
                        : "Waiting for the server's read…"
                    }
                    opponentCompleted={Boolean(opponentProgress?.completed)}
                    opponentName={opponentName}
                    opponentIdentity={opponentIdentity}
                    remainingMs={remainingMs}
                    elapsedMs={elapsedMs}
                    countdownActive={countdownActive}
                    expired={expired}
                    phaseLabel={phaseLabel}
                    phaseTone={phaseTone}
                  />

                  <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
                    {/* ── THE board (the main focus) ─────────────────── */}
                    <div className="relative rounded-2xl border border-amber-500/25 bg-black/45 p-2 sm:p-3">
                      <SudokuBoard
                        view={view}
                        interactive={phase === "racing" && !expired}
                        pending={pending}
                        pendingIndex={pendingIndex}
                        selectedIndex={selectedIndex}
                        invalidIndex={invalidIndex}
                        onSelect={selectCell}
                      />

                      <AnimatePresence>
                        {showCountdown && (
                          <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.15 }}
                            data-testid="sudoku-countdown"
                            className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center rounded-2xl bg-black/75 backdrop-blur-[2px]"
                          >
                            <p className="text-[11px] font-bold uppercase tracking-[0.3em] text-amber-200/70">
                              {countdownSeconds > 0 ? "Get ready" : "Go"}
                            </p>
                            <motion.p
                              key={countdownSeconds > 0 ? countdownSeconds : "go"}
                              initial={{ scale: 0.7, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              transition={{ type: "spring", stiffness: 300, damping: 18 }}
                              className="mt-1 font-mono text-6xl font-black text-amber-200 drop-shadow-[0_0_24px_rgba(251,191,36,0.5)] sm:text-8xl"
                            >
                              {countdownSeconds > 0 ? countdownSeconds : "GO"}
                            </motion.p>
                            <p className="mt-3 max-w-xs px-4 text-center text-[11px] leading-relaxed text-white/60">
                              Both seats receive this exact puzzle. Your board unlocks
                              the instant the server&apos;s clock reaches GO.
                            </p>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    {/* ── Pad · status · facts ───────────────────────── */}
                    <div className="space-y-3">
                      <SudokuNumberPad
                        onValue={placeValue}
                        onErase={eraseCell}
                        disabled={padDisabled}
                        canErase={
                          canPlayNow &&
                          selectedIndex != null &&
                          !selectedGiven &&
                          selectedValue !== EMPTY
                        }
                        placed={placedCounts}
                        hint={padHint}
                      />

                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2.5">
                        <span className="flex items-center gap-2 text-xs text-white/60">
                          <IconSwords size={15} className="text-amber-300" aria-hidden="true" />
                          {statusLine}
                        </span>
                        {!terminal && status === "playing" && !expired && (
                          <button
                            type="button"
                            data-testid="sudoku-resign"
                            onClick={() => setShowResign(true)}
                            className="inline-flex items-center gap-1 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-300 transition hover:bg-red-500/20"
                          >
                            <IconDoorExit size={13} aria-hidden="true" /> Resign
                          </button>
                        )}
                      </div>

                      {/* Unobtrusive, transient: a refused or wrong move never
                          blocks play and never changes a progress figure. */}
                      <AnimatePresence>
                        {notice && (
                          <motion.p
                            initial={{ opacity: 0, y: -4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            data-testid="sudoku-notice"
                            className="rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-center text-[11px] font-semibold text-amber-200"
                          >
                            {notice}
                          </motion.p>
                        )}
                      </AnimatePresence>

                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                        <Fact
                          label="Your progress"
                          value={progressLabel(myProgress, totalEntries)}
                          icon={<IconCheck size={14} className="text-amber-300" />}
                        />
                        <Fact
                          label="Opponent progress"
                          value={
                            opponentProgress
                              ? progressLabel(opponentProgress, totalEntries)
                              : "Awaiting the server's read"
                          }
                          icon={<IconFlag size={14} className="text-[#00e5ff]" />}
                        />
                        <Fact
                          label="Your mistakes"
                          value={`${mistakeLabel(match.mistakeCount)} · ${Math.round(
                            (match.penaltyMs ?? 0) / 1000,
                          )}s penalty`}
                          icon={<IconAlertTriangle size={14} className="text-red-300/80" />}
                        />
                        <Fact
                          label="Race clock"
                          value={
                            remainingMs == null
                              ? "Starts at GO"
                              : expired
                                ? "Expired — server decides"
                                : `${clockLabel(remainingMs)} remaining`
                          }
                          icon={<IconHourglassHigh size={14} className="text-white/60" />}
                        />
                      </div>

                      <p className="px-1 text-[11px] leading-relaxed text-white/40">
                        The server owns the puzzle, the clock, your progress and the
                        winner. Every value you enter is verified against its own board
                        before it counts — a wrong value is never written and the
                        answer is never shown.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Cancelled lobby ──────────────────────────────────────── */}
          {cancelled && (
            <div
              data-testid="sudoku-cancelled"
              className="mx-auto mt-6 max-w-lg rounded-2xl border border-white/15 bg-white/5 p-6 text-center"
            >
              <p className="text-sm font-bold text-white">This match was cancelled.</p>
              <p className="mt-2 text-xs text-white/60">
                Nothing was rated. Find another opponent whenever you are ready.
              </p>
              <button
                type="button"
                onClick={() => router.push("/casino/sudoku-duel")}
                className="mt-4 inline-flex items-center justify-center rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-bold text-amber-200 transition hover:bg-amber-500/20"
              >
                Back to the Sudoku Duel lobby
              </button>
            </div>
          )}

          {/* ── Resign confirmation ──────────────────────────────────── */}
          <AnimatePresence>
            {showResign && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 px-4"
                role="dialog"
                aria-modal="true"
                aria-label="Resign this match?"
              >
                <div className="w-full max-w-sm rounded-2xl border border-red-500/40 bg-[#160a0c] p-5 text-center">
                  <IconAlertTriangle className="mx-auto h-7 w-7 text-red-300" aria-hidden="true" />
                  <p className="mt-2 text-sm font-bold text-white">Resign this match?</p>
                  <p className="mt-1.5 text-xs leading-relaxed text-white/60">
                    Your opponent is awarded the win and the match settles immediately.
                    This cannot be undone.
                  </p>
                  <div className="mt-4 flex flex-col gap-2">
                    <button
                      type="button"
                      data-testid="sudoku-resign-confirm"
                      onClick={() => void resign()}
                      disabled={resigning}
                      className="w-full rounded-xl bg-red-500 px-4 py-2.5 text-sm font-black text-black transition hover:brightness-110 disabled:opacity-60"
                    >
                      {resigning ? "Resigning…" : "Resign and lose"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowResign(false)}
                      className="w-full rounded-xl border border-white/15 px-4 py-2.5 text-sm font-semibold text-white/75 transition hover:bg-white/5"
                    >
                      Keep playing
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* The authoritative result: the outcome, the winner, both seats' verified
          progress and the duration are all read off the settled row. Nothing
          here is computed. */}
      <PvpResultScreen
        open={phase === "result" && finished}
        outcome={outcome}
        headline={
          outcome === "draw"
            ? "Dead heat — the duel is a draw"
            : outcome === "win"
              ? finishedBySolve
                ? "You solved it first"
                : "You took the duel"
              : finishedBySolve
                ? `${opponentName} solved it first`
                : `${opponentName} took the duel`
        }
        subline={
          resolutionLabel(match?.resolutionReason) ??
          (outcome === "win" ? "You finished the board first." : "Match settled by the server.")
        }
        opponent={{
          name: opponentName,
          iconKey: opponentIdentity?.iconKey ?? null,
          profileFrame: opponentIdentity?.profileFrame ?? null,
        }}
        gameName="Sudoku Duel"
        gameKey="sudoku-duel"
        durationSeconds={resultDuration}
        sides={[
          {
            name: "You",
            score: `${Math.max(0, myProgress?.correctCells ?? 0)}/${totalEntries}`,
            highlight: outcome === "win",
          },
          {
            name: opponentName,
            score: `${Math.max(0, opponentProgress?.correctCells ?? 0)}/${totalEntries}`,
            highlight: outcome === "loss",
          },
        ]}
        progress={progression}
        summary={[
          // A completed board reports the completion facts the settlement used
          // (plain time, the accumulated penalty, the adjusted final time); a
          // timeout reports the progress it was decided on instead, since there
          // is no completion to state.
          ...(solve != null
            ? [
                { label: "Completion time", value: clockLabel(solve) },
                {
                  label: "Penalty",
                  value: `${penaltySeconds}s · ${mistakeLabel(match?.mistakeCount)}`,
                },
                {
                  label: "Final time",
                  value: adjusted != null ? clockLabel(adjusted) : "—",
                },
              ]
            : [
                { label: "Ended", value: "Timeout — no completion" },
                { label: "Mistakes", value: mistakeLabel(match?.mistakeCount) },
                { label: "Penalty", value: `${penaltySeconds}s` },
              ]),
          {
            label: "Your cells",
            value: `${progressLabel(myProgress, totalEntries)} · ${myPercent}%`,
          },
          {
            label: "Opponent cells",
            value: opponentProgress
              ? `${progressLabel(opponentProgress, totalEntries)} · ${opponentPercent}%`
              : "—",
          },
          {
            label: "Opponent mistakes",
            value: mistakeLabel(opponentProgress?.mistakes ?? 0),
          },
          // The rule that actually decided it — the tiebreak the settlement
          // applied, in words, so a timeout never reads as a coin toss.
          { label: "Decided by", value: tiebreakLabel(match?.resolutionReason) || "—" },
        ]}
        details={[
          { label: "Match ID", value: String(match?.matchId ?? "") },
          { label: "Difficulty", value: difficultyLabel(match?.difficulty) || "—" },
          { label: "Clues", value: givensLabel(givens) || "—" },
          { label: "Ended by", value: resolutionLabel(match?.resolutionReason) || "—" },
          {
            label: "Winner",
            value: outcome === "draw" ? "Draw" : outcome === "win" ? "You" : opponentName,
          },
          // Only ever the journal's own before/after — never a client delta.
          ...(eloMovement
            ? [
                {
                  label: "Elo movement",
                  value: `${signed(eloMovement.delta)} (${eloMovement.before} → ${eloMovement.after})`,
                },
              ]
            : []),
          ...(trophyMovement
            ? [
                {
                  label: "Trophy movement",
                  value: `${signed(trophyMovement.delta)} (${trophyMovement.before} → ${trophyMovement.after})`,
                },
              ]
            : []),
        ]}
        playAgain={{ label: "REMATCH", onClick: requeue }}
        secondaryAction={{ label: "Back to games", href: "/casino" }}
        onReturnToLobby={() => router.push("/casino/sudoku-duel")}
      />
    </GameSessionHost>
  );
}

function Fact({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-white/45">
        {icon}
        {label}
      </p>
      <p className="mt-0.5 text-xs font-semibold text-white/85">{value}</p>
    </div>
  );
}
