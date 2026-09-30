"use client";

// src/app/casino/solitaire-duel/[matchId]/PageClient.tsx
//
// The Solitaire Duel race view — the arena.
//
// ── AUTHORITY ───────────────────────────────────────────────────────────
//
// Every competitive value on this page is the SERVER's: the board (a
// projection that carries no face-down identities and no stock order), the
// progress figures, the completion, the GO instant, the deadline, the result
// and the winner. The only thing this page ever SENDS is a move — which cards,
// from where, to where, plus the per-seat ply cursor. It never sends a board, a
// progress value, a completion, a completion time, a score, a winner, a result,
// an Elo value or a trophy.
//
// There is no local prediction of the board either: a move is drawn from the
// snapshot the server answers with. The client cannot even render an optimistic
// flip, because a face-down identity is not in its view until the server names
// it in `revealed`. That is a deliberate simplification — the authoritative
// state IS the response — and it is why a rejected move can never leave the
// local board ahead of the server's.
//
// ── FLOW ────────────────────────────────────────────────────────────────
//
//   poll GET /api/solitaire-duel/match/<id>       (backstop, 1.5 s while live)
//   socket `lobby:updated` on `solitaire-duel:match:<id>` → immediate refetch
//   socket `solitaire-duel:opponent-progress`   → the opponent's bar, instantly
//   socket `solitaire-duel:countdown`/`match-started` → the server's GO instant
//   socket `solitaire-duel:match-finished`      → refetch the settled row
//   click a card, click a target → POST /move → adopt the returned snapshot
//   the clock reaches the deadline → STOP; the server resolves and this page
//   renders the result it is handed (fetchMatch resolves a due match on read)
//
// The timer ticks locally at 200 ms but is anchored to the server's clock
// (`serverNow` in every snapshot), so a client with a wrong clock or a slow
// connection still counts down to the server's GO and deadline. There is no
// server tick per frame and no server call per tick.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useParams, useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { AnimatePresence, motion } from "framer-motion";
import {
  IconAlertTriangle,
  IconCards,
  IconClock,
  IconDoorExit,
  IconFlag,
  IconHourglassHigh,
  IconSwords,
} from "@tabler/icons-react";

import NavigationBar from "../../../../components/navigation-bar";
import GameSessionHost from "../../../../components/GameSessionHost";
import MatchWaiting from "../../../../components/lobby/MatchWaiting";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import FrameAvatar from "../../../../components/FrameAvatar";
import SolitaireBoard from "../../../../components/solitaire-duel/SolitaireBoard";
import { useSocket } from "../../../../context/SocketProvider";
import {
  SOLITAIRE_DUEL_EVENTS,
  solitaireDuelMatchRoom,
} from "../../../../lib/solitaire-duel/rooms";
import {
  clockLabel,
  durationSeconds,
  progressLabel,
  resolutionLabel,
  viewerOutcome,
} from "../../../../lib/solitaire-duel/ui";
import type {
  OpponentProgress,
  Seat,
  SeatProgress,
  SolitaireMove,
  SolitaireView,
} from "../../../../lib/solitaire-duel/types";

// ── The server's snapshot, as this page consumes it ───────────────────────

type SeatIdentity = {
  name?: string | null;
  iconKey?: string | null;
  nameColor?: string | null;
  profileFrame?: unknown;
} | null;

type MatchDto = {
  matchId: string;
  variant: string;
  variantVersion: number;
  status: string;
  result: string | null;
  resolutionReason: string | null;
  winnerId: string | null;
  seat: Seat | null;
  isParticipant: boolean;
  goAtMs: number | null;
  deadlineAtMs: number | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  createdAtMs: number | null;
  serverNow: number;
  view: SolitaireView | null;
  progress: SeatProgress | null;
  opponent: OpponentProgress | null;
  players?: { player1: SeatIdentity; player2: SeatIdentity } | null;
};

type OpponentProgressPayload = OpponentProgress & { matchId?: string };

const LIVE_POLL_MS = 1500;
/** How long the "GO" flash stays up once the countdown reaches zero. */
const GO_FLASH_MS = 700;
/** How long an invalid-move notice lingers. */
const NOTICE_MS = 2200;

const TERMINAL = new Set(["finished", "cancelled"]);

