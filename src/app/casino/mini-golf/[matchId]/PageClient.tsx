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
//   aim with the pointer, click to lock the angle, drag to charge power and
//   release to launch (the Pool Masters interaction — no shoot button, no
//   slider) → POST /shoot → animate the authoritative trajectory → both seats
//   resync from the snapshot; a completed hole shows a result interstitial
//   before the next hole; a finished match hands over to PvpResultScreen.
//
// The hole on screen is DERIVED from the snapshot (+ whatever is animating) —
// never a separate `visibleHole` copy — so the board can neither lag the match
// nor snap back to a hole it has already left.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import {
  IconAlertTriangle,
  IconChevronDown,
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
import NavigationBar from "../../../../components/navigation-bar";
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
  isIncomingSnapshotStale,
  lastBotTurnRecap,
  matchFormatLabel,
  rollingProgress,
  samplePath,
  seatColor,
  seatLabel,
  totalStrokes,
  winPips,
  type BotShotRecap,
  type HoleWinner,
} from "../../../../lib/mini-golf/ui";
import { HOLES_TO_WIN, HOLE_COUNT } from "../../../../lib/mini-golf/constants";
import {
  AI_DIFFICULTY_LABELS,
  coerceAiDifficulty,
} from "../../../../lib/aiDifficulty";
import type { Vec2 } from "../../../../lib/mini-golf/types";

type Seat = "player1" | "player2";
type BallView = { x: number; y: number; holedOut?: boolean };

/** One authoritative trajectory being played back on the board. */
type Rollout = {
  seq: number;
  seat: Seat;
  hole: number;
  path: Vec2[];
  pocketed: boolean;
  /** Simulated frame count, used to pace the deceleration. */
  frames: number;
  duration: number;
  startedAt: number;
};

const ACTIVE_POLL_MS = 1800;
const IDLE_POLL_MS = 5000;
const HOLE_RESULT_MS = 2600;
/**
 * How long the "X's turn" announcement stays up.
 *
 * Long enough to read at a glance, short enough to be gone before the player
 * starts aiming. It fires on EVERY hand-off — including the ones the server
 * resolves inside a single poll, where it is the only sign the opponent took a
 * turn at all.
 */
