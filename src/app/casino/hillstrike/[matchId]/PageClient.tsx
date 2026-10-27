"use client";

// src/app/casino/hillstrike/[matchId]/PageClient.tsx
//
// The online Hillstrike match view.
//
// ── AUTHORITY ─────────────────────────────────────────────────────────────
//
// The server owns the battlefield. The ONLY thing this page ever sends is an
// ACTION plus the version it was shown:
//
//   { action: { type: "shoot", angleDeg, power }, expectedVersion }
//   { action: { type: "move", direction }, expectedVersion }
//
// and, when its countdown reaches zero, an empty POST to the match's `timeout`
// route — which carries no verdict either: the SERVER compares its own clock and
// the engine's `finishOnTime` names the winner (more HP) or a draw (level HP).
//
// No trajectory, no impact, no hit, no damage, no HP total, no position, no
// block, no terrain, no tower layout, no turn owner, no winner and no completion
// flag is ever sent — and none is ever derived locally as truth. What the player
// sees is the server's `gameState`, the server's `isViewerTurn`, the server's
// `actionsRemaining`, the server's `deadlineAt` and the server's `result` /
// `winnerId` / `resultReason` for the result screen.
//
// The engine is used here for ONE thing: the dotted aiming preview, which runs
// the same `simulateShot` the server runs so a drag shows where the shot would
// land. That preview is an affordance, never a result: the animation of an
// accepted action is what the SERVER resolved and returned, and the HP / turn
// changes are the server's too.
//
// Optimism is limited to FEEDBACK: the aim is cleared on submit and the board
// waits for the authoritative snapshot. The view is never allowed to drift from
// the server.
//
// ── FLOW ──────────────────────────────────────────────────────────────────
//
//   poll GET /api/hillstrike/match/<id>   (adaptive interval, aborted on push)
//   socket `lobby:updated` on `hillstrike:match:<id>` → immediate refetch
//   drag → aim → Fire → POST /shot → adopt the returned snapshot
//   → emit `hillstrike:ready` so the opponent refetches in ~50 ms
//   waiting → MatchWaiting (creator can cancel) · finished/cancelled → result
//
// RECONNECT is the same path as a first load: the snapshot is re-read, the socket
// re-joins its room on every connect, and the server's disconnect grace timer for
// this seat is cancelled by that re-join. A player who stays away past the grace
// window is forfeited server-side; the survivor simply sees the terminal snapshot
// with reason `abandoned`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconBolt,
  IconClock,
  IconDoorExit,
  IconFlag,
  IconTargetArrow,
} from "@tabler/icons-react";

import { useSocket } from "../../../../context/SocketProvider";
import MatchLoading from "../../../../components/game/MatchLoading";
import MatchWaiting from "../../../../components/lobby/MatchWaiting";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import ReportModal from "../../../../components/ReportModal";
import GameSessionHost from "../../../../components/GameSessionHost";
import HillstrikeBattlefield, {
  type HillstrikeAnimation,
  type HillstrikePreview,
} from "../../../../components/hillstrike/HillstrikeBattlefield";
import {
  HILLSTRIKE_MATCH_UPDATED,
  HILLSTRIKE_READY,
  hillstrikeMatchRoom,
} from "../../../../lib/hillstrike/rooms";
import { MAX_HP, TICK_MS } from "../../../../lib/hillstrike/constants";
import { simulateShot } from "../../../../lib/hillstrike/physics";
import { hpOf } from "../../../../lib/hillstrike/rules";
import {
  clockLabel,
  durationSeconds,
  hpFor,
  hpLabel,
  isIncomingSnapshotStale,
  isTerminalStatus,
  loggedShotLabel,
  outcomeFor,
  resultReasonLabel,
  seatColor,
  seatLabel,
  seatName,
  statusLabel,
  turnLabel,
} from "../../../../lib/hillstrike/ui";
import type {
  HillstrikeAction,
  HillstrikeState,
  MoveDirection,
  Seat,
  ShotInput,
} from "../../../../lib/hillstrike/types";

const ACTIVE_POLL_MS = 1800;
const IDLE_POLL_MS = 5000;
/** How long the post-impact settle plays before input returns. */
const SETTLE_MS = 340;
/** The lobby, in its canonical form (`/games/hillstrike/play` rewrites here). */
const LOBBY_PATH = "/games/hillstrike/play";