/** True when `next` must not replace `prev` — a stale poll losing to a move. */
function isStaleSnapshot(prev: MatchDto | null, next: MatchDto | null): boolean {
  if (!prev || !next) return false;
  // The viewer's OWN ply only ever grows, so a lower one is an older read that
  // raced a move response. (`peakFoundation` and the opponent's figures are not
  // used for this: the opponent's foundations can legitimately go DOWN when a
  // card is pulled back into the tableau.)
  const prevPly = Number(prev.view?.ply ?? -1);
  const nextPly = Number(next.view?.ply ?? -1);
  if (prevPly >= 0 && nextPly >= 0 && nextPly < prevPly) return true;
  // A settled match can never be un-settled by a late read.
  if (TERMINAL.has(String(prev.status)) && !TERMINAL.has(String(next.status))) return true;
  return false;
}

function Meter({
  label,
  percent,
  detail,
  tone,
  completed,
  identity,
}: {
  label: string;
  percent: number;
  detail: string;
  tone: "mine" | "theirs";
  completed?: boolean;
  identity?: SeatIdentity;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div
      data-testid={`solitaire-meter-${tone}`}
      data-percent={clamped}
      data-completed={completed ? "true" : "false"}
      className="rounded-xl border border-white/10 bg-black/35 px-3 py-2.5"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          {tone === "theirs" && identity?.iconKey ? (
            <FrameAvatar
              frame={identity.profileFrame}
              iconKey={identity.iconKey}
              name={identity.name || "Opponent"}
              size="h-6 w-6"
            />
          ) : (
            <span
              aria-hidden="true"
              className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                tone === "mine" ? "bg-amber-400" : "bg-[#00e5ff]"
              }`}
            />
          )}
          <span className="truncate text-xs font-bold uppercase tracking-wider text-white/75">
            {label}
          </span>
          {completed && (
            <span className="shrink-0 rounded-full border border-emerald-400/50 bg-emerald-400/15 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-emerald-300">
              Solved
            </span>
          )}
        </span>
        <span className="shrink-0 font-mono text-lg font-black tabular-nums text-white">
          {clamped}%
        </span>
      </div>
      <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-white/10">
        <div
          className={
            tone === "mine"
              ? "h-full rounded-full bg-gradient-to-r from-amber-500 to-amber-300 transition-[width] duration-200"
              : "h-full rounded-full bg-gradient-to-r from-sky-500 to-[#00e5ff] transition-[width] duration-200"
          }
          style={{ width: `${clamped}%` }}
        />
      </div>
      <p className="mt-1 truncate text-[10px] text-white/45">{detail}</p>
    </div>
  );
}

export default function SolitaireDuelMatchPage() {
  const params = useParams<{ matchId: string }>();
  const router = useRouter();
  const { socket } = useSocket();
  const { user } = useUser();
  const matchId = params?.matchId;
  const apiMatch = `/api/solitaire-duel/match/${matchId}`;

  const [match, setMatch] = useState<MatchDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [liveOpponent, setLiveOpponent] = useState<OpponentProgressPayload | null>(null);
  const [goAtOverride, setGoAtOverride] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [goFlash, setGoFlash] = useState(false);
  const [showResign, setShowResign] = useState(false);
  const [resigning, setResigning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [requeueing, setRequeueing] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const loadedRef = useRef(false);
  const matchRef = useRef<MatchDto | null>(null);
  // The server's clock, as an offset from this browser's. Every snapshot
  // carries `serverNow`, so the countdown and the timer are anchored to the
  // server's timeline rather than to the local clock.
  const skewRef = useRef(0);
  const inFlightRef = useRef(false);
  const queuedDrawsRef = useRef(0);
  const sendMoveRef = useRef<(move: SolitaireMove) => void>(() => {});
  const loadRef = useRef<() => void>(() => {});

  useEffect(() => {
    matchRef.current = match;
  }, [match]);

  // The App Router reuses this component when only `[matchId]` differs, so
  // every per-match value is reset — a rematch must never inherit the previous
  // race's board, timer or result.
  useEffect(() => {
    setMatch(null);
    setLoadError(null);
    setLiveOpponent(null);
    setGoAtOverride(null);
    setNotice(null);
    setPending(false);
    setGoFlash(false);
    setShowResign(false);
    setResigning(false);
    setCancelling(false);
    setLeaving(false);
    loadedRef.current = false;
    skewRef.current = 0;
    inFlightRef.current = false;
    queuedDrawsRef.current = 0;
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
  const deadlineAtMs = match?.deadlineAtMs ?? null;
  const countdownMs = goAtMs == null ? null : Math.max(0, goAtMs - serverNowMs);
  const remainingMs = deadlineAtMs == null ? null : Math.max(0, deadlineAtMs - serverNowMs);
  const racing = Boolean(match) && !terminal && countdownMs === 0;
  const expired = remainingMs != null && remainingMs <= 0;

  const phase = useMemo(() => {
    if (!match) return loadError && !loadedRef.current ? ("error" as const) : ("loading" as const);
    if (terminal) return "result" as const;
    if (status === "waiting" || status === "ready") return "waiting" as const;
    if (countdownMs == null || countdownMs > 0) return "countdown" as const;
    return "racing" as const;
  }, [match, loadError, terminal, status, countdownMs]);

  // ── Clock (only while a clock is on screen) ────────────────────────────
  useEffect(() => {
    if (phase !== "countdown" && phase !== "racing") return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [phase]);

  // A short "GO" flash on the countdown → racing edge, so the moment moves
  // unlock is explicit without blocking play (it is pointer-events-none).
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

  // ── Poll backstop ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!matchId || !match || terminal) return undefined;
    const id = window.setInterval(() => void load(), LIVE_POLL_MS);
    return () => window.clearInterval(id);
  }, [matchId, match, terminal, load]);

  // When the local clock says the deadline has passed, the server still owns
  // the verdict — ask it, and let it resolve. Nothing is decided here.
  useEffect(() => {
    if (!expired || terminal) return;
    void load();
  }, [expired, terminal, load]);

  // ── Realtime sync ──────────────────────────────────────────────────────
  const mySeatKey = seat ?? null;
  useEffect(() => {
    if (!socket || !matchId) return undefined;
    const roomId = solitaireDuelMatchRoom(matchId);
    const join = () => socket.emit("join_room", { roomId });
    join();
    // Socket.IO does not restore room membership across a reconnect, so
    // re-join on every connect — that is also what cancels the realtime
    // server's disconnect-forfeit timer for this seat.
    socket.on("connect", join);

    const onUpdate = () => loadRef.current();
    const forThisMatch = (payload: { matchId?: unknown } | null | undefined) =>
      // Every server emission carries the match id in its envelope. A payload
      // that names a DIFFERENT match is ignored outright, so no event from any
      // other room can move this board's state.
      !payload ||
      payload.matchId == null ||
      String(payload.matchId) === String(matchId);
    const onCountdown = (payload: { goAtMs?: number; matchId?: string }) => {
      if (!forThisMatch(payload)) return;
      if (typeof payload?.goAtMs === "number") {
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

    socket.on(SOLITAIRE_DUEL_EVENTS.MATCH_UPDATED, onUpdate);
    socket.on(SOLITAIRE_DUEL_EVENTS.COUNTDOWN, onCountdown);
    socket.on(SOLITAIRE_DUEL_EVENTS.MATCH_STARTED, onCountdown);
    socket.on(SOLITAIRE_DUEL_EVENTS.OPPONENT_PROGRESS, onProgress);
    socket.on(SOLITAIRE_DUEL_EVENTS.MATCH_FINISHED, onUpdate);

    return () => {
      socket.off("connect", join);
      socket.off(SOLITAIRE_DUEL_EVENTS.MATCH_UPDATED, onUpdate);
      socket.off(SOLITAIRE_DUEL_EVENTS.COUNTDOWN, onCountdown);
      socket.off(SOLITAIRE_DUEL_EVENTS.MATCH_STARTED, onCountdown);
      socket.off(SOLITAIRE_DUEL_EVENTS.OPPONENT_PROGRESS, onProgress);
      socket.off(SOLITAIRE_DUEL_EVENTS.MATCH_FINISHED, onUpdate);
      socket.emit("leave_room", { roomId });
    };
  }, [socket, matchId, mySeatKey]);

  // ── Sending: the ONLY thing this page ever tells the server ────────────
  const sendMove = useCallback(
    async (move: SolitaireMove) => {
      const current = matchRef.current;
      if (!matchId || !current) return;
      const expectedPly = Number(current.view?.ply ?? 0);

      inFlightRef.current = true;
      setPending(true);
      setNotice(null);
      try {
        const res = await fetch(`${apiMatch}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The whole request: a move and this seat's own cursor.
          body: JSON.stringify({ move, expectedPly }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          // Refused by the server (a stale cursor, the clock, a finished seat)
          // — say so quietly, drop any queued draws and resync rather than
          // guessing at a board.
          queuedDrawsRef.current = 0;
          setNotice(data?.error || "That move was refused");
          void load();
          return;
        }
        adopt(data.data.match as MatchDto);
        // A bare nudge so the opponent's view refreshes immediately; the
        // realtime server only relays the match id.
        socket?.emit(SOLITAIRE_DUEL_EVENTS.READY, { matchId });
        if (data.data.completed || data.data.raceResolved) void load();
      } catch {
        queuedDrawsRef.current = 0;
        setNotice("Connection hiccup — resyncing");
        void load();
      } finally {
        inFlightRef.current = false;
        setPending(false);
        // Drain one queued stock click, so cycling the deck stays responsive
        // without ever sending two moves at once.
        if (queuedDrawsRef.current > 0) {
          queuedDrawsRef.current -= 1;
          sendMoveRef.current({ kind: "draw" });
        }
      }
    },
    [adopt, apiMatch, load, matchId, socket],
  );

  useEffect(() => {
    sendMoveRef.current = (move: SolitaireMove) => void sendMove(move);
  }, [sendMove]);

  const canPlayNow = phase === "racing" && !expired && !pending;

  const onMove = useCallback(
    (move: SolitaireMove) => {
      if (phase !== "racing" || expired) return;
      if (inFlightRef.current) {
        // A stock cycle is the one action worth queuing: it is the only move a
        // player makes in rapid succession, and each one is applied in order.
        if (move.kind === "draw") {
          queuedDrawsRef.current = Math.min(queuedDrawsRef.current + 1, 8);
        }
        return;
      }
      void sendMove(move);
    },
    [expired, phase, sendMove],
  );

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
        socket?.emit(SOLITAIRE_DUEL_EVENTS.READY, { matchId });
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
      router.push("/casino/solitaire-duel");
    }
  }, [apiMatch, cancelling, router]);

  const leaveWaiting = useCallback(() => {
    setLeaving(true);
    router.push("/casino/solitaire-duel");
  }, [router]);

  // A rematch is a NEW match: the server mints a new seed and derives a new
  // deal, and this page's per-match state is reset by the `matchId` effect.
  const requeue = useCallback(async () => {
    if (requeueing) return;
    setRequeueing(true);
    try {
      const res = await fetch("/api/solitaire-duel/create-or-join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        router.push(`/casino/solitaire-duel/${data.data.matchId}`);
      }
    } catch {
      // Fall through to the lobby below.
    } finally {
      setRequeueing(false);
    }
  }, [requeueing, router]);

  // ── View model ─────────────────────────────────────────────────────────
  const myProgress = match?.progress ?? null;
  const opponentProgress = liveOpponent ?? match?.opponent ?? null;
  const seatKeyForIdentity: Seat = mySeatKey === "player1" ? "player2" : "player1";
  const opponentIdentity: SeatIdentity = match?.players?.[seatKeyForIdentity] ?? null;
  const opponentName = opponentIdentity?.name || "Opponent";
  const canCancelLobby = status === "waiting" && seat === "player1";
  const myFoundation = Math.max(0, myProgress?.foundationCards ?? 0);
  const opponentFoundation = Math.max(0, opponentProgress?.foundationCards ?? 0);
  const myPercent = myProgress?.progressPercent ?? 0;
  const opponentPercent = opponentProgress?.progressPercent ?? 0;
  const outcome = viewerOutcome(seat, match?.result) ?? "draw";
  const countdownSeconds =
    countdownMs == null ? 0 : Math.max(0, Math.ceil(countdownMs / 1000));
  const showCountdown = phase === "countdown" || goFlash;

  const resultDuration = useMemo(() => {
    if (match?.startedAtMs == null || match?.endedAtMs == null) return null;
    return durationSeconds(
      new Date(match.startedAtMs).toISOString(),
      new Date(match.endedAtMs).toISOString(),
    );
  }, [match?.startedAtMs, match?.endedAtMs]);

  const timerTone = expired
    ? "text-red-300 border-red-400/50 bg-red-500/10"
    : remainingMs != null && remainingMs < 30_000
      ? "text-amber-200 border-amber-400/50 bg-amber-500/10"
      : "text-white/85 border-white/15 bg-black/35";

  return (
    <GameSessionHost
      autoStart={status === "playing"}
      autoStop={terminal}
      gameLabel="solitaire-duel"
    >
      <div className="min-h-screen overflow-x-clip bg-gradient-to-b from-[#100c02] via-[#0b0902] to-[#070502] px-2 pb-24 pt-20 text-white sm:px-6 md:pb-8">
        <NavigationBar currentPath="/casino" />

        <div className="mx-auto mt-4 w-full max-w-4xl">
          {/* ── Header: identity · clock ─────────────────────────────── */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/25 bg-white/[0.04] px-3 py-2.5 sm:px-4">
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 text-lg font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-amber-200 via-amber-300 to-yellow-200 sm:text-2xl">
                <IconCards className="h-6 w-6 shrink-0 text-amber-400 sm:h-7 sm:w-7" />
                Solitaire Duel
              </h1>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-semibold uppercase tracking-widest text-amber-200/60">
                <span>Rated 1v1</span>
                <span aria-hidden="true">·</span>
                <span>Same deal for both seats</span>
                <span aria-hidden="true">·</span>
                <span>First to solve it wins</span>
              </p>
            </div>

            <div className="flex items-center gap-2">
              <span
                data-testid="solitaire-phase"
                className={`rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-wider ${
                  phase === "racing" && !expired
                    ? "border-amber-400/50 bg-amber-500/10 text-amber-200"
                    : terminal
                      ? "border-white/20 bg-white/5 text-white/60"
                      : "border-[#00e5ff]/40 bg-[#00e5ff]/10 text-[#9beaff]"
                }`}
              >
                {expired && !terminal
                  ? "Time up"
                  : phase === "countdown"
                    ? "Get ready"
                    : phase === "racing"
                      ? "Racing"
                      : phase === "waiting"
                        ? "Waiting"
                        : terminal
                          ? finished
                            ? "Finished"
                            : "Cancelled"
                          : "Loading"}
              </span>

              <span
                data-testid="solitaire-timer"
                data-remaining-ms={remainingMs ?? -1}
                className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 font-mono text-lg font-black tabular-nums ${timerTone}`}
              >
                <IconClock size={16} aria-hidden="true" />
                {remainingMs == null ? "--:--" : clockLabel(remainingMs)}
              </span>
            </div>
          </div>

          {loading && !match && (
            <p className="mt-6 text-sm text-white/60" data-testid="solitaire-loading">
              Loading the match…
            </p>
          )}

          {loadError && !match && (
            <div
              data-testid="solitaire-error"
              className="mt-6 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200"
            >
              {loadError}
            </div>
          )}

          {match && (
            <div data-testid="solitaire-match" data-status={match.status}>
              {/* A dropped connection never tears the race down: the row is
                  held for this seat and the next poll restores everything. */}
              {loadError && (
                <p
                  data-testid="solitaire-stale"
                  className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
                >
                  Reconnecting to the match… your seat is held and your board will be
                  restored.
                </p>
              )}

              {phase === "waiting" && (
                <MatchWaiting
                  state={status === "ready" ? "ready" : "waiting"}
                  gameName="Solitaire Duel"
                  icon={<IconCards className="h-8 w-8 text-amber-400" />}
                  title="Waiting for an opponent"
                  subtitle="Pairing you with another Solitaire Duel player…"
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

              {phase !== "waiting" && (
                <div className="mt-3 space-y-3">
                  {/* ── Competitive information ────────────────────── */}
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Meter
                      label="You"
                      percent={myPercent}
                      detail={progressLabel(myProgress)}
                      tone="mine"
                      completed={Boolean(match.view?.completed)}
                    />
                    <Meter
                      label={opponentName}
                      percent={opponentPercent}
                      detail={
                        opponentProgress
                          ? progressLabel(opponentProgress)
                          : "Waiting for the server's read…"
                      }
                      tone="theirs"
                      completed={Boolean(opponentProgress?.completed)}
                      identity={opponentIdentity}
                    />
                  </div>

                  {/* ── The board (the main focus) ─────────────────── */}
                  <div className="relative rounded-2xl border border-amber-500/25 bg-black/45 p-2 sm:p-4">
                    <SolitaireBoard
                      view={view}
                      interactive={canPlayNow}
                      pending={pending}
                      onMove={onMove}
                      onInvalid={(message) => setNotice(message)}
                    />

                    <AnimatePresence>
                      {showCountdown && (
                        <motion.div
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.15 }}
                          data-testid="solitaire-countdown"
                          className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center rounded-2xl bg-black/70 backdrop-blur-[2px]"
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
                            Both seats receive this exact deal. Your cards unlock the
                            instant the server&apos;s clock reaches GO.
                          </p>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  {/* ── Status line + exits ───────────────────────── */}
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2.5">
                    <span className="flex items-center gap-2 text-xs text-white/60">
                      <IconSwords size={15} className="text-amber-300" aria-hidden="true" />
                      {terminal
                        ? "Match over"
                        : expired
                          ? "The clock has run out — waiting for the server's verdict."
                          : pending
                            ? "Verifying your move…"
                            : phase === "racing"
                              ? "Race for the foundations — fastest solve takes it."
                              : "Waiting for the countdown…"}
                    </span>

                    <span className="flex items-center gap-2">
                      {!terminal && status === "playing" && !expired && (
                        <button
                          type="button"
                          data-testid="solitaire-resign"
                          onClick={() => setShowResign(true)}
                          className="inline-flex items-center gap-1 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-300 transition hover:bg-red-500/20"
                        >
                          <IconDoorExit size={13} aria-hidden="true" /> Resign
                        </button>
                      )}
                    </span>
                  </div>

                  {/* Unobtrusive, transient: a refused move never blocks play
                      and never changes a progress figure. */}
                  <AnimatePresence>
                    {notice && (
                      <motion.p
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        data-testid="solitaire-notice"
                        className="mx-auto w-fit rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-center text-[11px] font-semibold text-amber-200"
                      >
                        {notice}
                      </motion.p>
                    )}
                  </AnimatePresence>

                  {/* ── Race facts ────────────────────────────────── */}
                  <div className="grid gap-2 sm:grid-cols-3">
                    <Fact
                      label="Your progress"
                      value={progressLabel(myProgress)}
                      icon={<IconSwords size={14} className="text-amber-300" />}
                    />
                    <Fact
                      label="Opponent progress"
                      value={
                        opponentProgress
                          ? progressLabel(opponentProgress)
                          : "Awaiting the server's read"
                      }
                      icon={<IconFlag size={14} className="text-[#00e5ff]" />}
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

                  <p className="px-1 text-center text-[11px] leading-relaxed text-white/40">
                    The server owns the deal, the clock, your progress and the winner.
                    Every card you move is verified against its board before it counts —
                    a rejected move leaves your board exactly where it was.
                  </p>
                </div>
              )}
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
                      data-testid="solitaire-resign-confirm"
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

      {/* The authoritative result: the outcome, the winner and the duration are
          all read off the settled row. Nothing here is computed. */}
      <PvpResultScreen
        open={phase === "result" && finished}
        outcome={outcome}
        headline={
          outcome === "draw"
            ? "Dead heat — the race is a draw"
            : outcome === "win"
              ? "You took the duel"
              : `${opponentName} took the duel`
        }
        subline={
          resolutionLabel(match?.resolutionReason) ??
          (outcome === "win" ? "You solved it first." : "Match settled by the server.")
        }
        opponent={{
          name: opponentName,
          iconKey: opponentIdentity?.iconKey ?? null,
          profileFrame: opponentIdentity?.profileFrame ?? null,
        }}
        gameName="Solitaire Duel"
        gameKey="solitaire-duel"
        durationSeconds={resultDuration}
        sides={[
          {
            name: "You",
            score: `${myFoundation}/52`,
            highlight: outcome === "win",
          },
          {
            name: opponentName,
            score: `${opponentFoundation}/52`,
            highlight: outcome === "loss",
          },
        ]}
        summary={[
          { label: "Your foundations", value: `${myFoundation}/52` },
          { label: "Opponent foundations", value: `${opponentFoundation}/52` },
          {
            label: "Your revealed cards",
            value: String(Math.max(0, myProgress?.revealedTableau ?? 0)),
          },
        ]}
        details={[
          { label: "Match ID", value: String(match?.matchId ?? "") },
          { label: "Ended by", value: resolutionLabel(match?.resolutionReason) || "—" },
          {
            label: "Winner",
            value: outcome === "draw" ? "Draw" : outcome === "win" ? "You" : opponentName,
          },
        ]}
        playAgain={{ label: "REMATCH", onClick: requeue }}
        secondaryAction={{ label: "Back to games", href: "/casino" }}
        onReturnToLobby={() => router.push("/casino/solitaire-duel")}
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
