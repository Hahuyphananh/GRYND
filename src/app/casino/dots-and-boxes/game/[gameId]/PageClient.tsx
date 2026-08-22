"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useSocket } from "../../../../../context/SocketProvider";
import useGamePresence from "../../../../../hooks/useGamePresence";
import DotsAndBoxesBoard from "../../../../../components/DotsAndBoxesBoard";
import ReportModal from "../../../../../components/ReportModal";
import { useTranslation } from "../../../../../hooks/useTranslation";
import { playTimerUrgent, playTimerExpired } from "../../../../../lib/dotsAndBoxesAudio";
import { gameOverModal as gameOverModalAnim } from "../../../../../lib/animations";
import {
  IconAlertTriangle,
  IconRuler,
  IconFlag,
  IconDoorExit,
  IconTrophy,
  IconHeartHandshake,
  IconBomb,
} from "@tabler/icons-react";

// ─── Module-level empty defaults (shared reference across renders) ─
// Mutable types so passing into the board component (typed
// `Set<string>` / `string[]`) doesn't trigger a covariant mismatch.
const EMPTY_EDGES: string[] = [];
const EMPTY_BOX_OWNERS: Record<string, "host" | "guest"> = {};
const EMPTY_SCORES = { host: 0, guest: 0 };

// ─── Active poll interval — slower when finished so we let the user
//      read the result without burning CPU/DB on stale polls. ────────
const ACTIVE_POLL_MS = 1500;
const IDLE_POLL_MS = 5000;