/** Flight time for a resolved shot, bounded so a lob never stalls the match. */
function flightDuration(impactTick: number): number {
  return Math.max(220, Math.min(1400, Math.round(impactTick * TICK_MS)));
}

/** One tank's HP as a rail, the same shape the board draws over the turret. */
function hpRail(hp: number) {
  const ratio = Math.max(0, Math.min(1, hp / MAX_HP));
  const tone = ratio > 0.5 ? "bg-emerald-400" : ratio > 0.25 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full border border-white/15 bg-black/60">
      <div
        className={`h-full rounded-full transition-[width] duration-300 ${tone}`}
        style={{ width: `${(ratio * 100).toFixed(1)}%` }}
      />
    </div>
  );
}

export default function HillstrikeMatchPage() {
  const params = useParams<{ matchId: string }>();
  const { socket } = useSocket();
  const { user, isLoaded: identityLoaded } = useUser();
  const matchId = params?.matchId;
  const apiMatch = `/api/hillstrike/match/${matchId}`;
  const signedOut = identityLoaded && !user;

  const [match, setMatch] = useState<any>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [aim, setAim] = useState<ShotInput | null>(null);
  const [animation, setAnimation] = useState<HillstrikeAnimation | null>(null);
  const [resolving, setResolving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [showForfeitConfirm, setShowForfeitConfirm] = useState(false);
  const [forfeiting, setForfeiting] = useState(false);
  const [cancellingLobby, setCancellingLobby] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const matchRef = useRef<any>(null);
  const timersRef = useRef<number[]>([]);
  // One shared wall clock for the countdown, so the header re-renders on a tick
  // rather than on every poll.
  const [now, setNow] = useState<number>(() => Date.now());
  // The timeout POST is attempted at most once per match view; a refusal (the
  // server's clock is a second behind) resets it for the next tick.
  const timeoutRequestedRef = useRef(false);

  const clearTimers = useCallback(() => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current = [];
  }, []);

  // The App Router reuses this page instance when only `[matchId]` differs, so
  // every piece of per-match state is reset.
  useEffect(() => {
    setMatch(null);
    setLoadError(null);
    setAim(null);
    setAnimation(null);
    setResolving(false);
    setSubmitting(false);
    setNotice(null);
    setShowForfeitConfirm(false);
    setShowReportModal(false);
    matchRef.current = null;
    timeoutRequestedRef.current = false;
    clearTimers();
    return clearTimers;
  }, [matchId, clearTimers]);

  // The countdown's own tick. It only drives the display; the VERDICT is the
  // server's (see the timeout effect below).
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  /**
   * Install a snapshot. When the version advanced and the server attached a
   * resolved shot, animate THAT shot from the previous battlefield to the new
   * one — the same trajectory both seats render, never a locally simulated one.
   */
  const adopt = useCallback(
    (snapshot: any) => {
      const previous = matchRef.current;
      const previousState: HillstrikeState | null = previous?.gameState ?? null;
      const nextState: HillstrikeState | null = snapshot?.gameState ?? null;

      const advanced =
        previous &&
        Number(snapshot?.version) > Number(previous?.version) &&
        previousState &&
        nextState?.lastAction;

      if (advanced && nextState?.lastAction) {
        const record = nextState.lastAction;
        // Only a shot has a flight to wait for; a drive and a build settle
        // immediately so the board never stalls on an empty trajectory.
        const flightMs = record.type === "shoot" ? flightDuration(record.impact.tick) : 0;
        setResolving(true);
        setAnimation({
          action: record,
          from: previousState.battlefield,
          to: nextState.battlefield,
          startedAt: performance.now(),
          flightMs,
          settleMs: SETTLE_MS,
        });
        setAim(null);
        timersRef.current.push(
          window.setTimeout(() => {
            setAnimation(null);
            setResolving(false);
          }, flightMs + SETTLE_MS),
        );
      }

      matchRef.current = snapshot;
      setMatch(snapshot);
    },
    [],
  );

  // ── Fetching (also the reconnect path) ────────────────────────────────
  const fetchSnapshot = useCallback(
    async (signal?: AbortSignal) => {
      if (!matchId) return;
      if (signedOut) {
        setLoadError("Sign in to play this Hillstrike match.");
        return;
      }
      try {
        const res = await fetch(apiMatch, { cache: "no-store", signal });
        if (signal?.aborted) return;
        const data = await res.json().catch(() => null);
        if (signal?.aborted) return;
        if (!res.ok || !data?.success) {
          setLoadError(data?.error || "Unable to load this match");
          return;
        }
        // Several refreshes can be in flight at once; `version` is monotonic and
        // a same-version terminal snapshot can never be rolled back.
        if (!isIncomingSnapshotStale(matchRef.current, data.data)) adopt(data.data);
        setLoadError(null);
      } catch (error: any) {
        if (error?.name === "AbortError") return;
      }
    },
    [adopt, apiMatch, matchId, signedOut],
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
      // resume with one immediate catch-up when it is visible again.
      if (typeof document !== "undefined" && document.hidden) return;
      refresh();
      const idle = isTerminalStatus(matchRef.current?.status);
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
    const roomId = hillstrikeMatchRoom(matchId);
    const join = () => socket.emit("join_room", { roomId });
    join();
    // Socket.IO does not restore room membership across a reconnect, so re-join
    // on every connect — that is also what cancels the server's
    // disconnect-forfeit timer for this seat.
    socket.on("connect", join);

    const onUpdate = () => refresh();
    socket.on(HILLSTRIKE_MATCH_UPDATED, onUpdate);

    return () => {
      socket.off("connect", join);
      socket.off(HILLSTRIKE_MATCH_UPDATED, onUpdate);
      socket.emit("leave_room", { roomId });
    };
  }, [socket, matchId, refresh]);

  // ── Derived view model (all from the snapshot) ────────────────────────
  const viewerSeat: Seat | null = match?.viewerSeat ?? null;
  const opponentSeat: Seat | null = match?.opponentSeat ?? null;
  const state: HillstrikeState | null = match?.gameState ?? null;
  const status = String(match?.status ?? "");
  const finished = status === "finished";
  const cancelled = status === "cancelled";
  const waiting = status === "waiting";
  const matchOver = finished || cancelled;
  const isViewerTurn = Boolean(match?.isViewerTurn) && status === "playing";
  const canPlay = Boolean(state) && isViewerTurn && !matchOver && !submitting && !resolving;

  const players = match?.players ?? null;
  const viewerIdentity = viewerSeat ? players?.[viewerSeat] ?? null : null;
  const opponentIdentity = opponentSeat ? players?.[opponentSeat] ?? null : null;
  const opponentName =
    opponentIdentity?.name ||
    (opponentSeat ? seatLabel(opponentSeat, viewerSeat) : "Opponent");
  const opponentId = opponentSeat === "player1" ? match?.player1Id : match?.player2Id;

  const viewerHp = state && viewerSeat ? hpOf(state, viewerSeat) : 0;
  const opponentHp = state && opponentSeat ? hpOf(state, opponentSeat) : 0;

  const outcome = outcomeFor({
    result: match?.result,
    winnerId: match?.winnerId,
    viewerSeat,
    userId: user?.id,
  });
  // A level-HP clock expiry has no winner seat, which the shared result screen
  // calls a draw.
  const resultOutcome = outcome ?? "draw";

  // The clock: the server sends the deadline, the client only counts down to it.
  const deadline = Number(match?.deadlineAt) || null;
  const clockMs =
    status === "playing" && deadline ? Math.max(0, deadline - now) : 0;

  const shots = Array.isArray(match?.shots) ? match.shots : [];

  // The dotted preview is the ENGINE's own resolution of the pending aim — the
  // same `simulateShot` the server runs. It is an affordance only; the accepted
  // shot's outcome and animation always come back from the server.
  const preview = useMemo<HillstrikePreview | null>(() => {
    if (!state || !aim || !canPlay) return null;
    try {
      const simulation = simulateShot({
        battlefield: state.battlefield,
        shooterSeat: viewerSeat ?? "player1",
        shot: aim,
        projectile: state.projectile,
      });
      return { path: simulation.path, impact: simulation.impact };
    } catch {
      return null;
    }
  }, [aim, canPlay, state, viewerSeat]);

  const turnCopy = turnLabel({
    status,
    isViewerTurn,
    viewerSeat,
    opponentName,
    actionsRemaining: match?.actionsRemaining,
    openingShotPending: match?.openingShotPending,
  });

  // ── Actions ───────────────────────────────────────────────────────────
  const sendAction = useCallback(
    async (action: HillstrikeAction) => {
      const current = matchRef.current;
      if (!current || submitting) return;
      if (String(current.status) !== "playing" || !current.isViewerTurn) {
        setNotice("It is not your turn.");
        return;
      }

      setSubmitting(true);
      setNotice(null);
      try {
        const res = await fetch(`${apiMatch}/shot`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The whole request. No trajectory, no damage, no HP, no winner.
          body: JSON.stringify({ action, expectedVersion: current.version }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          // Rejected (stale tab, wrong turn, a refused action, a replay) —
          // explain it and resync rather than guessing.
          setNotice(data?.error || "That action was rejected.");
          setAim(null);
          refresh();
          return;
        }
        adopt(data.data.match);
        // A bare invalidation nudge: the opponent refetches, and nothing about
        // the match is carried in it.
        socket?.emit(HILLSTRIKE_READY, { matchId });
        refresh();
      } catch {
        setNotice("The action could not be sent — retrying.");
        refresh();
      } finally {
        setSubmitting(false);
      }
    },
    [adopt, apiMatch, matchId, refresh, socket, submitting],
  );

  const fire = useCallback(() => {
    if (!aim) return;
    void sendAction({ type: "shoot", ...aim });
  }, [aim, sendAction]);

  const drive = useCallback(
    (direction: MoveDirection) => {
      setAim(null);
      void sendAction({ type: "move", direction });
    },
    [sendAction],
  );

  /**
   * The clock ran out. Ask the server to resolve it; the engine names the winner
   * (more HP) or a draw (level HP), and the terminal snapshot it returns is what
   * this view renders. Both seats will call this; the server settles once.
   */
  const requestTimeout = useCallback(async () => {
    try {
      const res = await fetch(`${apiMatch}/timeout`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        // The server's clock is a moment behind ours: try again on the next tick.
        timeoutRequestedRef.current = false;
        refresh();
        return;
      }
      adopt(data.data.match);
      socket?.emit(HILLSTRIKE_READY, { matchId });
      refresh();
    } catch {
      timeoutRequestedRef.current = false;
    }
  }, [adopt, apiMatch, matchId, refresh, socket]);

  useEffect(() => {
    if (status !== "playing" || !deadline || clockMs > 0) return;
    if (timeoutRequestedRef.current) return;
    timeoutRequestedRef.current = true;
    void requestTimeout();
  }, [clockMs, deadline, requestTimeout, status]);

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
      if (data?.success) adopt(data.data.match);
      else refresh();
    } finally {
      setForfeiting(false);
    }
  }, [adopt, apiMatch, match, forfeiting, refresh]);

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

  // ── Render ────────────────────────────────────────────────────────────
  if (!match && !loadError) {
    return (
      <MatchLoading label="Loading your Hillstrike match…" currentPath={LOBBY_PATH} />
    );
  }

  if (!match && loadError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gradient-to-b from-[#0d1226] to-[#04060f] px-6 text-center text-white">
        <IconAlertTriangle className="h-8 w-8 text-amber-300" />
        <p className="text-sm text-white/80">{loadError}</p>
        <a
          href={LOBBY_PATH}
          className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-black"
        >
          Back to Hillstrike
        </a>
      </div>
    );
  }

  const seatCard = (seat: Seat) => {
    const identity = seat === viewerSeat ? viewerIdentity : opponentIdentity;
    const isViewer = seat === viewerSeat;
    const active = Boolean(state) && state?.turn === seat && !matchOver;
    const name = identity?.name || seatLabel(seat, viewerSeat);
    const hp = state ? hpOf(state, seat) : 0;
    const remaining = active ? Math.max(0, Number(match?.actionsRemaining) || 0) : 0;
    return (
      <div
        key={seat}
        data-testid={`hillstrike-seat-${isViewer ? "viewer" : "opponent"}`}
        data-active={active ? "true" : "false"}
        data-hp={hp}
        className={`rounded-xl border p-2.5 transition-colors ${
          active
            ? "border-[#f5ff3b]/60 bg-[#f5ff3b]/10 shadow-[0_0_16px_rgba(245,255,59,0.18)]"
            : "border-white/10 bg-black/30"
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xs font-bold uppercase tracking-wider text-white/80">
            {name}
            {isViewer ? <span className="ml-1 text-cyan-300">· you</span> : null}
          </p>
          <span className="font-mono text-xs font-bold text-white/85">
            {hpLabel(hp)}
          </span>
        </div>
        <div className="mt-1.5">{hpRail(hp)}</div>
        <p className="mt-1 flex items-center gap-1.5 text-[11px] text-white/55">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: seatColor(seat) }}
          />
          {active
            ? `${remaining} action${remaining === 1 ? "" : "s"} left this turn`
            : "waiting"}
        </p>
      </div>
    );
  };

  return (
    <>
      {waiting && (
        <MatchWaiting
          state="waiting"
          gameName="Hillstrike"
          icon={<IconTargetArrow className="h-8 w-8 text-cyan-300" />}
          subtitle="Waiting for an opponent to take the other hill…"
          seats={[
            {
              label: "You",
              name: viewerIdentity?.name || "You",
              occupied: true,
              wager: "Free",
            },
            { label: "Opponent", occupied: false },
          ]}
          onCancel={viewerSeat === "player1" ? cancelLobby : null}
          cancelLabel="Cancel match"
          cancelling={cancellingLobby}
        />
      )}

      <GameSessionHost autoStart={status === "playing"} autoStop={matchOver} gameLabel="hillstrike">
        <div
          data-testid="hillstrike-match"
          data-status={status}
          data-turn={state?.turn ?? ""}
          data-version={match?.version ?? 0}
          className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8"
        >
          <div className="mx-auto flex max-w-[1800px] flex-col px-1 pb-3 sm:px-2">
            {/* Header: the match, its clock, and both tanks. */}
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="logo-text flex items-center gap-1.5 text-lg font-black uppercase tracking-[0.08em] text-[#7cefff] drop-shadow-[0_0_16px_rgba(0,229,255,0.45)] sm:text-2xl">
                  <IconTargetArrow className="h-5 w-5 text-cyan-300" aria-hidden="true" />
                  Hillstrike
                </h1>
                <span
                  data-testid="match-status"
                  className="rounded-full border border-cyan-400/40 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cyan-200"
                >
                  {statusLabel(status)}
                </span>
                <span
                  data-testid="hillstrike-clock"
                  aria-label={"Match clock " + clockLabel(clockMs)}
                  className={
                    status === "playing" && clockMs <= 30000
                      ? "inline-flex items-center gap-1 rounded-full border border-red-400/60 bg-red-500/15 px-2 py-0.5 font-mono text-[11px] font-bold text-red-200"
                      : "inline-flex items-center gap-1 rounded-full border border-cyan-400/40 bg-cyan-500/10 px-2 py-0.5 font-mono text-[11px] font-bold text-cyan-100"
                  }
                >
                  <IconClock size={12} aria-hidden="true" />
                  {status === "playing" ? clockLabel(clockMs) : "--:--"}
                </span>
                <span className="hidden rounded-full border border-emerald-400/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-200 sm:inline">
                  Free &amp; rated
                </span>
              </div>

              <div className="flex min-w-0 flex-1 items-stretch gap-1.5 sm:max-w-md">
                {viewerSeat ? seatCard(viewerSeat) : null}
                {opponentSeat ? (
                  seatCard(opponentSeat)
                ) : (
                  <div
                    data-testid="hillstrike-seat-opponent-empty"
                    className="flex-1 rounded-xl border border-white/10 bg-black/30 px-2 py-1.5 text-[11px] font-semibold text-white/60"
                  >
                    Waiting for an opponent…
                  </div>
                )}
              </div>
            </div>

            {!waiting && !cancelled && state ? (
              <>
                {/* The game screen: the battlefield fills it, the controls are
                    mounted inside it at the bottom, so nothing needs a scroll. */}
                <div className="flex h-[calc(100dvh-180px)] min-h-[430px] flex-col overflow-hidden rounded-2xl border border-cyan-400/25 bg-[#04101f] shadow-[0_0_30px_rgba(34,211,238,0.10)]">
                  <div className="relative min-h-0 flex-1">
                    <HillstrikeBattlefield
                      state={state}
                      viewerSeat={viewerSeat ?? "player1"}
                      preview={preview}
                      aim={aim}
                      animation={animation}
                      interactive={canPlay}
                      resolving={resolving || submitting}
                      opponentLabel={opponentName}
                      onAim={(shot) => {
                        if (!canPlay) return;
                        setAim(shot);
                      }}
                      onLock={(shot) => {
                        if (!canPlay) return;
                        setAim(shot);
                      }}
                      onClear={() => setAim(null)}
                    />
                  </div>

                  <div className="shrink-0 border-t border-cyan-400/20 bg-[#020b16]/95 px-2 py-2 backdrop-blur sm:px-3">
                    <div className="flex items-center gap-2">
                      <p
                        role="status"
                        aria-live="polite"
                        data-testid="hillstrike-turn-status"
                        className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[#d8fbff] sm:text-xs"
                      >
                        {turnCopy}
                      </p>
                      <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/30 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cyan-300">
                        <IconTargetArrow size={12} aria-hidden="true" />
                        <span className="font-mono text-xs text-white" data-testid="hillstrike-aim-readout">
                          {aim ? Math.round(aim.angleDeg) + "° · " + aim.power + "%" : "—"}
                        </span>
                      </span>
                    </div>

                    <div className="mt-1.5 flex items-stretch gap-2">
                      <button
                        type="button"
                        data-testid="hillstrike-fire"
                        onClick={fire}
                        disabled={!aim || !canPlay}
                        className="inline-flex w-28 shrink-0 items-center justify-center gap-1.5 rounded-lg border-b-4 border-[#0087a8] bg-[#00e5ff] px-3 py-2 text-sm font-extrabold text-[#001a2e] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <IconBolt size={16} aria-hidden="true" />
                        {submitting ? "…" : "Fire"}
                      </button>

                      <div className="grid flex-1 grid-cols-3 gap-1.5">
                        <button
                          type="button"
                          data-testid="hillstrike-move-back"
                          onClick={() => drive("back")}
                          disabled={!canPlay}
                          title="Drive away from your opponent"
                          className="inline-flex items-center justify-center gap-1 rounded-lg border border-white/15 bg-white/5 px-1.5 py-1.5 text-[10px] font-bold text-white/80 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <IconArrowLeft size={12} aria-hidden="true" />
                          Drive back
                        </button>
                        <button
                          type="button"
                          data-testid="hillstrike-clear"
                          onClick={() => setAim(null)}
                          disabled={!aim}
                          className="rounded-lg border border-white/15 bg-white/5 px-1.5 py-1.5 text-[10px] font-semibold text-white/70 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Clear aim
                        </button>
                        <button
                          type="button"
                          data-testid="hillstrike-move-forward"
                          onClick={() => drive("forward")}
                          disabled={!canPlay}
                          title="Drive toward your opponent — a shorter shot hits harder"
                          className="inline-flex items-center justify-center gap-1 rounded-lg border border-white/15 bg-white/5 px-1.5 py-1.5 text-[10px] font-bold text-white/80 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Drive up
                          <IconArrowRight size={12} aria-hidden="true" />
                        </button>
                      </div>
                    </div>

                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      <p
                        role="status"
                        aria-live="polite"
                        data-testid="hillstrike-notice"
                        className={
                          notice
                            ? "min-w-0 flex-1 truncate text-[10px] text-amber-300"
                            : "min-w-0 flex-1 truncate text-[10px] text-transparent"
                        }
                      >
                        {notice ?? "."}
                      </p>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-[10px] font-bold text-white/80 transition hover:bg-white/10 disabled:opacity-40"
                          data-testid="hillstrike-resign"
                          disabled={forfeiting || matchOver || waiting}
                          onClick={() => setShowForfeitConfirm(true)}
                        >
                          <IconFlag size={12} aria-hidden="true" /> Resign
                        </button>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-[10px] font-bold text-white/80 transition hover:bg-white/10"
                          data-testid="hillstrike-report"
                          onClick={() => setShowReportModal(true)}
                        >
                          <IconAlertTriangle size={12} aria-hidden="true" /> Report
                        </button>
                        {waiting ? (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-[10px] font-bold text-white/80 transition hover:bg-white/10"
                            data-testid="hillstrike-cancel"
                            disabled={cancellingLobby}
                            onClick={cancelLobby}
                          >
                            <IconDoorExit size={12} aria-hidden="true" /> Cancel
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>

                <details
                  className="mt-2 rounded-xl border border-white/10 bg-black/25 p-2"
                  data-testid="hillstrike-shot-log"
                >
                  <summary className="cursor-pointer text-[11px] font-bold uppercase tracking-wider text-white/55">
                    Actions played ({shots.length})
                  </summary>
                  {shots.length === 0 ? (
                    <p className="mt-1 text-xs text-white/45">No shots yet.</p>
                  ) : (
                    <ol className="mt-1 flex flex-col gap-1 text-[11px] text-white/70">
                      {shots
                        .slice(-8)
                        .reverse()
                        .map((row: any) => (
                          <li
                            key={row.actionIndex + "-" + (row.createdAt ?? "")}
                            className="flex items-start justify-between gap-2"
                          >
                            <span className="text-white/40">
                              #{Number(row.actionIndex) + 1}
                            </span>
                            <span className="flex-1 text-right">
                              <span
                                className="mr-1 font-semibold"
                                style={{
                                  color: seatColor(
                                    row.seat === "player2" ? "player2" : "player1",
                                  ),
                                }}
                              >
                                {row.seat === viewerSeat ? "You" : seatName(row.seat)}
                              </span>
                              {loggedShotLabel(row)}
                            </span>
                          </li>
                        ))}
                    </ol>
                  )}
                </details>
              </>
            ) : null}
          </div>

          <AnimatePresence>
            {showForfeitConfirm && (
              <motion.div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowForfeitConfirm(false)}
              >
                <motion.div
                  className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0b1226] p-5 text-white"
                  initial={{ scale: 0.94, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.96, opacity: 0 }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <h2 className="text-lg font-bold">Resign this duel?</h2>
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
                      {forfeiting ? "Resigning…" : "Resign"}
                    </button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          <PvpResultScreen
            open={finished}
            outcome={resultOutcome}
            headline={
              resultOutcome === "win"
                ? "The hill is yours"
                : resultOutcome === "draw"
                  ? "Time — the hill stays unclaimed"
                  : "Your opponent took the hill"
            }
            subline={resultReasonLabel(match?.resultReason, resultOutcome)}
            gameName="Hillstrike"
            durationSeconds={durationSeconds(match?.startedAt, match?.endedAt)}
            opponent={{
              name: opponentName,
              iconKey: opponentIdentity?.iconKey ?? null,
              profileFrame: opponentIdentity?.profileFrame ?? null,
            }}
            summary={[
              {
                label: "Result",
                value:
                  resultOutcome === "win"
                    ? "Win"
                    : resultOutcome === "draw"
                      ? "Draw"
                      : "Loss",
              },
              { label: "Actions taken", value: String(Number(match?.version) || 0) },
              { label: "Your HP", value: String(viewerHp) },
              { label: "Opponent's HP", value: String(opponentHp) },
              { label: "Clock", value: clockLabel(Number(match?.durationMs) || 0) },
            ]}
            details={[
              { label: "Match ID", value: String(matchId) },
              { label: "You played", value: seatName(viewerSeat) },
              { label: "Layout seed", value: String(match?.seed ?? "—") },
              {
                label: "Reason",
                value: resultReasonLabel(match?.resultReason, resultOutcome),
              },
              ...shots.map((row: any) => ({
                label: `Shot ${Number(row.actionIndex) + 1}`,
                value: `${row.seat === "player1" ? "Cyan" : "Magenta"} — ${loggedShotLabel(row)}`,
              })),
            ]}
            onReturnToLobby={() => {
              window.location.href = LOBBY_PATH;
            }}
          />

          <ReportModal
            isOpen={showReportModal}
            onClose={() => setShowReportModal(false)}
            reportedPlayerName={opponentName}
            gameType="hillstrike"
            onSubmit={async (reason: string, details: string) => {
              try {
                await fetch("/api/reports/submit", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    reportedClerkId: opponentId,
                    reason,
                    details,
                    gameType: "hillstrike",
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