const TURN_CALL_MS = 1500;

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
  // A recap of the practice bot's most recent turn. Under the whole-turn model
  // the server resolves the bot's whole run inside ONE poll, so the client only
  // receives (and only animates) the last shot; this is what tells the human
  // what actually happened.
  const [botRecap, setBotRecap] = useState<BotShotRecap | null>(null);

  // ── Presentation state ────────────────────────────────────────────────
  // NOTE: there is deliberately NO `visibleHole` state. The hole on screen is
  // DERIVED (see `viewHoleNumber` below) from the authoritative snapshot plus
  // whatever is animating, so the board can never lag the server or snap back
  // to a hole the match has already left.
  const [renderBalls, setRenderBalls] = useState<Record<Seat, BallView> | null>(null);
  const [anim, setAnim] = useState<Rollout | null>(null);
  const [progress, setProgress] = useState(1);
  const [holeOverlay, setHoleOverlay] = useState<{
    hole: number;
    player1: number;
    player2: number;
    winner: HoleWinner | null;
  } | null>(null);
  // The "whose turn" announcement. Keyed, so a poll returning the same state
  // never re-announces a turn it already announced.
  const [turnCall, setTurnCall] = useState<{
    key: string;
    seat: Seat;
    hole: number;
    text: string;
  } | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  // ── Interaction state ─────────────────────────────────────────────────
  const [aim, setAim] = useState({ angle: 270, power: 50 });
  // Pool Masters two-phase aiming, ported verbatim: a click pins the angle,
  // then a drag charges power and its release launches the ball. There is no
  // shoot button and no power slider.
  const [aimLocked, setAimLocked] = useState(false);
  const [shooting, setShooting] = useState(false);
  const [showForfeitConfirm, setShowForfeitConfirm] = useState(false);
  const [forfeiting, setForfeiting] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  // Set when a refresh was requested while the board was busy (a rollout
  // playing, or the hole-result interstitial up). Flushed once the board is
  // free — see `refresh` / `flushPendingRefresh`.
  const pendingRefreshRef = useRef(false);
  const matchRef = useRef<any>(null);
  const hydratedRef = useRef(false);
  const lastAnimatedSeqRef = useRef(-1);
  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What owns the board right now. `animRef`/`overlayRef` are read inside the
  // RAF loop and the timers so they never see a stale closure; `queuedAnimRef`
  // holds the NEXT authoritative shot so a newer snapshot can never abort a
  // rollout mid-flight — dropping that in-flight shot is exactly what used to
  // swallow the hole-result popup. `shownHolesRef` makes the interstitial
  // idempotent per hole.
  const animRef = useRef<Rollout | null>(null);
  const overlayRef = useRef<{ hole: number } | null>(null);
  const queuedAnimRef = useRef<Rollout | null>(null);
  const shownHolesRef = useRef<Set<number>>(new Set());
  /** The shot sequence the bot recap was last built for (dedupes the effect). */
  const botRecapSeqRef = useRef(-1);
  /** The (hole, seat, shot) the turn announcement was last built for. */
  const turnCallKeyRef = useRef("");
  const turnCallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the latest snapshot in a ref for callbacks that outlive a render
  // (the animation-completion timer in particular). Declared BEFORE the
  // animation effects so it lands first in the effect order.
  useEffect(() => {
    matchRef.current = match;
  }, [match]);

  // Re-initialise EVERY piece of presentation state when the match changes.
  //
  // The App Router reuses this same page instance when only the `[matchId]`
  // param differs, so without this the view would keep the previous match's
  // balls, roll animation and aim — which reads to the player as "every match
  // is the same course".
  useEffect(() => {
    hydratedRef.current = false;
    lastAnimatedSeqRef.current = -1;
    animRef.current = null;
    overlayRef.current = null;
    pendingRefreshRef.current = false;
    queuedAnimRef.current = null;
    shownHolesRef.current = new Set();
    botRecapSeqRef.current = -1;
    turnCallKeyRef.current = "";
    setTurnCall(null);
    setShowDetails(false);
    setBotRecap(null);
    setMatch(null);
    setRenderBalls(null);
    setAnim(null);
    setHoleOverlay(null);
    setAim({ angle: 270, power: 50 });
    setAimLocked(false);
    setLoadError(null);
    if (overlayTimerRef.current) {
      clearTimeout(overlayTimerRef.current);
      overlayTimerRef.current = null;
    }
    if (turnCallTimerRef.current) {
      clearTimeout(turnCallTimerRef.current);
      turnCallTimerRef.current = null;
    }
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
        // Never let a slower snapshot overwrite a newer authoritative one:
        // several refreshes (poll, socket push, post-shot resync) can be in
        // flight at once, and `version` is monotonic. A same-version terminal
        // snapshot (forfeit/cancel) also can never be rolled back.
        setMatch((prev: any) =>
          isIncomingSnapshotStale(prev, data.data) ? prev : data.data,
        );
        setLoadError(null);
      } catch (error: any) {
        if (error?.name === "AbortError") return;
      }
    },
    [apiMatch, matchId],
  );

  // A snapshot request is not a passive read in a practice match: the GET is
  // what runs the server-driven bot's turn, and it is also what delivers the
  // opponent's move in a human duel. Firing it while a shot or the hole-result
  // interstitial owns the board is exactly what made the opponent's turn
  // disappear — the bot played the next hole (or the opponent moved) behind the
  // interstitial and the hand-off was never seen. Defer it until the board is
  // free instead, then flush once (see `flushPendingRefresh`).
  const refresh = useCallback(() => {
    if (animRef.current || overlayRef.current) {
      pendingRefreshRef.current = true;
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    void fetchSnapshot(controller.signal);
  }, [fetchSnapshot]);

  // Run the deferred refresh once nothing owns the board. Safe to call from
  // every settle point: a still-busy board (a queued rollout just started, or
  // the interstitial went back up) simply leaves the request pending.
  const flushPendingRefresh = useCallback(() => {
    if (!pendingRefreshRef.current) return;
    if (animRef.current || overlayRef.current) return;
    pendingRefreshRef.current = false;
    refresh();
  }, [refresh]);

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
  // Any snapshot carrying an as-yet-unplayed `lastShot` is played back. A shot
  // that belongs to an earlier hole is played on THAT hole first, so the
  // opponent sees exactly what the shooter saw before the board advances.
  //
  // Playback is QUEUED, never pre-empted: a snapshot that lands while a rollout
  // or its hole-result interstitial is on screen is held back instead of
  // cancelling what is playing. Cancelling was the bug behind the missing
  // hole-result popup — the interrupted shot was usually the one that had just
  // completed a hole, so its result interstitial never got shown.
  const startRollout = useCallback((rollout: Rollout) => {
    animRef.current = rollout;
    setAimLocked(false);
    setProgress(0);
    setAnim(rollout);
  }, []);

  const playQueuedRollout = useCallback(() => {
    if (animRef.current || overlayRef.current) return;
    const next = queuedAnimRef.current;
    if (!next) return;
    queuedAnimRef.current = null;
    const currentHole = Number(matchRef.current?.currentHole) || 0;
    // A rollout for a hole whose result has already been shown, and which the
    // board has already left, has nothing left to tell the player.
    if (shownHolesRef.current.has(next.hole) && next.hole < currentHole) return;
    startRollout(next);
  }, [startRollout]);

  const showHoleResult = useCallback(
    (
      hole: number,
      score: { player1: number; player2: number } | null | undefined,
      winner: HoleWinner | null,
    ) => {
      if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
      // Idempotent per hole: the shooter's shot and the opponent's completing
      // shot can both resolve to the SAME hole, and it must read once.
      shownHolesRef.current.add(hole);
      const overlay = {
        hole,
        player1: Number(score?.player1) || 0,
        player2: Number(score?.player2) || 0,
        winner,
      };
      overlayRef.current = overlay;
      setHoleOverlay(overlay);
      overlayTimerRef.current = setTimeout(() => {
        overlayTimerRef.current = null;
        overlayRef.current = null;
        // Dropping the overlay is what moves the view on when nothing else is
        // queued: the rendered hole is derived from the snapshot, so it
        // advances by itself the moment the interstitial goes away. Anything
        // that arrived while it was up then plays.
        setHoleOverlay(null);
        setRenderBalls(cloneBalls(matchRef.current?.balls));
        playQueuedRollout();
        // The interstitial is gone — if the opponent/AI moved (or was queued)
        // while it was up, fetch now so their turn gets its own visible beat.
        flushPendingRefresh();
      }, HOLE_RESULT_MS);
    },
    [playQueuedRollout, flushPendingRefresh],
  );

  const finishAnimation = useCallback(
    (finished: Rollout) => {
      animRef.current = null;
      setAnim(null);
      setProgress(1);
      const latest = matchRef.current;
      const path = finished.path;
      const end = path.length ? path[path.length - 1] : { x: 0, y: 0 };
      const currentHole = Number(latest?.currentHole) || finished.hole;
      const holeCompleted = Boolean(latest) && finished.hole < currentHole;

      if (holeCompleted) {
        // The result interstitial is idempotent per hole: the human's shot and
        // the bot's completing shot can both resolve on the SAME hole, and it
        // must read once.
        if (!shownHolesRef.current.has(finished.hole)) {
          // Hold the completed hole on screen with its final ball positions,
          // show the result, then let the snapshot advance the board.
          setRenderBalls((prev) =>
            prev
              ? { ...prev, [finished.seat]: { x: end.x, y: end.y, holedOut: finished.pocketed } }
              : prev,
          );
          showHoleResult(
            finished.hole,
            latest.holeScores?.[finished.hole - 1],
            latest.holeWinners?.[finished.hole - 1] ?? null,
          );
          return;
        }
        setRenderBalls(cloneBalls(latest?.balls));
        playQueuedRollout();
        flushPendingRefresh();
        return;
      }

      // Same hole: adopt the authoritative rest positions (and holed-out flags).
      setRenderBalls(cloneBalls(latest?.balls) ?? null);
      playQueuedRollout();
      flushPendingRefresh();
    },
    [playQueuedRollout, showHoleResult, flushPendingRefresh],
  );

  useEffect(() => {
    if (!match) return;
    const seq = Number(match.shotSeq) || 0;
    const last = match.lastShot;

    if (!hydratedRef.current) {
      hydratedRef.current = true;
      lastAnimatedSeqRef.current = seq;
      setRenderBalls(cloneBalls(match.balls));
      return;
    }
    if (!last || !Array.isArray(last.result?.path) || last.result.path.length === 0) return;
    if (lastAnimatedSeqRef.current === seq) return;

    lastAnimatedSeqRef.current = seq;
    const path: Vec2[] = last.result.path;
    const frames = Number(last.result?.frames) || 0;
    const rollout: Rollout = {
      seq,
      seat: last.seat,
      hole: Number(last.hole) || Number(match.currentHole) || 1,
      path,
      pocketed: Boolean(last.result?.pocketed),
      frames,
      duration: animationDurationMs(path, { frames }),
      startedAt:
        typeof performance !== "undefined" ? performance.now() : Date.now(),
    };

    // Something is already on screen (a rollout, or a hole-result interstitial):
    // hold this shot back rather than aborting the one playing. Only the newest
    // held shot matters, so a plain single-slot queue is enough.
    if (animRef.current || overlayRef.current) {
      queuedAnimRef.current = rollout;
      return;
    }
    startRollout(rollout);
  }, [match, startRollout]);

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
      if (turnCallTimerRef.current) clearTimeout(turnCallTimerRef.current);
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

  // The ONLY way a shot is ever requested: a locked power drag released on the
  // course. It is still just a `{ angle, power }` request — the server decides
  // everything that follows.
  const launchShot = useCallback(
    async ({ angle, power }: { angle: number; power: number }) => {
    if (!match || !canShoot) return;
    const shotPower = clampPower(power);
    const shotAngle = ((Math.round(angle) % 360) + 360) % 360;
    setAimLocked(false);
    // The viewer is taking their turn: the bot's recap has served its purpose.
    setBotRecap(null);
    setAim({ angle: shotAngle, power: shotPower });
    setShooting(true);
    setLoadError(null);
    try {
      const res = await fetch(`${apiMatch}/shoot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          angle: shotAngle,
          power: shotPower,
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
      // NOTE: practice used to refetch IMMEDIATELY here, to hand the turn to the
      // bot without waiting for the next poll. That made the opponent's whole
      // turn resolve in the same instant the player's own shot landed — the
      // board appeared to jump past the opponent entirely. The bot is
      // server-driven off the poll already, so it is left to the next poll
      // (ACTIVE_POLL_MS): the turn announcement and the bot's own ball get a
      // visible beat first, and the authoritative result is unchanged.
    } catch {
      setLoadError("Shot failed — retrying");
      refresh();
    } finally {
      setShooting(false);
    }
    },
    [match, canShoot, apiMatch, refresh, socket, matchId],
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
      await fetch(`${apiMatch}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      refresh();
    } finally {
      setForfeiting(false);
    }
  }, [apiMatch, refresh]);

  // ── Derived view model ────────────────────────────────────────────────
  // Which hole's geometry belongs on screen, in priority order:
  //   1. the hole whose result interstitial is up (it is the finished hole),
  //   2. the hole the playing shot was SIMULATED on — drawing a server
  //      trajectory against any other hole's walls is what makes a ball look
  //      like it flew straight through them,
  //   3. otherwise the authoritative current hole.
  const viewHoleNumber =
    holeOverlay?.hole ?? anim?.hole ?? Math.max(1, Number(match?.currentHole) || 1);

  // Whose ball belongs on the board: the seat whose shot is in flight, else the
  // seat whose turn it is. A Mini Golf turn is one seat running its OWN ball to
  // the cup, so the opponent's ball is deliberately not drawn — showing both at
  // once made it look like two balls were live and left "whose shot is this?"
  // ambiguous. While the hole-result interstitial is up, the ball that just
  // finished is the one worth leaving on screen behind it.
  const turnSeat: Seat | null = (match?.currentTurn as Seat | undefined) ?? null;
  const ballSeat: Seat | null =
    anim?.seat ??
    (holeOverlay ? ((match?.lastShot?.seat as Seat | undefined) ?? turnSeat) : turnSeat);

  const hole = useMemo(() => {
    const holes = match?.holes;
    if (!Array.isArray(holes) || holes.length === 0) return null;
    const index = Math.min(Math.max(viewHoleNumber, 1), holes.length) - 1;
    return holes[index];
  }, [match?.holes, viewHoleNumber]);

  const aimFrom = useMemo<Vec2 | null>(() => {
    if (!viewerSeat) return null;
    const ball = renderBalls?.[viewerSeat] ?? match?.balls?.[viewerSeat];
    if (!ball) return null;
    return { x: ball.x, y: ball.y };
  }, [viewerSeat, renderBalls, match?.balls]);

  const movingBall = useMemo<Vec2 | null>(() => {
    if (!anim) return null;
    // Play the trajectory with the simulator's own exponential deceleration, so
    // the ball glides to a stop instead of sliding at a constant speed and then
    // stopping dead.
    return samplePath(
      anim.path,
      rollingProgress(progress, anim.frames, hole?.geometry?.friction),
    );
  }, [anim, progress, hole]);

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
  // The practice bot is GRYND AI — the platform's shared bot identity, so a bot
  // opponent reads the same here as it does in every other GRYND game.
  const opponentName = match?.isAi
    ? "GRYND AI"
    : seats.opponent?.name || seatLabel(opponentSeat ?? "player2", viewerSeat);
  const opponentId = opponentSeat === "player1" ? match?.player1Id : match?.player2Id;
  // The practice bot's tier (null on a human duel). Surfaced on the header
  // badge, the sidebar and the result screen so the picked difficulty is
  // always legible while the match runs and after it settles.
  const botDifficulty = match?.isAi ? coerceAiDifficulty(match.aiDifficulty) : null;

  // ── Practice-bot recap ────────────────────────────────────────────────
  // The bot resolves its whole turn inside ONE poll, so its intermediate shots
  // are never animated client-side. When the turn comes back to the viewer,
  // summarise the run it just took (and where its ball stopped). The recap is
  // dropped the moment the viewer takes their own shot.
  useEffect(() => {
    if (!match) return;
    if (!match.isAi || !viewerSeat || !opponentSeat) {
      setBotRecap(null);
      return;
    }
    if (match.status === "finished" || match.status === "cancelled") {
      setBotRecap(null);
      return;
    }
    // Only meaningful once the bot has handed the turn back to the viewer.
    if (match.currentTurn !== viewerSeat) return;
    if (match.lastShot?.seat === viewerSeat) {
      setBotRecap(null);
      return;
    }
    if (match.lastShot?.seat !== opponentSeat) return;
    const seq = Number(match.shotSeq) || 0;
    if (seq === botRecapSeqRef.current) return;
    botRecapSeqRef.current = seq;
    setBotRecap(
      lastBotTurnRecap({
        shots: match.shots,
        botPlayerId: opponentId,
        holes: match.holes,
      }),
    );
  }, [match, viewerSeat, opponentSeat, opponentId]);

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

  // ── Turn announcement ─────────────────────────────────────────────────
  // A turn ending is the one moment a player has to re-orient, and in a
  // practice match the bot's run resolves inside a single poll — so without an
  // explicit callout the hand-off reads as "the board jumped". Announced once
  // per (hole, seat, shot): the poll, the socket push and the post-shot resync
  // all redeliver the same state, and it must read once.
  useEffect(() => {
    if (!match || finished || cancelled) return;
    // The hole-result interstitial owns the screen; the hand-off it leads to is
    // announced the moment it clears (this effect re-runs on that change).
    if (holeOverlay) return;
    // A rollout owns the board too. Announcing a hand-off mid-flight would
    // consume the (hole, seat, shot) key before the interstitial/rollout it
    // belongs to has finished, so the hand-off the player actually needs to
    // see — the opponent's/AI's turn on the next hole — would never surface.
    if (anim) return;
    const seat: Seat | null = match.currentTurn ?? null;
    if (!seat) return;
    const key = `${Number(match.currentHole) || 0}:${seat}:${Number(match.shotSeq) || 0}`;
    if (key === turnCallKeyRef.current) return;
    turnCallKeyRef.current = key;

    const isBotSeat = Boolean(match.isAi) && seat === opponentSeat;
    const text =
      seat === viewerSeat
        ? "Your turn"
        : isBotSeat
          ? "GRYND AI turn"
          : `${seats.opponent?.name || seatLabel(seat, viewerSeat)}'s turn`;

    if (turnCallTimerRef.current) clearTimeout(turnCallTimerRef.current);
    setTurnCall({ key, seat, hole: Math.max(1, Number(match.currentHole) || 1), text });
    turnCallTimerRef.current = setTimeout(() => {
      turnCallTimerRef.current = null;
      setTurnCall(null);
    }, TURN_CALL_MS);
  }, [match, finished, cancelled, holeOverlay, anim, viewerSeat, opponentSeat, seats.opponent?.name]);

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
        ? match.isAi
          ? "You're in — GRYND AI is finishing the hole"
          : "You're in — waiting for your opponent to finish"
        : isMyTurn
          ? "Your turn"
          : match.isAi
            ? "GRYND AI is playing…"
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
          className="flex min-h-[calc(100svh-68px)] flex-col overflow-x-clip bg-gradient-to-b from-[#04170e] via-[#03150c] to-[#020f08] text-white sm:min-h-[calc(100svh-4rem)]"
        >
          {/* The app navbar every other game page renders. The root layout
              reserves top padding for it (pt-[68px] / sm:pt-16), which is why
              the shell is exactly the viewport minus that. */}
          <NavigationBar currentPath="/casino" />
          <div className="mx-auto flex min-h-0 w-full max-w-[1500px] flex-1 flex-col gap-2 p-2 sm:gap-3 sm:p-3">
            {/* Top strip — hole, format, tier, turn status and actions. It is
                deliberately ONE compact row: the course below owns the rest of
                the viewport. */}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-1.5 sm:gap-2">
              <div>
                <h1 className="flex items-center gap-1.5 text-lg font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-emerald-300 via-emerald-400 to-lime-300 sm:text-xl">
                  <IconGolf className="h-5 w-5 text-emerald-400" />
                  Mini Golf
                </h1>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-emerald-200/70">
                  <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 tracking-normal text-white/65">
                    Format · {matchFormatLabel(HOLE_COUNT, HOLES_TO_WIN)}
                  </span>
                  {match.isAi && botDifficulty && (
                    <span
                      data-testid="practice-badge"
                      data-difficulty={botDifficulty}
                      className="rounded-full border border-emerald-400/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold tracking-wider text-emerald-200"
                    >
                      Practice · {AI_DIFFICULTY_LABELS[botDifficulty]} bot · unrated
                    </span>
                  )}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span
                  data-testid="hole-indicator"
                  className="rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-emerald-200"
                >
                  Hole {Math.min(Number(match.currentHole) || 1, HOLE_COUNT)} of {HOLE_COUNT} ·{" "}
                  {difficultyLabel(hole)}
                </span>
                <span
                  data-testid="turn-status"
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                    isMyTurn && !finished
                      ? "border-emerald-400/50 bg-emerald-500/15 text-emerald-300"
                      : "border-white/10 bg-white/5 text-white/60"
                  }`}
                >
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      isMyTurn && !finished ? "animate-pulse bg-emerald-400" : "bg-white/30"
                    }`}
                  />
                  {myTurnLabel}
                </span>
                {match.status === "playing" && (
                  <button
                    onClick={() => setShowForfeitConfirm(true)}
                    className="inline-flex items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] font-bold text-red-300 transition hover:bg-red-500/20"
                  >
                    <IconDoorExit size={13} />
                    <span className="hidden sm:inline">Forfeit</span>
                  </button>
                )}
                <button
                  onClick={() => router.push("/casino/mini-golf")}
                  className="rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-white/20"
                >
                  Lobby
                </button>
              </div>
            </div>

            {/* Below lg this is a normal document flow column so the page just
                scrolls; from lg up it becomes the fixed-height, two-column
                table where the course takes every pixel left over. */}
            <div className="grid min-h-0 gap-2 sm:gap-3 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_300px]">
              {/* ── Board column ─────────────────────────────────────── */}
              <div className="flex min-h-0 flex-col rounded-2xl border border-emerald-500/20 bg-black/40 p-2 shadow-[0_0_30px_rgba(16,185,129,0.12)] sm:p-3">
                {/* Scoreboard */}
                <div className="mb-2 grid shrink-0 grid-cols-2 gap-2">
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

                {/* Course — the board IS the game, so it takes every pixel the
                    strip and the seat row above leave, on any viewport, instead
                    of a fixed clamp() box. */}
                <div
                  data-testid="mini-golf-board"
                  className="relative w-full flex-1 overflow-hidden rounded-xl border border-emerald-500/25 bg-[#052314] min-h-[clamp(240px,46svh,560px)] lg:min-h-[220px]"
                >
                  {/* Absolutely positioned so the canvas gets a definite box to
                      measure and fill; the overlays below sit on top of it. */}
                  <div className="absolute inset-0">
                    <MiniGolfCourse
                      hole={hole}
                      balls={renderBalls}
                      movingSeat={anim?.seat ?? null}
                      movingBall={movingBall}
                      visibleSeat={ballSeat}
                      aim={aim}
                      aimFrom={aimFrom}
                      aimLocked={aimLocked}
                      interactive={canShoot}
                      onAim={(next) =>
                        setAim((prev) => ({
                          angle: Math.round(next.angle),
                          power: clampPower(next.power),
                        }))
                      }
                      onLock={() => setAimLocked(true)}
                      onUnlock={() => setAimLocked(false)}
                      onLaunch={(next) => void launchShot(next)}
                      viewerSeat={viewerSeat}
                    />
                  </div>
                  {/* ── Turn announcement ──────────────────────────────
                      A hand-off is the one beat a player has to re-orient on,
                      and in a practice match GRYND AI's whole run resolves inside
                      a single poll — so this is often the only sign the opponent
                      took a turn at all. */}
                  <AnimatePresence>
                    {turnCall && (
                      <motion.div
                        key={turnCall.key}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center px-4"
                        role="status"
                        aria-live="polite"
                      >
                        <motion.div
                          initial={{ scale: 0.88, y: 12, opacity: 0 }}
                          animate={{ scale: 1, y: 0, opacity: 1 }}
                          exit={{ scale: 1.06, opacity: 0 }}
                          transition={{ type: "spring", stiffness: 320, damping: 24 }}
                          className="rounded-2xl border-2 px-6 py-3 text-center backdrop-blur-md"
                          style={{
                            borderColor: `${seatColor(turnCall.seat)}99`,
                            background: "rgba(2,15,8,0.74)",
                            boxShadow: `0 0 46px ${seatColor(turnCall.seat)}55`,
                          }}
                        >
                          <p
                            data-testid="turn-announcement"
                            className="text-xl font-black tracking-wide sm:text-2xl"
                            style={{ color: seatColor(turnCall.seat) }}
                          >
                            {turnCall.text}
                          </p>
                          <p className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.24em] text-white/50">
                            Hole {turnCall.hole} of {HOLE_COUNT}
                          </p>
                        </motion.div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* ── Aim read-out + lock state ─────────────────────
                      The shot is aimed ON the board, so the read-out lives on
                      the board too. This is what replaces the old bottom
                      control panel. */}
                  <div className="pointer-events-none absolute right-2 top-2 z-20 flex flex-wrap items-center justify-end gap-1.5">
                    <span className="rounded-full bg-black/55 px-2.5 py-1 text-[10px] font-semibold text-white/75 backdrop-blur-sm">
                      <span className="inline-flex items-center gap-1">
                        <IconTargetArrow size={11} /> Angle{" "}
                        <span className="font-mono text-white">{Math.round(aim.angle)}°</span>
                      </span>
                      <span className="mx-1.5 text-white/25">·</span>
                      Power <span className="font-mono text-white">{clampPower(aim.power)}%</span>
                    </span>
                    <span
                      data-testid="aim-state"
                      data-locked={aimLocked ? "true" : "false"}
                      className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider backdrop-blur-sm ${
                        aimLocked
                          ? "border-emerald-400/50 bg-emerald-500/20 text-emerald-200"
                          : "border-white/15 bg-black/45 text-white/55"
                      }`}
                    >
                      {shooting ? "Sending…" : aimLocked ? "🔒 Angle locked" : "Unlocked"}
                    </span>
                  </div>

                  {/* ── GRYND AI recap ─────────────────────────────────
                      The bot's whole turn is batched into one poll, so this is
                      the only place the human sees what it did. */}
                  {botRecap && botDifficulty && (
                    <div
                      data-testid="bot-turn-summary"
                      role="status"
                      aria-live="polite"
                      className="absolute bottom-12 left-2 z-20 max-w-[min(24rem,calc(100%-1rem))] rounded-lg border border-cyan-500/25 bg-black/70 px-3 py-1.5 text-[10px] text-cyan-100 backdrop-blur-sm"
                    >
                      <span className="font-bold uppercase tracking-wider text-cyan-300">
                        {AI_DIFFICULTY_LABELS[botDifficulty]} bot's turn
                      </span>{" "}
                      <span className="text-white/80">
                        Hole {botRecap.hole} · {botRecap.strokes}{" "}
                        {botRecap.strokes === 1 ? "shot" : "shots"}
                        {botRecap.pocketed
                          ? " · holed out"
                          : botRecap.restDistance != null
                            ? ` · finished ${Math.round(botRecap.restDistance)}px from the cup`
                            : " · settled"}
                      </span>
                    </div>
                  )}

                  {/* ── Soft dim while the opponent plays ─────────────── */}
                  {!finished && !cancelled && !isMyTurn && !anim && !holeOverlay && (
                    <div className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-b from-black/35 via-transparent to-black/35" />
                  )}

                  {/* ── Power rail + status, along the bottom edge ────── */}
                  <div className="pointer-events-none absolute inset-x-2 bottom-2 z-20 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/50">
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
                    <span className="rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-semibold text-white/70 backdrop-blur-sm">
                      {anim
                        ? "Ball rolling…"
                        : match.viewerHasHoledOut
                          ? "Hole complete"
                          : canShoot
                            ? aimLocked
                              ? "Drag back & release to putt"
                              : "Move to aim · click to lock"
                            : isMyTurn
                              ? "Waiting for the board…"
                              : "Waiting…"}
                    </span>
                  </div>

                  {loadError && (
                    <p className="absolute inset-x-2 bottom-9 z-20 rounded-lg border border-amber-400/30 bg-black/70 px-2 py-1 text-center text-[10px] text-amber-200 backdrop-blur-sm">
                      {loadError}
                    </p>
                  )}
                </div>
              </div>

              {/* ── Sidebar ─────────────────────────────────────────── */}
              <aside className="flex min-h-0 flex-col gap-2 sm:gap-3 lg:max-h-full lg:overflow-y-auto">
                {/* Match facts are reference material, not something anyone
                    reads mid-putt — so they collapse behind a single line that
                    still shows the live score, instead of eating the sidebar. */}
                <section className="shrink-0 rounded-2xl border border-emerald-500/20 bg-black/40 p-3">
                  <button
                    type="button"
                    data-testid="match-details-toggle"
                    aria-expanded={showDetails}
                    onClick={() => setShowDetails((open) => !open)}
                    className="flex w-full items-center justify-between gap-2 text-left"
                  >
                    <span className="text-sm font-bold uppercase tracking-wider text-emerald-300">
                      Match
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-white/60">
                      <span className="font-mono text-white/80">
                        {match.player1HoleWins} — {match.player2HoleWins}
                      </span>
                      <IconChevronDown
                        size={14}
                        className={`transition-transform ${showDetails ? "rotate-180" : ""}`}
                      />
                    </span>
                  </button>
                  <AnimatePresence initial={false}>
                    {showDetails && (
                      <motion.div
                        key="match-details"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="overflow-hidden"
                      >
                        <div className="mt-3 space-y-1.5 text-xs">
                          <Row
                            label="Format"
                            value={matchFormatLabel(HOLE_COUNT, HOLES_TO_WIN)}
                          />
                          <Row
                            label="Holes won"
                            value={`${match.player1HoleWins} — ${match.player2HoleWins}`}
                          />
                          <Row
                            label="Total strokes"
                            value={`${totals.player1} — ${totals.player2}`}
                          />
                          <Row label="Opponent" value={opponentName} />
                          {botDifficulty && (
                            <Row
                              label="Bot difficulty"
                              value={AI_DIFFICULTY_LABELS[botDifficulty]}
                            />
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </section>

                <section className="rounded-2xl border border-emerald-500/20 bg-black/40 p-3">
                  <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-emerald-300">
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

                <section className="rounded-2xl border border-emerald-500/20 bg-black/40 p-3">
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
                ...(botDifficulty
                  ? [{ label: "Bot difficulty", value: AI_DIFFICULTY_LABELS[botDifficulty] }]
                  : []),
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
