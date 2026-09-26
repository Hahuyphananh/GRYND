"use client";

// src/app/casino/mini-golf/[matchId]/PageClient.tsx
//
// The Mini Golf match view.
//
// Server-authoritative by construction: the ONLY thing this page sends is
// `{ angle, power }` (plus the optimistic-concurrency `expectedVersion`). The
// ball never moves because of a local simulation — the trajectory it plays is
// the `path` the server returned, and the score, hole winners and match result
// always come from the snapshot.
//
// Flow:
//   poll /api/mini-golf/match/<id>  (adaptive interval, aborted on socket push)
//   socket `lobby:updated` on `mini-golf:match:<id>` → immediate refetch
//   aim by dragging the course, set power with the meter or the slider
//   Shoot → POST /shoot → animate the authoritative trajectory → both seats
//   resync from the snapshot; a completed hole shows a result interstitial
//   before the next hole; a finished match hands over to PvpResultScreen.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import {
  IconAlertTriangle,
  IconDoorExit,
  IconFlag,
  IconGolf,
  IconTargetArrow,
} from "@tabler/icons-react";

import { useSocket } from "../../../../context/SocketProvider";
import EmotePicker, { EmoteBubble } from "../../../../components/game/EmotePicker";
import useGameEmotes from "../../../../hooks/useGameEmotes";
import MiniGolfCourse from "../../../../components/mini-golf/MiniGolfCourse";
import MatchWaiting from "../../../../components/lobby/MatchWaiting";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import ReportModal from "../../../../components/ReportModal";
import GameSessionHost from "../../../../components/GameSessionHost";
import {
  MINI_GOLF_MATCH_UPDATED,
  miniGolfMatchRoom,
} from "../../../../lib/mini-golf/rooms";
import {
  animationDurationMs,
  clampPower,
  difficultyLabel,
  holeResultLabel,
  matchFormatLabel,
  samplePath,
  seatColor,
  seatLabel,
  totalStrokes,
  winPips,
  type HoleWinner,
} from "../../../../lib/mini-golf/ui";
import { HOLES_TO_WIN, HOLE_COUNT } from "../../../../lib/mini-golf/constants";
import type { Vec2 } from "../../../../lib/mini-golf/types";

type Seat = "player1" | "player2";
type BallView = { x: number; y: number; holedOut?: boolean };

const ACTIVE_POLL_MS = 1800;
const IDLE_POLL_MS = 5000;
const HOLE_RESULT_MS = 2600;

const cloneBalls = (balls: any): Record<Seat, BallView> | null => {
  if (!balls) return null;
  return {
    player1: { ...(balls.player1 ?? { x: 0, y: 0 }) },
    player2: { ...(balls.player2 ?? { x: 0, y: 0 }) },
  };
};