export default function DotsAndBoxesGamePage() {
  const { gameId } = useParams<{ gameId: string }>();
  const router = useRouter();
  const { socket } = useSocket();
  const { t } = useTranslation();

  const [game, setGame] = useState<any>(null);
  const [statusText, setStatusText] = useState(t("games.dots_and_boxes.loading_game"));
  const [drawing, setDrawing] = useState(false);
  const drawingRef = useRef(false);
  // Forfeit/cancel UX: a real in-app confirmation modal instead of the
  // native confirm() dialog — and a second flag for "we're calling the
  // API right now" so the buttons can show a spinner state.
  const [showForfeitConfirm, setShowForfeitConfirm] = useState(false);
  const [forfeiting, setForfeiting] = useState(false);
  // Report modal — flags the human opponent for moderation.
  const [showReportModal, setShowReportModal] = useState(false);
  // Visual-only countdown. Source of truth is the server's moveDeadlineAt.
  const [now, setNow] = useState<number>(() => Date.now());

  // AbortController ref so each new poll/request cancels the previous
  // in-flight fetch. Prevents stale responses from clobbering newer
  // state when the network is slow.
  const abortRef = useRef<AbortController | null>(null);

// Keyed-debounce ref so the "almost up" audio cue fires exactly once
// per turn. The string is the current moveDeadlineAt; on each new
// deadline (new turn) the ref no longer matches and we re-arm.
const urgentCuePlayedFor = useRef<string | null>(null);
// Mirror ref for the deadline-passed cue so it also fires exactly once
// per turn. Without this we'd loop the lower-pitched tone on every
// poll that reports remainingMs <= 0.
const expiredCuePlayedFor = useRef<string | null>(null);
// A11y: skip the motion-driven visual cue (but keep the audio beep,
// which is functional feedback) when the user prefers reduced motion.
const prefersReducedMotion = useReducedMotion();

  useGamePresence({
    gameKey: "dots-and-boxes",
    gameId: Number(gameId),
    enabled: Boolean(gameId),
  });

  // ─── fetchState: cancellable, ref-equality guarded ────────────────
  const fetchState = useCallback(
    async (opts?: { signal?: AbortSignal }) => {
      try {
        const res = await fetch(
          `/api/dots-and-boxes/game-state?gameId=${gameId}`,
          { cache: "no-store", signal: opts?.signal },
        );
        // Server returned "no-change" sentinel — nothing to render.
        if (res.status === 304) return;
        const data = await res.json();
        if (opts?.signal?.aborted) return;
        if (!res.ok) {
          setStatusText(data.error || t("games.dots_and_boxes.load_failed"));
          return;
        }
        const gameData = data.data;

        // ── Ref-equality guard ────────────────────────────────
        // Skip the setGame call entirely if every gameplay field is
        // byte-identical to the current state. This prevents React
        // from re-running derived useMemos each poll when nothing
        // actually changed (e.g., during opponent's deliberation
        // the server returns the same deadline + score + edges).
        setGame((prev) => (gameStateUnchanged(prev, gameData) ? prev : gameData));

        setStatusText(computeStatusText(gameData, t));
      } catch (err) {
        if (err?.name === "AbortError") return;
        console.error("dots-and-boxes fetch failed", err);
      }
    },
    [gameId, t],
  );

  // ─── Polling with adaptive interval + abort ───────────────────────
  // - 1.5s while in_progress, 5s once finished/cancelled (so we still
  //   pick up any late payout writes but don't burn CPU).
  // - Cancel stale fetches when a new one fires.
  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setTimeout> | null = null;

    const tick = () => {
      if (cancelled) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      void fetchState({ signal: ac.signal });
      const delay =
        game?.status === "finished" || game?.status === "cancelled"
          ? IDLE_POLL_MS
          : ACTIVE_POLL_MS;
      intervalId = setTimeout(tick, delay);
    };

    // Initial fetch, then schedule.
    tick();

    return () => {
      cancelled = true;
      if (intervalId) clearTimeout(intervalId);
      abortRef.current?.abort();
    };
    // game?.status is included so the interval adapts when the match ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchState, game?.status]);

  // ─── Visual countdown — server is source of truth, this just renders
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, []);

  // ─── Socket sync ───────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;
    const roomId = `dots-and-boxes:${gameId}`;
    const refresh = () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      void fetchState({ signal: ac.signal });
    };
    socket.emit("join_room", { roomId });
    socket.on("match:updated", refresh);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("match:updated", refresh);
    };
  }, [socket, gameId, fetchState]);

  // ─── Derived board props ────────────────────────────────────────────
  // Memoize against the raw game state so an unchanged set won't
  // recompute, and so the Set/Array references are stable across
  // renders (which the memoed board relies on for skip-render).
  const gameState = game?.gameState ?? null;
  const edgesKey = useMemo(() => {
    if (!gameState || !Array.isArray(gameState.edges)) return "";
    // Hash content order doesn't matter; canonicalize so equal sets
    // produce equal signatures regardless of insertion order.
    return [...(gameState.edges as string[])].sort().join("|");
  }, [gameState?.edges]);

  const {
    drawnH,
    drawnV,
    isMyTurn,
    currentTurn,
    scores,
    isFinished,
    remainingMs,
    remainingSeconds,
    timerSeconds,
    boardLocked,
    boxesForBoard,
    boxOwnersForBoard,
  } = useMemo(() => {
    const gs = game?.gameState;
    if (!gs || !Array.isArray(gs.edges)) {
      return {
        drawnH: new Set<string>(),
        drawnV: new Set<string>(),
        isMyTurn: false,
        currentTurn: null as "host" | "guest" | null,
        scores: EMPTY_SCORES,
        isFinished: false,
        remainingMs: 0,
        remainingSeconds: 0,
        timerSeconds: 20,
        boardLocked: true,
        boxesForBoard: EMPTY_EDGES,
        boxOwnersForBoard: EMPTY_BOX_OWNERS,
      };
    }

    const hSet = new Set<string>();
    const vSet = new Set<string>();
    for (const e of gs.edges as string[]) {
      const idx = e.indexOf(":");
      if (idx < 0) continue;
      const type = e.slice(0, idx);
      const coords = e.slice(idx + 1);
      if (type === "h") hSet.add(coords);
      else if (type === "v") vSet.add(coords);
    }

    const finished =
      game.status === "finished" || game.status === "cancelled";
    const myTurn =
      !finished &&
      game.status === "in_progress" &&
      game.role === gs.currentTurn;

    const deadline = game.moveDeadlineAt
      ? new Date(game.moveDeadlineAt).getTime()
      : 0;
    const ms = deadline ? Math.max(0, deadline - now) : 0;
    const seconds = Math.ceil(ms / 1000);

    return {
      drawnH: hSet,
      drawnV: vSet,
      isMyTurn: myTurn,
      currentTurn: gs.currentTurn as "host" | "guest" | null,
      scores: gs.scores || EMPTY_SCORES,
      isFinished: finished,
      remainingMs: ms,
      remainingSeconds: seconds,
      timerSeconds: game.timerSeconds || 20,
      boardLocked: finished,
      boxesForBoard: (gs.boxes as string[]) ?? EMPTY_EDGES,
      boxOwnersForBoard:
        (gs.boxOwners as Record<string, "host" | "guest">) ??
        EMPTY_BOX_OWNERS,
    };
    // The only deps we need: the canonical edges key, status, role,
    // currentTurn, deadline, and now. Splitting this way means a
    // field like `payout` (which we never read here) won't recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    edgesKey,
    game?.status,
    game?.role,
    game?.moveDeadlineAt,
    gameState?.currentTurn,
    gameState?.scores,
    gameState?.boxes,
    gameState?.boxOwners,
    now,
  ]);

  // ─── Edge drawing ───────────────────────────────────────────────────

  const drawEdge = useCallback(
    async (type: "h" | "v", row: number, col: number) => {
      if (drawingRef.current) return;
      drawingRef.current = true;
      setDrawing(true);

      try {
        const res = await fetch("/api/dots-and-boxes/draw-edge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gameId: Number(gameId), type, row, col }),
        });
        const data = await res.json();

        if (!data.success) {
          // Refresh state to resync on error (e.g. stale turn)
          abortRef.current?.abort();
          const ac = new AbortController();
          abortRef.current = ac;
          await fetchState({ signal: ac.signal });
          return;
        }

        socket?.emit("room_event", {
          roomId: `dots-and-boxes:${gameId}`,
          event: "match:updated",
          payload: { gameId: Number(gameId) },
        });
        setNow(Date.now());
      } finally {
        drawingRef.current = false;
        setDrawing(false);
      }
    },
    [socket, gameId, fetchState],
  );

  // ─── Cancel/forfeit handler ─────────────────────────────────────────
  // The button now opens a real in-app confirmation modal (see JSX
  // below). After the user confirms, we POST to the cancel endpoint
  // and re-sync state; the post-game result modal then appears for
  // both natural finishes and forfeits.
  const cancelGame = useCallback(async () => {
    if (forfeiting) return;
    setShowForfeitConfirm(false);
    setForfeiting(true);
    try {
      const res = await fetch("/api/dots-and-boxes/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: Number(gameId) }),
      });
      const data = await res.json();
      if (data.success) {
        socket?.emit("room_event", {
          roomId: `dots-and-boxes:${gameId}`,
          event: "match:updated",
          payload: { gameId: Number(gameId) },
        });
        socket?.emit("room_event", {
          roomId: "lobby:dots-and-boxes",
          event: "lobby:updated",
        });
        // Re-sync state via a fresh fetch so status flips to "finished"
        // and the result popup below mounts.
        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        await fetchState({ signal: ac.signal });
      } else {
        alert(data.error || t("games.dots_and_boxes.cancel_failed_alert"));
      }
    } finally {
      setForfeiting(false);
    }
  }, [socket, gameId, fetchState, t, forfeiting]);

  // ─── Audio cues (urgent + expired), each fires exactly once per turn ───
  // Both refs are keyed on `moveDeadlineAt` so they re-arm on every new
  // turn automatically. Effects are placed AFTER the derived-board
  // useMemo so `isMyTurn` / `remainingSeconds` / `remainingMs` are
  // safely in scope (no TDZ) when the effect runs.
  useEffect(() => {
    const deadlineKey = game?.moveDeadlineAt
      ? String(game.moveDeadlineAt)
      : null;
    if (!deadlineKey) {
      urgentCuePlayedFor.current = null;
      return;
    }
    if (
      urgentCuePlayedFor.current &&
      urgentCuePlayedFor.current !== deadlineKey
    ) {
      urgentCuePlayedFor.current = null;
    }
    if (!isMyTurn || remainingSeconds <= 0 || remainingSeconds > 3) return;
    if (urgentCuePlayedFor.current === deadlineKey) return;
    urgentCuePlayedFor.current = deadlineKey;
    playTimerUrgent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMyTurn, remainingSeconds, game?.moveDeadlineAt]);

  useEffect(() => {
    const deadlineKey = game?.moveDeadlineAt
      ? String(game.moveDeadlineAt)
      : null;
    // Recompute locally so we don't depend on `timerExpired` (which
    // is declared further down and would be in the TDZ).
    const turnExpired =
      game?.status === "in_progress" && remainingMs <= 0;
    if (!deadlineKey || !turnExpired) {
      expiredCuePlayedFor.current = null;
      return;
    }
    if (expiredCuePlayedFor.current === deadlineKey) return;
    expiredCuePlayedFor.current = deadlineKey;
    playTimerExpired();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.status, remainingMs, game?.moveDeadlineAt]);

  // ─── Modal close keyboard handlers (escape) ──────────────────────────
  // Forfeit confirm modal: ESC closes the prompt, but is gated on
  // `!forfeiting` so we can't accidentally orphan an in-flight API
  // request by closing the prompt mid-flight.
  useEffect(() => {
    if (!showForfeitConfirm || forfeiting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowForfeitConfirm(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showForfeitConfirm, forfeiting]);

  // ─── Render helpers ─────────────────────────────────────────────────

  // Report target: the opponent is whoever occupies the seat we don't
  // hold. `hostClerkId`/`guestClerkId` come from the game state, so we
  // can only report once a guest has actually joined (status != waiting)
  // and we're not spectating.
  const opponentClerkId =
    game?.role === "host" ? game?.guestClerkId : game?.hostClerkId;
  const opponentName =
    game?.role === "host"
      ? game?.guestName || t("games.dots_and_boxes.guest_default")
      : game?.hostName || t("games.dots_and_boxes.host_default");
  const canReport =
    !!opponentClerkId &&
    !!game &&
    game.status !== "waiting" &&
    (game.role === "host" || game.role === "guest");

  const timerUrgent = remainingSeconds > 0 && remainingSeconds <= 3;
  const timerExpired =
    game?.status === "in_progress" && remainingMs <= 0;

  const timerPct =
    timerSeconds > 0
      ? Math.max(0, Math.min(100, (remainingMs / (timerSeconds * 1000)) * 100))
      : 0;

  // ─── Result-popup derived state ─────────────────────────────────────
  // Show a centered win/loss/draw modal whenever the match is over
  // (finished OR cancelled). The host's "cancel the waiting lobby"
  // path lands in `cancelled`, not `finished`, so we include both.
  const showResultPopup =
    game?.status === "finished" || game?.status === "cancelled";
  const playerWon = useMemo(() => {
    if (!game || game.status !== "finished") return false;
    if (!game.winnerClerkId) return false;
    return (
      (game.role === "host" &&
        game.winnerClerkId === game.hostClerkId) ||
      (game.role === "guest" &&
        game.winnerClerkId === game.guestClerkId)
    );
  }, [game?.status, game?.winnerClerkId, game?.hostClerkId, game?.guestClerkId, game?.role]);
  const isDraw = game?.status === "finished" && game?.result === "draw";
  const isCancelled = game?.status === "cancelled";
  const isForfeitLoss =
    isResultLoss(game) && game?.result === "forfeit";

  // ── Keyboard handler for the result popup ────────────────────────
  // Lives below `showResultPopup` so the variable is in scope.
  useEffect(() => {
    if (!showResultPopup) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") router.push("/casino/dots-and-boxes");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showResultPopup, router]);

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8"
    >
      <div className="max-w-5xl mx-auto relative overflow-hidden rounded-2xl">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-orange-400 via-amber-400 to-yellow-500 drop-shadow-[0_0_18px_rgba(251,191,36,0.5)]">
              {t("games.dots_and_boxes.match_title", { gameId })}
            </h1>
          </div>
          <button
            onClick={() => router.push("/casino/dots-and-boxes")}
            className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 hover-lift"
          >
            {t("games.dots_and_boxes.back_to_lobby")}
          </button>
        </div>

        <div className="grid lg:grid-cols-[1fr_320px] gap-6">
          {/* ─── Game Board Area ────────────────────────────────────── */}
          <div className="casino-surface p-4 sm:p-6 rounded-2xl flex flex-col items-center justify-center border-[#f59e0b]/20">
            {/* Turn & timer */}
            {game?.status === "in_progress" && (
              <div className="mb-3 w-full max-w-[560px] flex flex-col items-center gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block h-3 w-3 rounded-full ${
                      isMyTurn ? "bg-green-400 animate-pulse" : "bg-white/30"
                    }`}
                  />
                  <span
                    className={`text-sm font-semibold ${
                      isMyTurn ? "text-green-300" : "text-white/60"
                    }`}
                  >
                    {isMyTurn
                      ? t("games.dots_and_boxes.your_turn")
                      : timerExpired
                        ? t("games.dots_and_boxes.time_expired")
                        : t("games.dots_and_boxes.opponent_thinking")}
                  </span>
                  {drawing && (
                    <span className="text-xs text-amber-400 animate-pulse ml-1">
                      {t("games.dots_and_boxes.drawing_now")}
                    </span>
                  )}
                </div>

                {/* Timer bar. position-relative so the urgency icon
                    below can anchor next to it without reflow. */}
                <div className="relative w-full h-2 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className={`h-full transition-all duration-200 ease-linear ${
                      timerUrgent
                        ? "bg-red-400"
                        : isMyTurn
                          ? "bg-amber-400"
                          : "bg-white/40"
                    }`}
                    style={{
                      width: `${timerPct}%`,
                      transform: "translateZ(0)", // GPU layer
                    }}
                  />
                </div>
                <span
                  className={`inline-flex items-center gap-1 text-xs font-mono ${
                    timerUrgent
                      ? "text-red-300"
                      : timerExpired
                        ? "text-red-400/80"
                        : "text-white/50"
                  }`}
                >
                  <span>
                    {t("games.dots_and_boxes.remaining_seconds", {
                      seconds: remainingSeconds,
                    })}
                  </span>
                  {/* One-shot urgency badge: a small warning glyph that scales in
                      next to the seconds counter when remainingSeconds
                      first drops into the (0, 3] window on the local
                      player's turn. Re-mounted per deadline (via key)
                      so the animation re-runs each turn. Skipped under
                      `prefers-reduced-motion`; the audio beep still
                      fires because it is functional feedback. */}
                  {timerUrgent && isMyTurn && !prefersReducedMotion && (
                    <motion.span
                      key={`urgent-badge-${String(
                        game?.moveDeadlineAt ?? "",
                      )}`}
                      aria-hidden
                      initial={{ opacity: 0, scale: 0.6 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.3, ease: "easeOut" }}
                      className="inline-flex items-center justify-center text-amber-300 leading-none"
                      style={{ fontSize: "0.95em" }}
                    >
                      <IconAlertTriangle size={14} />
                    </motion.span>
                  )}
                </span>
              </div>
            )}

            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.2, duration: 0.5 }}
              className="w-full flex justify-center"
            >
              <DotsAndBoxesBoard
                drawnH={drawnH}
                drawnV={drawnV}
                boxes={boxesForBoard}
                boxOwners={boxOwnersForBoard}
                player1Color="#f59e0b"
                player2Color="#f97316"
                interactive={isMyTurn && !drawing && !boardLocked}
                onEdgeHClick={drawEdge.bind(null, "h")}
                onEdgeVClick={drawEdge.bind(null, "v")}
                edgeTooltipH={(row, col) =>
                  t("games.dots_and_boxes.edge_tooltip_h", { row, col })
                }
                edgeTooltipV={(row, col) =>
                  t("games.dots_and_boxes.edge_tooltip_v", { row, col })
                }
              />
            </motion.div>
          </div>

          {/* ─── Sidebar ───────────────────────────────────────────── */}
          <div className="casino-surface p-4 rounded-2xl border-[#f59e0b]/20">
            <h2 className="text-base font-bold text-amber-300 mb-3 flex items-center gap-2 uppercase tracking-wider">
              <IconRuler size={16} aria-hidden />
              <span>{t("games.dots_and_boxes.match_details_title")}</span>
            </h2>

            <div className="mb-3 flex items-baseline gap-2">
              <span className="text-[10px] uppercase tracking-wider text-white/50">
                {t("games.dots_and_boxes.status_label")}
              </span>
              <span className="text-sm font-semibold text-white">
                {statusText}
              </span>
            </div>

            <div className="mb-3 flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-white/50">
                {t("games.dots_and_boxes.role_label")}
              </span>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${
                  game?.role === "host"
                    ? "bg-amber-500/15 text-amber-300 border border-amber-400/30"
                    : game?.role === "guest"
                      ? "bg-orange-500/15 text-orange-300 border border-orange-400/30"
                      : "bg-white/5 text-white/60 border border-white/10"
                }`}
              >
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    game?.role === "host"
                      ? "bg-amber-400"
                      : game?.role === "guest"
                        ? "bg-orange-400"
                        : "bg-white/40"
                  }`}
                />
                {game?.role === "host"
                  ? t("games.dots_and_boxes.role_host")
                  : game?.role === "guest"
                    ? t("games.dots_and_boxes.role_guest")
                    : t("games.dots_and_boxes.role_unknown")}
              </span>
            </div>

            {/* Scores */}
            {game?.status !== "waiting" && (
              <div className="mb-4 p-3 rounded-xl bg-white/5 border border-white/10">
                <div className="text-[10px] uppercase tracking-wider text-white/50 mb-2 text-center">
                  {t("games.dots_and_boxes.score_label")}
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div
                    className={`flex flex-col items-center flex-1 rounded-lg px-3 py-2 transition-transform ${
                      currentTurn === "host"
                        ? "bg-amber-500/15 border border-amber-400/40 scale-[1.02]"
                        : "bg-transparent"
                    }`}
                  >
                    <span className="text-xs text-amber-300 font-medium">
                      {game?.hostName || t("games.dots_and_boxes.host_default")}
                    </span>
                    <span className="text-3xl font-extrabold text-amber-400 tabular-nums">
                      {scores.host}
                    </span>
                  </div>
                  <span className="text-white/30 text-sm font-bold">{t("games.dots_and_boxes.versus")}</span>
                  <div
                    className={`flex flex-col items-center flex-1 rounded-lg px-3 py-2 transition-transform ${
                      currentTurn === "guest"
                        ? "bg-orange-500/15 border border-orange-400/40 scale-[1.02]"
                        : "bg-transparent"
                    }`}
                  >
                    <span className="text-xs text-orange-300 font-medium">
                      {game?.guestName || t("games.dots_and_boxes.guest_default")}
                    </span>
                    <span className="text-3xl font-extrabold text-orange-400 tabular-nums">
                      {scores.guest}
                    </span>
                  </div>
                </div>
              </div>
            )}

            <div className="mb-2 flex items-center justify-between gap-2 text-xs">
              <span className="text-white/50">{t("games.dots_and_boxes.host_label")}</span>
              <span className="font-semibold text-white">
                {game?.hostName || "—"}
              </span>
            </div>
            <div className="mb-2 flex items-center justify-between gap-2 text-xs">
              <span className="text-white/50">{t("games.dots_and_boxes.guest_label")}</span>
              <span className="font-semibold text-white">
                {game?.guestName || t("games.dots_and_boxes.guest_waiting")}
              </span>
            </div>

            {/* Report the opponent — available once a real human guest
                has joined (hidden while waiting / spectating). */}
            {canReport && (
              <button
                onClick={() => setShowReportModal(true)}
                className="mb-4 w-full py-2 rounded-lg border border-red-500/30 bg-red-500/10 text-xs font-bold text-red-400 transition-all hover:bg-red-500/20 hover:shadow-[0_0_12px_rgba(239,68,68,0.3)]"
              >
                <span className="inline-flex items-center gap-1"><IconFlag size={12} /> Report {opponentName}</span>
              </button>
            )}
            <div className="mb-4 flex items-center justify-between gap-2 text-xs">
              <span className="text-white/50">{t("games.dots_and_boxes.bet_field")}</span>
              <span className="font-mono font-semibold text-yellow-300">
                {t("games.dots_and_boxes.bet_each", {
                  amount: Number(game?.betAmount || 0).toFixed(2),
                })}
              </span>
            </div>

            {game?.remainingEdges !== undefined && !isFinished && (
              <div className="mb-4 flex items-center justify-between gap-2 text-xs">
                <span className="text-white/50">{t("games.dots_and_boxes.edges_left")}</span>
                <span className="font-mono font-semibold text-white">
                  {t("games.dots_and_boxes.edges_left_value", {
                    remaining: game.remainingEdges,
                  })}
                </span>
              </div>
            )}

            {/* End-game summary */}
            {isFinished && (
              <div className="mb-4 p-3 rounded-xl bg-white/5 border border-white/10">
                <div className="text-[10px] uppercase tracking-wider text-white/50 mb-1 text-center">
                  {t("games.dots_and_boxes.result_label")}
                </div>
                <div className="text-center text-sm font-semibold text-white">
                  {statusText}
                </div>
                {game?.payout !== null &&
                  game?.payout !== undefined &&
                  Number(game.payout) > 0 && (
                    <div className="text-center text-xs text-yellow-300 mt-1">
                      {t("games.dots_and_boxes.payout_label", {
                        amount: Number(game.payout).toFixed(2),
                      })}
                    </div>
                  )}
              </div>
            )}

            {/* Forfeit / Cancel — opens a real in-app confirmation modal */}
            {game?.status === "waiting" && game?.role === "host" ? (
              <button
                onClick={() => setShowForfeitConfirm(true)}
                className="w-full py-2 rounded-lg bg-red-600 hover:bg-red-500 font-bold hover-lift mb-2"
              >
                {t("games.dots_and_boxes.cancel_game_button")}
              </button>
            ) : game?.status === "in_progress" &&
              game?.role &&
              game.role !== "spectator" ? (
              <button
                onClick={() => setShowForfeitConfirm(true)}
                disabled={forfeiting}
                className="w-full py-2 rounded-lg bg-red-600 hover:bg-red-500 font-bold hover-lift mb-2 disabled:opacity-60"
              >
                {forfeiting
                  ? t("games.dots_and_boxes.forfeiting_button")
                  : t("games.dots_and_boxes.forfeit_button")}
              </button>
            ) : null}

            <button
              onClick={() => router.push("/casino/dots-and-boxes")}
              className={`w-full py-2 rounded-lg font-bold hover-lift ${
                isFinished
                  ? "bg-amber-600 hover:bg-amber-500"
                  : "bg-white/10 hover:bg-white/20"
              }`}
            >
              {isFinished ? t("games.dots_and_boxes.return_to_lobby") : t("games.dots_and_boxes.back_to_lobby")}
            </button>
          </div>
        </div>
      </div>

      {/* ─── Forfeit / Cancel confirmation modal ─────────────────── */}
      <AnimatePresence>
        {showForfeitConfirm && (
          <motion.div
            key="dnf-forfeit-confirm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={(e) => {
              // Backdrop dismiss: only close when the click hits the
              // backdrop itself (not bubbling from the panel) AND no
              // forfeit fetch is in flight, so we can't orphan loading state.
              if (e.target === e.currentTarget && !forfeiting) {
                setShowForfeitConfirm(false);
              }
            }}
            className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4"
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0, y: 10 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 6 }}
              transition={{ type: "spring", stiffness: 320, damping: 22 }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="dnf-forfeit-title"
              aria-describedby="dnf-forfeit-body"
              className="bg-[#031a37] border border-red-500/40 rounded-2xl p-6 max-w-sm w-full text-center shadow-[0_0_36px_rgba(239,68,68,0.35)]"
            >
              <div className="mb-3" aria-hidden><IconFlag size={44} className="text-red-400" /></div>
              <h3 id="dnf-forfeit-title" className="text-xl font-extrabold text-red-300 mb-2">
                {game?.status === "in_progress"
                  ? t("games.dots_and_boxes.forfeit_confirm_title")
                  : t("games.dots_and_boxes.cancel_confirm_title")}
              </h3>
              <p id="dnf-forfeit-body" className="text-white/70 mb-5">
                {game?.status === "in_progress"
                  ? t("games.dots_and_boxes.forfeit_confirm_body")
                  : t("games.dots_and_boxes.cancel_confirm")}
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowForfeitConfirm(false)}
                  disabled={forfeiting}
                  autoFocus
                  className="flex-1 px-4 py-2.5 rounded-lg bg-white/10 hover:bg-white/20 font-semibold transition disabled:opacity-50"
                >
                  {t("games.dots_and_boxes.stay_button")}
                </button>
                <button
                  onClick={cancelGame}
                  disabled={forfeiting}
                  className="flex-1 px-4 py-2.5 rounded-lg bg-red-600 hover:bg-red-500 font-bold transition disabled:opacity-60"
                >
                  {forfeiting
                    ? t("games.dots_and_boxes.forfeiting_button")
                    : game?.status === "in_progress"
                      ? t("games.dots_and_boxes.forfeit_button")
                      : t("games.dots_and_boxes.cancel_game_button")}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Result / Loss popup (win/loss/draw/cancelled) ─────────── */}
      <AnimatePresence>
        {showResultPopup && (
          <motion.div
            key="dnf-result-popup"
            {...gameOverModalAnim.backdrop}
            onClick={(e) => {
              // Backdrop dismiss: route user back to lobby when they
              // click outside the panel. Single universal action so
              // we don't leave them stuck behind a modal that won't
              // go away on mobile.
              if (e.target === e.currentTarget) {
                router.push("/casino/dots-and-boxes");
              }
            }}
            className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              {...gameOverModalAnim.panel}
              role="dialog"
              aria-modal="true"
              aria-labelledby="dnf-result-title"
              aria-describedby="dnf-result-body"
              className={`w-full max-w-md rounded-2xl border p-6 shadow-2xl text-center ${
                playerWon
                  ? "border-amber-400/40 bg-gradient-to-b from-[#0a2a1a] to-[#031a0a] shadow-[0_0_40px_rgba(250,204,21,0.25)]"
                  : isDraw
                    ? "border-white/20 bg-[#031a37]"
                    : isCancelled
                      ? "border-white/20 bg-[#031a37]"
                      : "border-red-500/40 bg-gradient-to-b from-[#2a0a0a] to-[#1a0303] shadow-[0_0_40px_rgba(239,68,68,0.25)]"
              }`}
            >
              <motion.div
                initial={{ scale: 0, rotate: -25 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{
                  type: "spring",
                  stiffness: 320,
                  damping: 14,
                  delay: 0.25,
                }}
                className="mb-2 text-6xl"
                aria-hidden
              >
                {isCancelled ? <IconDoorExit size={52} className="text-amber-300" /> : playerWon ? <IconTrophy size={52} className="text-amber-400" /> : isDraw ? <IconHeartHandshake size={52} className="text-yellow-300" /> : <IconBomb size={52} className="text-red-400" />}
              </motion.div>
              <motion.h3
                id="dnf-result-title"
                initial={{ y: 12, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.4, duration: 0.3 }}
                className={`text-2xl font-extrabold mb-2 ${
                  playerWon
                    ? "text-amber-300"
                    : isDraw
                      ? "text-yellow-200"
                      : "text-red-300"
                }`}
              >
                {isCancelled
                  ? t("games.dots_and_boxes.result_cancelled_title")
                  : playerWon
                    ? t("games.dots_and_boxes.result_win_title")
                    : isDraw
                      ? t("games.dots_and_boxes.result_draw_title")
                      : isForfeitLoss
                        ? t("games.dots_and_boxes.result_forfeit_title")
                        : t("games.dots_and_boxes.result_loss_title")}
              </motion.h3>
              <motion.p
                id="dnf-result-body"
                initial={{ y: 12, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.5, duration: 0.3 }}
                className="text-white/80 mb-2"
              >
                {isCancelled
                  ? t("games.dots_and_boxes.result_cancelled_body")
                  : playerWon
                    ? (scores?.host ?? 0) > (scores?.guest ?? 0)
                      ? `${scores?.host ?? 0} – ${scores?.guest ?? 0}`
                      : `${scores?.guest ?? 0} – ${scores?.host ?? 0}`
                    : isDraw
                      ? `${scores?.host ?? 0} – ${scores?.guest ?? 0}`
                      : (scores?.host ?? 0) > (scores?.guest ?? 0)
                        ? `${scores?.host ?? 0} – ${scores?.guest ?? 0}`
                        : `${scores?.guest ?? 0} – ${scores?.host ?? 0}`}
              </motion.p>
              {game?.payout !== null &&
                game?.payout !== undefined &&
                playerWon && (
                  <motion.p
                    initial={{ y: 12, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.6, duration: 0.3 }}
                    className="text-lg font-bold text-yellow-300 mb-3"
                  >
                    +{Number(game.payout).toFixed(2)}{" "}
                    {t("games.dots_and_boxes.tokens_suffix")}
                  </motion.p>
                )}
              <motion.div
                initial={{ y: 12, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.7, duration: 0.3 }}
                className="mt-4"
              >
                <button
                  onClick={() => router.push("/casino/dots-and-boxes")}
                  autoFocus
                  className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-[#08133a] font-extrabold transition shadow-[0_0_18px_rgba(245,158,11,0.45)]"
                >
                  {t("games.dots_and_boxes.return_to_lobby")}
                </button>
              </motion.div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Report modal */}
      <ReportModal
        isOpen={showReportModal}
        onClose={() => setShowReportModal(false)}
        onSubmit={async (reason, details) => {
          const res = await fetch("/api/reports/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reportedClerkId: opponentClerkId,
              gameType: "dots-and-boxes",
              gameId: String(gameId),
              reason,
              details: details || undefined,
            }),
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error || "Failed to submit report");
        }}
        reportedPlayerName={opponentName}
        gameType="Dots & Boxes"
      />
    </motion.div>
  );
}

// ─── Helpers (module-level) ────────────────────────────────────────────

/** Cheap deep-ish equality check for the gameplay fields we render
 *  from. Skips parent.setGame when polled state hasn't changed. */
function gameStateUnchanged(prev: any, next: any): boolean {
  if (prev === next) return true;
  if (!prev || !next) return false;
  if (prev.status !== next.status) return false;

  const a = prev.gameState || {};
  const b = next.gameState || {};

  if ((a.edges?.length ?? 0) !== (b.edges?.length ?? 0)) return false;
  if ((a.boxes?.length ?? 0) !== (b.boxes?.length ?? 0)) return false;
  if (a.currentTurn !== b.currentTurn) return false;
  if (a.scores?.host !== b.scores?.host) return false;
  if (a.scores?.guest !== b.scores?.guest) return false;
  if (prev.moveDeadlineAt !== next.moveDeadlineAt) return false;
  if (prev.result !== next.result) return false;
  if (prev.winnerClerkId !== next.winnerClerkId) return false;
  if (prev.payout !== next.payout) return false;

  // Edge-level content equality (cheap when lengths already match).
  const ae = a.edges as string[] | undefined;
  const be = b.edges as string[] | undefined;
  if (ae && be) {
    const aeSorted = ae.slice().sort();
    const beSorted = be.slice().sort();
    for (let i = 0; i < aeSorted.length; i++) {
      if (aeSorted[i] !== beSorted[i]) return false;
    }
  }

  // Box owners
  const aBo = (a.boxOwners as Record<string, string> | undefined) || {};
  const bBo = (b.boxOwners as Record<string, string> | undefined) || {};
  const aKeys = Object.keys(aBo);
  const bKeys = Object.keys(bBo);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (aBo[k] !== bBo[k]) return false;
  }

  return true;
}

function computeStatusText(gameData: any, t: (key: string, params?: any) => string): string {
  if (gameData.status === "waiting") {
    return t("games.dots_and_boxes.status_waiting");
  }
  if (gameData.status === "cancelled") {
    return t("games.dots_and_boxes.status_cancelled");
  }
  if (gameData.status === "in_progress") {
    const gs = gameData.gameState;
    if (gameData.role === gs?.currentTurn) {
      return t("games.dots_and_boxes.status_your_turn");
    }
    if (gameData.remainingSeconds === 0) {
      return t("games.dots_and_boxes.status_opp_timeout");
    }
    return t("games.dots_and_boxes.status_opp_turn");
  }
  if (gameData.status === "finished") {
    if (gameData.result === "draw") return t("games.dots_and_boxes.status_result_draw");
    const won =
      gameData.winnerClerkId &&
      ((gameData.role === "host" &&
        gameData.winnerClerkId === gameData.hostClerkId) ||
        (gameData.role === "guest" &&
          gameData.winnerClerkId === gameData.guestClerkId));
    return won ? t("games.dots_and_boxes.status_result_win") : t("games.dots_and_boxes.status_result_loss");
  }
  return "";
}

// ── Helpers (module-level) ─────────────────────────────────────────────

/** True when the local player is the loser of a finished match. */
function isResultLoss(game: any): boolean {
  if (!game || game.status !== "finished") return false;
  if (game.result === "draw") return false;
  if (!game.winnerClerkId) return false;
  // Loss = somebody else won.
  return (
    (game.role === "host" && game.winnerClerkId !== game.hostClerkId) ||
    (game.role === "guest" && game.winnerClerkId !== game.guestClerkId)
  );
}