export default function MiniGolfMatchPage() {
  const params = useParams<{ matchId: string }>();
  const router = useRouter();
  const { socket } = useSocket();
  const { user } = useUser();
  const matchId = params?.matchId;
  const apiMatch = `/api/mini-golf/match/${matchId}`;

  const [match, setMatch] = useState<any>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── Presentation state ────────────────────────────────────────────────
  const [visibleHole, setVisibleHole] = useState(1);
  const [renderBalls, setRenderBalls] = useState<Record<Seat, BallView> | null>(null);
  const [anim, setAnim] = useState<{
    seq: number;
    seat: Seat;
    hole: number;
    path: Vec2[];
    pocketed: boolean;
    duration: number;
    startedAt: number;
  } | null>(null);
  const [progress, setProgress] = useState(1);
  const [holeOverlay, setHoleOverlay] = useState<{
    hole: number;
    player1: number;
    player2: number;
    winner: HoleWinner | null;
  } | null>(null);

  // ── Interaction state ─────────────────────────────────────────────────
  const [aim, setAim] = useState({ angle: 270, power: 50 });
  const [shooting, setShooting] = useState(false);
  const [showForfeitConfirm, setShowForfeitConfirm] = useState(false);
  const [forfeiting, setForfeiting] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const matchRef = useRef<any>(null);
  const hydratedRef = useRef(false);
  const lastAnimatedSeqRef = useRef(-1);
  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the latest snapshot in a ref for callbacks that outlive a render
  // (the animation-completion timer in particular). Declared BEFORE the
  // animation effects so it lands first in the effect order.
  useEffect(() => {
    matchRef.current = match;
  }, [match]);

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
        setMatch(data.data);
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
        matchRef.current?.status === "finished" || matchRef.current?.status === "cancelled";
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
    const roomId = miniGolfMatchRoom(matchId);
    const onUpdate = () => refresh();
    socket.emit("join_room", { roomId });
    socket.on(MINI_GOLF_MATCH_UPDATED, onUpdate);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off(MINI_GOLF_MATCH_UPDATED, onUpdate);
    };
  }, [socket, matchId, refresh]);

  // ── Authoritative trajectory playback ─────────────────────────────────
  // Any snapshot carrying an as-yet-unplayed `lastShot` starts an animation.
  // A shot that belongs to an earlier hole is played on THAT hole first, so
  // the opponent sees exactly what the shooter saw before the board advances.
  useEffect(() => {
    if (!match) return;
    const seq = Number(match.shotSeq) || 0;
    const last = match.lastShot;

    if (!hydratedRef.current) {
      hydratedRef.current = true;
      lastAnimatedSeqRef.current = seq;
      setVisibleHole(Number(match.currentHole) || 1);
      setRenderBalls(cloneBalls(match.balls));
      return;
    }
    if (!last || !Array.isArray(last.result?.path) || last.result.path.length === 0) return;
    if (lastAnimatedSeqRef.current === seq) return;

    lastAnimatedSeqRef.current = seq;
    const hole = Number(last.hole) || Number(match.currentHole) || 1;
    const path: Vec2[] = last.result.path;
    if (hole !== match.currentHole) setVisibleHole(hole);
    setHoleOverlay(null);
    setProgress(0);
    setAnim({
      seq,
      seat: last.seat,
      hole,
      path,
      pocketed: Boolean(last.result?.pocketed),
      duration: animationDurationMs(path),
      startedAt:
        typeof performance !== "undefined" ? performance.now() : Date.now(),
    });
  }, [match]);

  const finishAnimation = useCallback((finished: NonNullable<typeof anim>) => {
    setAnim(null);
    setProgress(1);
    const latest = matchRef.current;
    const path = finished.path;
    const end = path.length ? path[path.length - 1] : { x: 0, y: 0 };
    const advancedToNextHole = Boolean(latest) && finished.hole !== latest.currentHole;

    if (advancedToNextHole) {
      // Hold the completed hole on screen with its final ball positions, show
      // the result interstitial, then advance.
      setRenderBalls((prev) =>
        prev ? { ...prev, [finished.seat]: { x: end.x, y: end.y, holedOut: finished.pocketed } } : prev,
      );
      const score = latest.holeScores?.[finished.hole - 1] ?? { player1: 0, player2: 0 };
      setHoleOverlay({
        hole: finished.hole,
        player1: Number(score.player1) || 0,
        player2: Number(score.player2) || 0,
        winner: latest.holeWinners?.[finished.hole - 1] ?? null,
      });
      if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
      overlayTimerRef.current = setTimeout(() => {
        overlayTimerRef.current = null;
        const current = matchRef.current;
        setHoleOverlay(null);
        setVisibleHole(Number(current?.currentHole) || finished.hole + 1);
        setRenderBalls(cloneBalls(current?.balls));
      }, HOLE_RESULT_MS);
      return;
    }

    // Same hole: adopt the authoritative rest positions (and holed-out flags).
    setRenderBalls(cloneBalls(latest?.balls) ?? null);
  }, []);

  useEffect(() => {
    if (!anim) return undefined;
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - anim.startedAt) / Math.max(1, anim.duration));
      setProgress(t);
      if (t < 1) raf = requestAnimationFrame(step);
      else finishAnimation(anim);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [anim, finishAnimation]);

  useEffect(
    () => () => {
      if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
    },
    [],
  );

  // ── Actions ───────────────────────────────────────────────────────────
  const viewerSeat: Seat | null = match?.viewerSeat ?? null;
  const isMyTurn = Boolean(match?.isViewerTurn);
  const canShoot =
    Boolean(match) &&
    match.status === "playing" &&
    Boolean(match.viewerCanShoot) &&
    !anim &&
    !shooting &&
    !holeOverlay &&
    !showForfeitConfirm;

  const shoot = useCallback(async () => {
    if (!match || !canShoot) return;
    setShooting(true);
    setLoadError(null);
    try {
      const res = await fetch(`${apiMatch}/shoot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          angle: aim.angle,
          power: aim.power,
          expectedVersion: match.version,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        // Rejected (stale tab, wrong turn, invalid input) — resync rather than
        // guessing, so the UI can never drift from the server.
        setLoadError(data?.error || "Shot rejected");
        refresh();
        return;
      }
      setMatch(data.data.match);
      socket?.emit("mini-golf:ready", { matchId });
    } catch {
      setLoadError("Shot failed — retrying");
      refresh();
    } finally {
      setShooting(false);
    }
  }, [match, canShoot, aim, apiMatch, refresh, socket, matchId]);

  const forfeit = useCallback(async () => {
    if (!match || forfeiting) return;
    setShowForfeitConfirm(false);
    setForfeiting(true);
    try {
      const res = await fetch(`${apiMatch}/forfeit`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (data?.success) {
        setMatch(data.data.match);
        socket?.emit("mini-golf:ready", { matchId });
      } else {
        refresh();
      }
    } finally {
      setForfeiting(false);
    }
  }, [match, forfeiting, apiMatch, refresh, socket, matchId]);

  const cancelLobby = useCallback(async () => {
    setShowForfeitConfirm(false);
    setForfeiting(true);
    try {
      await fetch(`${apiMatch}/cancel`, { method: "POST" });
      refresh();
    } finally {
      setForfeiting(false);
    }
  }, [apiMatch, refresh]);

  // ── Derived view model ────────────────────────────────────────────────
  const hole = useMemo(() => {
    const holes = match?.holes;
    if (!Array.isArray(holes) || holes.length === 0) return null;
    const index = Math.min(Math.max(visibleHole, 1), holes.length) - 1;
    return holes[index];
  }, [match?.holes, visibleHole]);

  const aimFrom = useMemo<Vec2 | null>(() => {
    if (!viewerSeat) return null;
    const ball = renderBalls?.[viewerSeat] ?? match?.balls?.[viewerSeat];
    if (!ball) return null;
    return { x: ball.x, y: ball.y };
  }, [viewerSeat, renderBalls, match?.balls]);

  const movingBall = useMemo<Vec2 | null>(() => {
    if (!anim) return null;
    return samplePath(anim.path, progress);
  }, [anim, progress]);

  const seats = useMemo(() => {
    const players = match?.players ?? {};
    const viewer = viewerSeat;
    const opponentSeat: Seat | null = viewer ? (viewer === "player1" ? "player2" : "player1") : null;
    const identityFor = (seat: Seat | null) => (seat ? players?.[seat] ?? null : null);
    return {
      viewer: identityFor(viewer),
      opponent: identityFor(opponentSeat),
      opponentSeat,
    };
  }, [match?.players, viewerSeat]);

  const scores = match?.holeScores ?? [];
  const currentHoleIndex = Math.max(1, Number(match?.currentHole) || 1) - 1;
  const strokes = scores[currentHoleIndex] ?? { player1: 0, player2: 0 };
  const shownStrokes = holeOverlay
    ? { player1: holeOverlay.player1, player2: holeOverlay.player2 }
    : strokes;
  const totals = useMemo(() => totalStrokes(scores), [scores]);

  const opponentSeat = seats.opponentSeat;
  const opponentName = seats.opponent?.name || seatLabel(opponentSeat ?? "player2", viewerSeat);
  const opponentId = opponentSeat === "player1" ? match?.player1Id : match?.player2Id;

  const finished = match?.status === "finished";
  const cancelled = match?.status === "cancelled";
  const outcome =
    match?.result === "tie"
      ? "draw"
      : match?.winnerId && user?.id
        ? match.winnerId === user.id
          ? "win"
          : "loss"
        : Number(match?.player1HoleWins) === Number(match?.player2HoleWins)
          ? "draw"
          : (viewerSeat === "player1" ? Number(match?.player1HoleWins) > Number(match?.player2HoleWins)
              : Number(match?.player2HoleWins) > Number(match?.player1HoleWins))
            ? "win"
            : "loss";

  const { incomingEmote, myEmote, sendEmote } = useGameEmotes({
    socket,
    roomId: matchId ? miniGolfMatchRoom(matchId) : null,
    eventName: "mini-golf:emote",
    selfId: viewerSeat,
  });

  const myTurnLabel = !match
    ? "Loading…"
    : finished || cancelled
      ? "Match over"
      : match.viewerHasHoledOut
        ? "You're in — waiting for your opponent to finish"
        : isMyTurn
          ? "Your turn"
          : "Waiting for your opponent…";

  // ── Render ────────────────────────────────────────────────────────────
  if (!match && !loadError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-[#04170e] to-[#03150c] text-white/70">
        Loading Mini Golf…
      </div>
    );
  }

  if (!match && loadError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gradient-to-b from-[#04170e] to-[#03150c] px-6 text-center text-white">
        <IconAlertTriangle className="h-8 w-8 text-amber-300" />
        <p className="text-sm text-white/80">{loadError}</p>
        <button
          onClick={() => router.push("/casino/mini-golf")}
          className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-bold text-black"
        >
          Back to Mini Golf
        </button>
      </div>
    );
  }

  return (
    <>
      {(match.status === "waiting" || match.status === "ready") && (
        <MatchWaiting
          state={match.status === "ready" ? "ready" : "waiting"}
          gameName="Mini Golf"
          icon={<IconGolf className="h-8 w-8 text-emerald-400" />}
          subtitle={
            match.status === "ready"
              ? "Opponent found — teeing off…"
              : "Waiting for an opponent to join your Mini Golf match…"
          }
          seats={[
            {
              label: "You",
              name:
                (viewerSeat === "player1" ? match.players?.player1?.name : match.players?.player2?.name) ||
                "You",
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
          onCancel={match.status === "waiting" && viewerSeat === "player1" ? cancelLobby : null}
          cancelLabel="Cancel match"
          cancelling={forfeiting}
        />
      )}

      <GameSessionHost
        autoStart={match.status === "playing"}
        autoStop={finished || cancelled}
        gameLabel="mini-golf"
      >
        <div
          data-testid="mini-golf-match"
          className="min-h-screen overflow-x-clip bg-gradient-to-b from-[#04170e] via-[#03150c] to-[#020f08] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8"
        >
          <div className="mx-auto max-w-6xl">
            {/* Header */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-emerald-300 via-emerald-400 to-lime-300 sm:text-3xl">
                  <IconGolf className="h-7 w-7 text-emerald-400" />
                  Mini Golf
                </h1>
                <p className="mt-1 text-xs font-semibold uppercase tracking-widest text-emerald-200/70">
                  {matchFormatLabel(HOLE_COUNT, HOLES_TO_WIN)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  data-testid="hole-indicator"
                  className="rounded-full border border-emerald-400/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-emerald-200"
                >
                  Hole {Math.min(Number(match.currentHole) || 1, HOLE_COUNT)} of {HOLE_COUNT} ·{" "}
                  {difficultyLabel(hole)}
                </span>
                <button
                  onClick={() => router.push("/casino/mini-golf")}
                  className="rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-white/20"
                >
                  Lobby
                </button>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
              {/* ── Board column ─────────────────────────────────────── */}
              <div className="rounded-2xl border border-emerald-500/20 bg-black/40 p-3 shadow-[0_0_30px_rgba(16,185,129,0.12)] sm:p-4">
                {/* Scoreboard */}
                <div className="mb-3 grid grid-cols-2 gap-2">
                  {(["player1", "player2"] as Seat[]).map((seat) => {
                    const identity =
                      seat === "player1" ? match.players?.player1 : match.players?.player2;
                    const isViewer = seat === viewerSeat;
                    const isActive = match.currentTurn === seat && !finished && !cancelled;
                    const wins = seat === "player1" ? match.player1HoleWins : match.player2HoleWins;
                    const name =
                      identity?.name || seatLabel(seat, viewerSeat);
                    return (
                      <div
                        key={seat}
                        data-testid={`seat-${seat}`}
                        data-active={isActive ? "true" : "false"}
                        className={`rounded-xl border p-2.5 transition ${
                          isActive
                            ? "border-emerald-400/60 bg-emerald-500/10"
                            : "border-white/10 bg-white/5"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border text-xs font-black"
                            style={{
                              borderColor: seatColor(seat),
                              color: seatColor(seat),
                              background: "rgba(0,0,0,0.35)",
                            }}
                          >
                            {name.charAt(0).toUpperCase()}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-xs font-bold">
                              {name}
                              {isViewer && <span className="ml-1 text-emerald-300">· you</span>}
                            </p>
                            <p className="text-[10px] uppercase tracking-wider text-white/45">
                              {wins} {wins === 1 ? "hole" : "holes"} won
                            </p>
                          </div>
                          <EmoteBubble
                            emote={isViewer ? myEmote : incomingEmote}
                            side={isViewer ? "mine" : "incoming"}
                          />
                        </div>
                        <div className="mt-2 flex items-center gap-1.5" aria-label={`${wins} holes won`}>
                          {winPips(wins, HOLES_TO_WIN).map((won, i) => (
                            <span
                              key={i}
                              className="h-2 w-5 rounded-full"
                              style={{ background: won ? seatColor(seat) : "rgba(255,255,255,0.15)" }}
                            />
                          ))}
                          <span className="ml-1 text-sm font-black tabular-nums" style={{ color: seatColor(seat) }}>
                            {Number(shownStrokes?.[seat]) || 0}
                          </span>
                          <span className="text-[10px] uppercase tracking-wider text-white/40">
                            shots this hole
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Course */}
                <div
                  data-testid="mini-golf-board"
                  className="relative h-[clamp(300px,58vh,620px)] w-full overflow-hidden rounded-xl border border-emerald-500/25 bg-[#052314]"
                >
                  <MiniGolfCourse
                    hole={hole}
                    balls={renderBalls}
                    movingSeat={anim?.seat ?? null}
                    movingBall={movingBall}
                    aim={aim}
                    aimFrom={aimFrom}
                    interactive={canShoot}
                    onAim={(next) => setAim({ angle: Math.round(next.angle), power: clampPower(next.power) })}
                    viewerSeat={viewerSeat}
                  />
                  <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-emerald-200">
                    Hole {visibleHole}
                  </span>
                </div>

                {/* Controls */}
                <div className="mt-3 rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span
                      data-testid="turn-status"
                      className={`inline-flex items-center gap-1.5 text-sm font-semibold ${
                        isMyTurn && !finished ? "text-emerald-300" : "text-white/60"
                      }`}
                    >
                      <span
                        className={`inline-block h-2.5 w-2.5 rounded-full ${
                          isMyTurn && !finished ? "animate-pulse bg-emerald-400" : "bg-white/30"
                        }`}
                      />
                      {myTurnLabel}
                    </span>
                    <span className="flex items-center gap-3 text-xs text-white/60">
                      <span className="inline-flex items-center gap-1">
                        <IconTargetArrow size={13} /> Angle{" "}
                        <span className="font-mono text-white">{Math.round(aim.angle)}°</span>
                      </span>
                      <span>
                        Power <span className="font-mono text-white">{clampPower(aim.power)}%</span>
                      </span>
                    </span>
                  </div>

                  <div className="mt-3 flex items-center gap-3">
                    <label className="w-full">
                      <span className="sr-only">Shot power</span>
                      <input
                        data-testid="power-slider"
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={clampPower(aim.power)}
                        disabled={!canShoot}
                        onChange={(e) =>
                          setAim((prev) => ({ ...prev, power: clampPower(Number(e.target.value)) }))
                        }
                        className="w-full accent-emerald-400 disabled:opacity-40"
                      />
                    </label>
                    <div className="h-2.5 w-24 overflow-hidden rounded-full bg-white/10">
                      <div
                        data-testid="power-meter"
                        className="h-full transition-all"
                        style={{
                          width: `${clampPower(aim.power)}%`,
                          background: seatColor(viewerSeat),
                          transform: "translateZ(0)",
                        }}
                      />
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      data-testid="shoot-button"
                      onClick={shoot}
                      disabled={!canShoot}
                      className={`flex-1 rounded-xl border-b-4 py-3 text-base font-extrabold transition ${
                        canShoot
                          ? "border-emerald-800 bg-emerald-500 text-black hover:brightness-110 active:translate-y-[2px]"
                          : "cursor-not-allowed border-white/10 bg-white/10 text-white/40"
                      }`}
                    >
                      {shooting
                        ? "Shooting…"
                        : anim
                          ? "Ball rolling…"
                          : match.viewerHasHoledOut
                            ? "Hole complete"
                            : canShoot
                              ? "Shoot"
                              : isMyTurn
                                ? "Locked"
                                : "Waiting…"}
                    </button>
                    {match.status === "playing" && (
                      <button
                        onClick={() => setShowForfeitConfirm(true)}
                        className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm font-bold text-red-300 transition hover:bg-red-500/20"
                      >
                        <span className="inline-flex items-center gap-1">
                          <IconDoorExit size={14} /> Forfeit
                        </span>
                      </button>
                    )}
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-white/45">
                    Drag on the course to aim — the further you drag, the harder the shot. The
                    preview is only a guide; the server decides where the ball ends up.
                  </p>
                  {loadError && (
                    <p className="mt-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                      {loadError}
                    </p>
                  )}
                </div>
              </div>

              {/* ── Sidebar ─────────────────────────────────────────── */}
              <aside className="space-y-3">
                <section className="rounded-2xl border border-emerald-500/20 bg-black/40 p-4">
                  <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-emerald-300">
                    Match
                  </h2>
                  <div className="space-y-1.5 text-xs">
                    <Row label="Format" value={matchFormatLabel(HOLE_COUNT, HOLES_TO_WIN)} />
                    <Row label="Holes won" value={`${match.player1HoleWins} — ${match.player2HoleWins}`} />
                    <Row label="Total strokes" value={`${totals.player1} — ${totals.player2}`} />
                    <Row label="Opponent" value={opponentName} />
                  </div>
                </section>

                <section className="rounded-2xl border border-emerald-500/20 bg-black/40 p-4">
                  <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-emerald-300">
                    Scorecard
                  </h2>
                  <div className="space-y-1.5">
                    {(match.holes ?? []).map((h: any, index: number) => {
                      const score = scores[index] ?? { player1: 0, player2: 0 };
                      const winner = match.holeWinners?.[index] ?? null;
                      const isCurrent = index === currentHoleIndex && !finished;
                      return (
                        <div
                          key={h?.index ?? index}
                          className={`flex items-center justify-between rounded-lg border px-2 py-1.5 text-xs ${
                            isCurrent
                              ? "border-emerald-400/50 bg-emerald-500/10"
                              : "border-white/10 bg-white/5"
                          }`}
                        >
                          <span className="font-semibold text-white/70">
                            Hole {index + 1}
                            <span className="ml-1 text-[10px] uppercase tracking-wider text-white/35">
                              par {h?.par}
                            </span>
                          </span>
                          <span className="flex items-center gap-2 font-mono">
                            <span style={{ color: seatColor("player1") }}>{score.player1}</span>
                            <span className="text-white/30">·</span>
                            <span style={{ color: seatColor("player2") }}>{score.player2}</span>
                            <span
                              className={`w-14 text-right text-[10px] uppercase tracking-wider ${
                                winner === "tie"
                                  ? "text-white/45"
                                  : winner
                                    ? "text-emerald-300"
                                    : "text-white/25"
                              }`}
                            >
                              {winner === "tie" ? "halved" : winner ? seatLabel(winner, viewerSeat) : "—"}
                            </span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="rounded-2xl border border-emerald-500/20 bg-black/40 p-4">
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

          {/* ── Hole result interstitial ───────────────────────────── */}
          <AnimatePresence>
            {holeOverlay && (
              <motion.div
                key={`hole-result-${holeOverlay.hole}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                data-testid="hole-result"
                className="fixed inset-0 z-[85] flex items-center justify-center bg-black/65 px-4 backdrop-blur-sm"
                role="status"
                aria-live="polite"
              >
                <motion.div
                  initial={{ scale: 0.9, y: 18, opacity: 0 }}
                  animate={{ scale: 1, y: 0, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 280, damping: 22 }}
                  className="w-full max-w-sm rounded-2xl border-2 border-emerald-400/50 bg-gradient-to-b from-[#06291a] to-[#04170e] p-5 text-center shadow-[0_0_50px_rgba(16,185,129,0.35)]"
                >
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-emerald-300/80">
                    Hole {holeOverlay.hole} complete
                  </p>
                  <p className="mt-1 text-xl font-black text-white">
                    {holeResultLabel(holeOverlay.winner ?? "tie", viewerSeat)}
                  </p>
                  <div className="mt-4 flex items-center justify-center gap-5">
                    <StrokeColumn seat="player1" strokes={holeOverlay.player1} viewerSeat={viewerSeat} />
                    <span className="text-lg font-black text-white/30">vs</span>
                    <StrokeColumn seat="player2" strokes={holeOverlay.player2} viewerSeat={viewerSeat} />
                  </div>
                  <p className="mt-4 text-xs text-white/55">
                    Match score {match.player1HoleWins} — {match.player2HoleWins}
                  </p>
                  <p className="mt-1 text-[11px] uppercase tracking-widest text-emerald-200/60">
                    Next hole in a moment…
                  </p>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

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
                  className="w-full max-w-sm rounded-2xl border border-red-500/40 bg-[#0b1f16] p-6 text-center"
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
          {finished && (
            <PvpResultScreen
              open
              outcome={outcome}
              headline={`${match.player1HoleWins} — ${match.player2HoleWins} on holes`}
              subline={`Total strokes ${totals.player1} — ${totals.player2} across ${match.holes?.length ?? 0} holes.`}
              gameName="Mini Golf"
              gameKey="mini-golf"
              opponent={{
                name: opponentName,
                iconKey: seats.opponent?.iconKey ?? null,
                profileFrame: seats.opponent?.profileFrame ?? null,
              }}
              summary={[
                { label: "Result", value: outcome === "win" ? "Win" : outcome === "loss" ? "Loss" : "Draw" },
                { label: "Holes won", value: `${match.player1HoleWins} — ${match.player2HoleWins}` },
                { label: "Total strokes", value: `${totals.player1} — ${totals.player2}` },
              ]}
              details={[
                { label: "Match ID", value: String(matchId) },
                { label: "Course seed", value: String(match.seed ?? "—") },
                ...(scores ?? []).map((score: any, index: number) => ({
                  label: `Hole ${index + 1}`,
                  value: `${score.player1} — ${score.player2}`,
                })),
              ]}
              playAgain={{ label: "Play again", onClick: () => router.push("/casino/mini-golf") }}
              onReturnToLobby={() => router.push("/casino")}
            />
          )}

          {/* ── Report ─────────────────────────────────────────────── */}
          <ReportModal
            isOpen={showReportModal}
            onClose={() => setShowReportModal(false)}
            reportedPlayerName={opponentName}
            gameType="mini-golf"
            onSubmit={async (reason: string, details: string) => {
              try {
                await fetch("/api/reports/submit", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    reportedClerkId: opponentId,
                    reason,
                    details,
                    gameType: "mini-golf",
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

function StrokeColumn({
  seat,
  strokes,
  viewerSeat,
}: {
  seat: Seat;
  strokes: number;
  viewerSeat: Seat | null;
}) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-[10px] uppercase tracking-wider text-white/45">
        {seatLabel(seat, viewerSeat)}
      </span>
      <span className="text-4xl font-black tabular-nums" style={{ color: seatColor(seat) }}>
        {strokes}
      </span>
      <span className="text-[10px] uppercase tracking-widest text-white/35">strokes</span>
    </div>
  );
}
