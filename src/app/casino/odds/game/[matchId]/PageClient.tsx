"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { usePostHog } from "posthog-js/react";
import NavigationBar from "../../../../../components/navigation-bar";
import { useRecordPlayedGame } from "../../../../../hooks/useRecordPlayedGame";
import useActiveGamePresence from "../../../../../hooks/useActiveGamePresence";
import ReportModal from "../../../../../components/ReportModal";
import PvpResultScreen from "../../../../../components/result/PvpResultScreen";
import {
  PracticePauseChip,
  PracticePauseOverlay,
} from "../../../../../components/game/PracticePause";
import { usePracticePause } from "../../../../../hooks/usePracticePause";
import EmotePicker from "../../../../../components/game/EmotePicker";
import useGameEmotes from "../../../../../hooks/useGameEmotes";
import { useSocket } from "../../../../../context/SocketProvider";
import PredictionPanel from "../../../../../components/odds/PredictionPanel";
import TargetReveal from "../../../../../components/odds/TargetReveal";
import AnimatedScore from "../../../../../components/odds/AnimatedScore";
import { CLUE_SECONDS, motionSeconds } from "../../../../../components/odds/oddsMotion";
import { useReducedMotionSafe } from "../../../../../components/odds/useReducedMotionSafe";
import { useOddsAudio } from "../../../../../lib/oddsAudio";
import { SkeletonRows } from "../../../../../components/skeletons/Skeleton";
import {
  IconArrowLeft,
  IconDice,
  IconSwords,
  IconTarget,
  IconCrystalBall,
  IconVolume,
  IconVolumeOff,
  IconFlag,
  IconHourglass,
  IconRefresh,
  IconMoodAngry,
  IconHeartHandshake,
  IconClock,
  IconAlarm,
  IconRobot,
  IconAlertTriangle,
} from "@tabler/icons-react";
import {
  isAiDifficulty,
  readStoredAiDifficulty,
  type AiDifficulty,
} from "../../../../../lib/aiDifficulty";
import { startMatchSync } from "../../../../../hooks/useMatchSync";
import {
  ROUND_TIMEOUT_MS,
  TARGET_MAX,
  TARGET_MIN,
  describePrediction,
  type OddsPlayerView,
  type OddsPrediction,
  type OddsRoundView,
} from "../../../../../lib/odds";

/** A round as the CLIENT may see it: the target is null until it resolves. */
type GameRound = OddsRoundView;

type GameState = {
  rounds: GameRound[];
  currentRound: number;
  totalRounds: number;
  winner: string; // "player1" | "player2" | "" (draw)
  result: string;
  payout: number;
  p1Score: number;
  p2Score: number;
};

/**
 * The per-viewer state the server hands out (`viewForPlayer`). Both entry
 * points store THIS shape — never the raw engine state, which carries the live
 * round's target.
 */
type BoardState = OddsPlayerView;

/** A random legal call, used by autopick and by a timed-out PvP round. */
function randomPrediction(): OddsPrediction {
  return {
    kind: "exact",
    value: TARGET_MIN + Math.floor(Math.random() * (TARGET_MAX - TARGET_MIN + 1)),
  };
}

// The lobby's own tokens (amber + cyan on the dark purple-to-navy gradient),
// reused for the two cards this page still owns: the waiting-for-opponent card
// and the "that link names no game" card. The board keeps its own HUD look.
const LOBBY_CARD =
  "rounded-2xl border border-amber-700/60 bg-black/40 shadow-[0_0_30px_rgba(251,191,36,0.12)] backdrop-blur-xl";
const LOBBY_TITLE =
  "text-transparent bg-clip-text bg-gradient-to-r from-amber-300 via-amber-400 to-yellow-500 drop-shadow-[0_0_18px_rgba(251,191,36,0.5)]";
const LOBBY_PLAY =
  "border-amber-700 bg-amber-500 text-black hover:brightness-110 shadow-[0_0_25px_rgba(251,191,36,0.4)]";

/**
 * Odds MATCH page — the board for ONE game.
 *
 * The LOBBY lives at /casino/odds (stake picker, open tables, vs-AI), exactly
 * like Hex Duel's split: this route plays the game its URL names and nothing
 * else. It never opens a table, never joins one and never lists one.
 *
 *   /casino/odds/game/<id>   a staked PvP duel (the host waits here)
 *   /casino/odds/game/ai     free practice against the bot
 *
 * Nothing here decides a result: every pick is resolved server-side and the
 * board renders the sanitized per-viewer state the server returns.
 */
export default function OddsGamePage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const rawParam = Array.isArray(params?.matchId) ? params.matchId[0] : params?.matchId;
  const matchIdParam = String(rawParam ?? "");
  const isPractice = matchIdParam === "ai";
  const numericId = Number(matchIdParam);
  const matchId = Number.isInteger(numericId) && numericId > 0 ? numericId : null;

  // The practice tier travels in the URL (the lobby stores the player's choice
  // per device). A missing or garbled value falls back to that stored tier.
  const difficulty = useMemo<AiDifficulty>(() => {
    const fromQuery = searchParams?.get("difficulty");
    return isAiDifficulty(fromQuery) ? fromQuery : readStoredAiDifficulty("odds");
  }, [searchParams]);

  const audio = useOddsAudio();

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-b from-[#0a0118] to-[#061b3d] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto mt-4 max-w-5xl sm:mt-8">
        <MatchHeader isPractice={isPractice} matchId={matchId} />
        {isPractice ? (
          <AIOddsGame audio={audio} difficulty={difficulty} />
        ) : matchId ? (
          <PvPOddsGame audio={audio} matchId={matchId} />
        ) : (
          <InvalidMatch />
        )}
      </div>
    </div>
  );
}

/** Back-to-lobby link + the game the route names. */
function MatchHeader({
  isPractice,
  matchId,
}: {
  isPractice: boolean;
  matchId: number | null;
}) {
  const router = useRouter();
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <button
        type="button"
        onClick={() => router.push("/casino/odds")}
        className="inline-flex items-center gap-1.5 rounded-xl border border-white/15 bg-black/30 px-3 py-1.5 text-xs font-bold text-white/60 transition hover:border-amber-400/50 hover:text-amber-200"
      >
        <IconArrowLeft size={14} /> Lobby
      </button>
      <h1 className="flex items-baseline gap-2 text-xl font-extrabold tracking-wide sm:text-2xl">
        <IconDice size={22} className="translate-y-0.5 text-amber-300" />
        <span className={LOBBY_TITLE}>Odds</span>
        <span className="text-xs font-bold uppercase tracking-widest text-white/40">
          {isPractice ? "practice" : matchId ? `match #${matchId}` : ""}
        </span>
      </h1>
    </div>
  );
}

/** A URL that names no game (a truncated link, a typo). */
function InvalidMatch() {
  const router = useRouter();
  return (
    <div className={`${LOBBY_CARD} p-8 text-center`}>
      <p className="text-lg font-bold text-amber-300">That link doesn&apos;t name a game.</p>
      <p className="mt-2 text-sm text-white/50">
        Open the Odds lobby and start a duel from there.
      </p>
      <button
        type="button"
        onClick={() => router.push("/casino/odds")}
        className={`odds-chamfer mt-5 inline-flex items-center gap-2 px-6 py-2.5 text-sm font-extrabold ${LOBBY_PLAY}`}
      >
        <IconArrowLeft size={15} /> Back to the lobby
      </button>
    </div>
  );
}

// ─── AI Mode (Interactive) ─────────────────────────────────────────────────
function AIOddsGame({
  audio,
  difficulty,
}: {
  audio: ReturnType<typeof useOddsAudio>;
  difficulty: AiDifficulty;
}) {
  // The result popup's practice-only lobby exit (a live PvP match never
  // passes one): AIOddsGame is its own route, so it navigates itself.
  const router = useRouter();
  // Every odds animation below is decoration around server state; with
  // reduced motion each one collapses to its settled frame.
  const reduce = useReducedMotionSafe();

  // The vs-AI match is FREE PLAY: there is no stake to track and none is sent
  // to /api/odds/ai/start (see startGame below), so the HUD, the result screen
  // and analytics all report a 0 stake instead of the player's saved default
  // wager — which used to be persisted and displayed as a real stake even
  // though no token was ever risked. The PvP game (PvPOddsGame) keeps the
  // shared default-wager control.
  const [loading, setLoading] = useState(false);
  const [gameId, setGameId] = useState<number | null>(null);
  const [interactiveState, setInteractiveState] = useState<BoardState | null>(null);
  const posthog = usePostHog();
  const [roundHistory, setRoundHistory] = useState<GameRound[]>([]);
  // The call the player has built in the panel — the single source of truth
  // for the wheel, the inputs, the preset and the preview.
  const [prediction, setPrediction] = useState<OddsPrediction | null>(null);
  const [autoPick, setAutoPick] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [gameOver, setGameOver] = useState(false);
  const [finalWinner, setFinalWinner] = useState<"player1" | "player2" | "">("player1");
  const [finalResult, setFinalResult] = useState<"player1_won" | "player2_won" | "draw">("player1_won");
  const [finalPayout, setFinalPayout] = useState(0);
  const [resuming, setResuming] = useState(true);
  // The tier the bot plays at for this session. The LOBBY picks it (and stores
  // it per device); this route only receives it.
  const aiDifficulty = difficulty;

  const gameActive = Boolean(gameId && interactiveState);
  // The vs-AI duel is a client-side practice session: pause freezes the board
  // locally (the bot only answers a submitted pick, so nothing runs behind the
  // overlay). The row is abandoned on navigation exactly as before.
  const practicePause = usePracticePause({
    game: "odds",
    matchId: gameId ?? "local",
    enabled: gameActive && !gameOver,
    local: true,
  });
  const paused = practicePause.paused;
  const pausedRef = practicePause.pausedRef;
  // Record the session into "Recently played" (and the lobby's "Most
  // Played" counter) when the real game starts.
  useRecordPlayedGame("odds", gameActive);
  // Active-player presence (lobby "N playing"): an AI duel counts exactly
  // like a PvP one — the player is in a real game either way — and stops the
  // moment the duel is decided.
  useActiveGamePresence("odds", gameActive && !gameOver, { terminal: gameOver });

  // Wrap handlePick in a ref so timer/autopick effects can call it without stale closures
  const submitActionRef = useRef<(prediction: OddsPrediction) => void>(() => {});
  const mountedRef = useRef(true);
  const autoPickTriggeredRef = useRef(false);
  const gameOverRef = useRef(false);
  gameOverRef.current = gameOver;
  // The active duel id, read by the leave path without a stale closure.
  const gameIdRef = useRef<number | null>(null);
  gameIdRef.current = gameId;
  // Guards against a double leave (unload beacon + unmount cleanup).
  const leftActiveGameRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Connection logic: leaving the page stops the AI duel ───────────────
  // A vs-AI duel is tied to the open page. Navigating away, logging out, a
  // refresh or a closed tab all end it: the beacon fires on the unload
  // events (best effort — `sendBeacon` outlives the page) and the unmount
  // cleanup covers in-app navigation, so the row can never stay "playing"
  // and be resumed later. A finished duel is left untouched — it was
  // already closed out by the pick route.
  const leaveActiveGame = useCallback((beacon: boolean) => {
    const id = gameIdRef.current;
    if (!id || gameOverRef.current || leftActiveGameRef.current) return;
    leftActiveGameRef.current = true;
    const payload = JSON.stringify({ gameId: id });
    try {
      if (beacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
        navigator.sendBeacon(
          "/api/odds/ai/leave",
          new Blob([payload], { type: "application/json" }),
        );
        return;
      }
      fetch("/api/odds/ai/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        keepalive: true,
        body: payload,
      }).catch(() => {});
    } catch {
      // Leaving is best-effort: a failed beacon must never block the
      // navigation. The mount-time abandon below is the backstop.
    }
  }, []);

  useEffect(() => {
    const onLeave = () => leaveActiveGame(true);
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onLeave);
      leaveActiveGame(false);
    };
  }, [leaveActiveGame]);

  // On mount: a vs-AI duel only lives while the page is open. Any duel that
  // survived a lost connection is abandoned here, so returning to Odds never
  // drops the player onto a stale board — the create-game lobby and its
  // buttons show again.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/odds/ai/status");
        const data = await res.json();
        if (cancelled || !data.success || !data.data.active) return;
        // A duel is still marked playing: the player left (or lost their
        // connection) before it ended. Abandon it — nothing to settle — and
        // fall through to the lobby.
        await fetch("/api/odds/ai/leave", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          keepalive: true,
          body: JSON.stringify({}),
        });
      } catch {} finally {
        if (!cancelled) setResuming(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startGame = async () => {
    setLoading(true);
    setError("");
    setGameId(null);
    setInteractiveState(null);
    setRoundHistory([]);
    setPrediction(null);
    setGameOver(false);
    setFinalPayout(0);

    try {
      const res = await fetch("/api/odds/ai/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wager: 0, difficulty: aiDifficulty }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to start game");
      setGameId(data.data.gameId);
      setInteractiveState(data.data.gameState);
      posthog?.capture("odds_game_started", {
        mode: "ai",
        wager: 0,
        difficulty: aiDifficulty,
        game_id: data.data.gameId,
      });
    } catch (err: any) {
      setError(err.message || "Error starting game");
    } finally {
      setLoading(false);
    }
  };

  // The AI route OWNS its session: the lobby's "Play vs AI" is the click, so
  // arriving here starts the practice duel immediately. `startedRef` stops a
  // re-render (or Strict Mode's double mount) from minting a second game.
  const startedRef = useRef(false);
  useEffect(() => {
    if (resuming || gameId || loading || startedRef.current) return;
    startedRef.current = true;
    void startGame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resuming, gameId, loading]);

  const submitAction = useCallback(
    async (prediction: OddsPrediction) => {
      if (!gameId || !interactiveState || isSubmitting || gameOver) return;
      if (pausedRef.current) return;
      autoPickTriggeredRef.current = true; // prevent double-trigger
      setIsSubmitting(true);
      setError("");
      audio.playPick();
      try {
        const res = await fetch("/api/odds/ai/pick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gameId, prediction }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        if (!mountedRef.current) return;

        // The server scores my call against the round's secret target and
        // hands back the SANITIZED view. The bot only answers once I submit,
        // so a single request always closes the round.
        const updatedState = data.data.updatedState as BoardState;
        setInteractiveState(updatedState);
        // Only RESOLVED rounds are history; the live one is still on the board.
        setRoundHistory(updatedState.rounds.filter((round) => round.resolved));

        if (data.data.gameStatus === "finished") {
        const winner: "player1" | "player2" | "" = updatedState.winner ?? "";
        const isPlayer1Win = winner === "player1";
        const drew = winner === "";

        // Block further picks immediately
        setGameOver(true);
        gameOverRef.current = true;
        autoPickTriggeredRef.current = true;

        setFinalWinner(winner);
        setFinalResult(isPlayer1Win ? "player1_won" : drew ? "draw" : "player2_won");
        setFinalPayout(data.data.payout || 0);
        posthog?.capture("odds_game_ended", { result: isPlayer1Win ? "win" : drew ? "draw" : "loss", mode: "ai", wager: 0, payout: data.data.payout || 0 });

        if (isPlayer1Win) {
          setTimeout(() => {
            if (mountedRef.current) {
              audio.playVictory();
            }
          }, 400);
        } else if (!drew) {
          setTimeout(() => {
            if (mountedRef.current) {
              audio.playDefeat();
            }
          }, 200);
        }
      }
    } catch (err: any) {
      if (mountedRef.current) setError(err.message);
    } finally {
      // Always reset timer and pick state, even on failure, to avoid infinite loops.
      // Use gameOverRef to avoid stale closure — gameOver state may have been
      // set to true during this handler (game ended), but the closure still sees
      // the old value from when this useCallback was created.
      if (mountedRef.current) {
        setIsSubmitting(false);
        if (!gameOverRef.current) {
          setPrediction(null);
          autoPickTriggeredRef.current = false;
        }
      }
    }
    },
    [gameId, interactiveState, isSubmitting, gameOver, pausedRef],
  );

  // Keep ref in sync
  useEffect(() => {
    submitActionRef.current = submitAction;
  }, [submitAction]);

  // Autopick: fire a random legal call shortly after a new round opens. Vs-AI
  // play is untimed, so this is a convenience, never a timeout.
  useEffect(() => {
    if (!interactiveState || gameOver || isSubmitting || paused) return;
    if (!autoPick) return;
    if (autoPickTriggeredRef.current) return;
    autoPickTriggeredRef.current = true;
    const t = setTimeout(() => {
      submitActionRef.current(randomPrediction());
    }, 600);
    return () => clearTimeout(t);
  }, [interactiveState, autoPick, gameOver, isSubmitting, paused]);

  const handleSubmitGuess = () => {
    if (!interactiveState || isSubmitting || gameOver) return;
    if (!prediction) return;
    submitAction(prediction);
  };

  // Build a synthetic GameState for the display component
  const displayGameState: GameState | null = useMemo(() => {
    if (!interactiveState) return null;
    return {
      rounds: roundHistory,
      currentRound: interactiveState.currentRound,
      totalRounds: interactiveState.totalRounds,
      winner: gameOver ? finalWinner : "",
      result: gameOver ? finalResult : "player1_won",
      // Free play: there is no stake, so there is no pending payout to show
      // mid-game. At game over this is the server's recorded payout (0 for
      // AI), never a phantom `wager * 2`.
      payout: gameOver ? finalPayout : 0,
      p1Score: interactiveState.p1Score,
      p2Score: interactiveState.p2Score,
    };
  }, [interactiveState, roundHistory, gameOver, finalWinner, finalResult, finalPayout]);

  const handlePlayAgain = () => {
    setGameId(null);
    setInteractiveState(null);
    setRoundHistory([]);
    setPrediction(null);
    setGameOver(false);
    setFinalPayout(0);
    setError("");
    // Let the auto-start effect mint the next duel (this route owns no lobby
    // card to return to).
    startedRef.current = false;
  };

  const liveRound = interactiveState
    ? interactiveState.rounds[interactiveState.currentRound - 1]
    : null;
  const userWon = gameOver && finalWinner === "player1";
  const userDrew = gameOver && finalWinner === "";
  return (
    <div>
      {practicePause.canPause && (
        <div className="mb-3 flex justify-end">
          <PracticePauseChip
            paused={paused}
            busy={practicePause.busy}
            onToggle={() => void practicePause.toggle()}
            testId="odds-pause"
          />
        </div>
      )}
      {resuming && (
        // Branded skeleton instead of a bare "Loading..." line.
        <SkeletonRows rows={3} className="mx-auto max-w-md py-4" label="Loading game" />
      )}

      {/* The route mints its own practice session on arrival, so there is no
          lobby card here — only a failure to retry. */}
      {!resuming && !gameId && error && (
        <div className={`${LOBBY_CARD} p-6 text-center`}>
          <div className="flex items-center justify-center gap-2 text-sm text-red-200">
            <IconAlertTriangle size={16} className="shrink-0 text-red-300" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setError("");
              startedRef.current = false;
              void startGame();
            }}
            className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-bold text-amber-200 transition hover:bg-amber-500/20"
          >
            Try again
          </button>
        </div>
      )}

      {gameId && interactiveState && (
      <>
      {/* THE BOARD. On desktop the readout column (score + log) sits beside the
          input column instead of above it, which is what keeps the whole game
          on one screen; on mobile the input keeps the top slot (order-1) so the
          thing you came to do is never below the reference log. */}
      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="order-1 space-y-3 lg:order-2">
      {gameId && interactiveState && !gameOver && !interactiveState.mySubmitted && (
        <motion.div
          key={`call-${interactiveState.currentRound}`}
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: motionSeconds(reduce, 0.24), ease: "easeOut" }}
          className="odds-hud odds-chamfer odds-hud--amber overflow-hidden"
        >
          <div className="flex items-center justify-between gap-2 border-b border-[#f5ff3b]/20 bg-black/35 px-3 py-2">
            <span className="odds-label flex items-center gap-2 text-[#f5ff3b]">
              <IconCrystalBall size={12} /> call the number
            </span>
            <span className="odds-label text-white/35">
              round {interactiveState.currentRound}/{interactiveState.totalRounds}
            </span>
          </div>

          <div className="odds-board-bg p-3 sm:p-4">
            <p className="odds-label mt-3 text-white/35">the clue · same for both seats</p>
            <ClueReveal clue={liveRound?.clue} round={interactiveState.currentRound} />
            <p className="odds-label mt-3 text-white/45">
              one call · a number, or a range like 40-50 · narrower pays more
            </p>

            <PickHistoryStrip
              rounds={roundHistory}
              isPlayer1={true}
              userLabel="You"
              oppLabel="AI"
              className="mt-3"
            />

            {/* Vs-AI mode is untimed — there is no countdown to run out. */}

            {/* One submission per round: pick it on the wheel, type it, or
                take a preset — every surface writes the same call. */}
            <PredictionPanel
              className="mt-3"
              clue={liveRound?.clue ?? null}
              value={prediction}
              onChange={setPrediction}
              onSubmit={handleSubmitGuess}
              disabled={isSubmitting || autoPick}
            />
            <button
              onClick={handleSubmitGuess}
              disabled={isSubmitting || autoPick || prediction === null}
              className="odds-chamfer odds-label mt-2 w-full bg-[#f5ff3b] px-6 py-3.5 text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {isSubmitting ? "locking in…" : "lock in"}
            </button>

            {/* Sound + Autopick toggles */}
            <div className="mt-3 flex items-center justify-center gap-4 border-t border-white/5 pt-3">
              <button
                onClick={() => audio.setEnabled(!audio.enabled)}
                className={`rounded-full border px-3 py-1 text-sm transition ${
                  audio.enabled
                    ? "border-white/10 text-white/60 hover:text-white"
                    : "border-red-400/40 text-red-400/60"
                }`}
                title={audio.enabled ? "Sounds on" : "Sounds off"}
              >
                {audio.enabled ? <IconVolume size={16} /> : <IconVolumeOff size={16} />}
              </button>
              <label className="flex cursor-pointer select-none items-center gap-2">
                <div
                  className={`relative h-6 w-12 rounded-full transition-colors ${
                    autoPick ? "bg-[#f5ff3b]" : "bg-white/20"
                  }`}
                  onClick={() => {
                    setAutoPick(!autoPick);
                    if (!autoPick) {
                      // Turning autopick ON: clear any half-built call
                      setPrediction(null);
                    }
                  }}
                >
                  <div
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                      autoPick ? "translate-x-6" : "translate-x-0.5"
                    }`}
                  />
                </div>
                <span className="odds-label text-white/55">autopick</span>
              </label>
            </div>

            {error && (
              <p className="odds-label mt-3 text-center text-red-400">{error}</p>
            )}
          </div>
        </motion.div>
      )}


      </div>

      {/* Readout column: score strip, surviving range, round log */}
      <div className="order-2 space-y-3 lg:order-1">
        {displayGameState && (
          <OddsGameDisplay
            gameState={displayGameState}
            revealedRounds={roundHistory.length}
            gameOver={gameOver}
            userWon={userWon}
            userDrew={userDrew}
            isPlayer1={true}
            userLabel="You"
            oppLabel="AI"
            onPlayAgain={handlePlayAgain}
            onReturnToLobby={() => router.push("/casino/odds")}
          />
        )}
      </div>
      </div>

      {/* Game over with no rounds (should be very rare) */}
      {gameOver && roundHistory.length === 0 && (
        <div className="odds-hud odds-chamfer odds-board-bg p-4 text-center">
          <p className="odds-label text-white/40">game ended unexpectedly</p>
          <button
            onClick={handlePlayAgain}
            className="odds-chamfer odds-label mt-3 w-full bg-[#f5ff3b] px-6 py-3.5 text-black transition hover:brightness-110"
          >
            run it back
          </button>
        </div>
      )}
      </>
      )}

      <PracticePauseOverlay
        paused={paused}
        busy={practicePause.busy}
        onResume={() => void practicePause.toggle()}
        testId="odds-pause-overlay"
      />
    </div>
  );
}

// ─── PvP Mode (Interactive) ───────────────────────────────────────────────
function PvPOddsGame({ audio, matchId }: { audio: ReturnType<typeof useOddsAudio>; matchId: number }) {
  const PICK_TIMER_SECONDS = 15;
  const router = useRouter();
  const { socket } = useSocket();
  const reduce = useReducedMotionSafe();

  // ── Match state ──
  // The game id is the ROUTE's. Opening, joining and browsing tables is the
  // lobby's job (`/casino/odds`), so this page never creates or joins one: it
  // reads the duel the URL names and plays it.
  const myGameId = matchId;
  // loading → the first read is in flight; waiting → the host's seat is still
  // open; playing → both seats are in; missing → not your table (or gone).
  const [matchStage, setMatchStage] = useState<
    "loading" | "waiting" | "playing" | "missing"
  >(
    "loading",
  );
  const [missingText, setMissingText] = useState("");
  // True when the card is a transport failure (retryable) rather than the
  // server saying this match is not yours.
  const [retryable, setRetryable] = useState(false);
  // The stake is the server's (it escrowed it), never a local guess.
  const [wagerLocked, setWagerLocked] = useState<number | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [opponentId, setOpponentId] = useState<string | null>(null);
  // Seat identity — real username + official Grynd icon + equipped name
  // color, resolved server-side (getSeatIdentity in the pvp/status route).
  const [myName, setMyName] = useState("You");
  const [myIconKey, setMyIconKey] = useState<string | null>(null);
  const [myProfileFrame, setMyProfileFrame] = useState<unknown>(null);
  const [myNameColor, setMyNameColor] = useState<string | null>(null);
  const [opponentName, setOpponentName] = useState("Opponent");
  const [opponentIconKey, setOpponentIconKey] = useState<string | null>(null);
  const [opponentProfileFrame, setOpponentProfileFrame] = useState<unknown>(null);
  const [opponentNameColor, setOpponentNameColor] = useState<string | null>(null);
  const [isPlayer1, setIsPlayer1] = useState(true);

  // ── Game state ──
  const [interactiveState, setInteractiveState] = useState<BoardState | null>(null);
  const [roundHistory, setRoundHistory] = useState<GameRound[]>([]);
  // The call built in the panel — the single source of truth for every
  // selector surface (wheel, inputs, preset, preview).
  const [prediction, setPrediction] = useState<OddsPrediction | null>(null);
  const [timeLeft, setTimeLeft] = useState(PICK_TIMER_SECONDS);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [waitingForOpponent, setWaitingForOpponent] = useState(false);
  const [error, setError] = useState("");
  const [timeUp, setTimeUp] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [finalWinner, setFinalWinner] = useState<"player1" | "player2" | "">("player1");
  const [finalResult, setFinalResult] = useState<"player1_won" | "player2_won" | "draw">("player1_won");
  const [finalPayout, setFinalPayout] = useState(0);
  const [showReportModal, setShowReportModal] = useState(false);
  const [showForfeitConfirm, setShowForfeitConfirm] = useState(false);

  // Emotes — dedicated per-match room (mirrors the other PvP games).
  const { incomingEmote, myEmote, sendEmote } = useGameEmotes({
    socket,
    roomId: myGameId != null ? `odds:emote:${myGameId}` : null,
    eventName: "odds:emote",
    selfId: userId,
  });
  const [forfeiting, setForfeiting] = useState(false);

  const matchLive = Boolean(
    myGameId && interactiveState && !waitingForOpponent && !gameOver,
  );
  // Record the session into "Recently played" (and the lobby's "Most
  // Played" counter) once the match is actually live.
  useRecordPlayedGame("odds", matchLive);
  // Active-player presence (lobby "N playing"): only while the match is
  // actually live (waiting for an opponent is not playing yet), cleared as
  // soon as the duel is decided.
  useActiveGamePresence("odds", matchLive, { terminal: gameOver });

  // Refs for timer/autopick
  const submitActionRef = useRef<(prediction: OddsPrediction) => void>(() => {});
  const mountedRef = useRef(true);
  const gameOverRef = useRef(false);
  const isPlayer1Ref = useRef(true);
  const wagerLockedRef = useRef<number | null>(null);
  gameOverRef.current = gameOver;
  isPlayer1Ref.current = isPlayer1;
  wagerLockedRef.current = wagerLocked;
  // Track round count so a NEW ROUND clears the input, while a poll/socket
  // push of the same round leaves what the player is typing alone.
  const roundCountRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Apply the server's sanitized per-viewer state to the board.
  const applyStateFromServer = useCallback(
    (serverData: any) => {
      if (!mountedRef.current) return;
      const st = serverData.gameState as OddsPlayerView | null;
      if (!st) return;

      const myIsPlayer1 = isPlayer1Ref.current;

      setInteractiveState(st);
      // Only RESOLVED rounds are history — the live round still carries a
      // withheld target, so it must not be counted as revealed.
      setRoundHistory((st.rounds ?? []).filter((round) => round.resolved));
      // A live state means both seats are in: the waiting screen is done.
      setMatchStage((current) => (current === "missing" ? current : "playing"));

      // Waiting = I've locked in for this round and the opponent hasn't.
      // The server sanitizes each player's view, so the peer's pending call is
      // never in here — only the `mySubmitted` / `opponentSubmitted` flags.
      setWaitingForOpponent(
        !st.gameOver && st.mySubmitted && !st.opponentSubmitted,
      );

      // Reset the round clock only on a NEW ROUND — NOT on every poll,
      // otherwise the countdown would never actually elapse (pushes arrive
      // every few seconds) and the timeout could never fire.
      const newRoundCount = st.currentRound;
      if (newRoundCount !== roundCountRef.current) {
        roundCountRef.current = newRoundCount;
        setPrediction(null);
        setTimeLeft(PICK_TIMER_SECONDS);
        setTimeUp(false);
      }

      if (st.gameOver) {
        setGameOver(true);
        gameOverRef.current = true;
        setFinalWinner(st.winner ?? "");
        setFinalResult(
          st.winner === "player1"
            ? "player1_won"
            : st.winner === "player2"
              ? "player2_won"
              : "draw",
        );
        setFinalPayout(serverData.payout ?? serverData.wager * 2);
        const iWon =
          (myIsPlayer1 && st.winner === "player1") ||
          (!myIsPlayer1 && st.winner === "player2");
        const drew = st.winner === null;
        if (iWon) {
          setTimeout(() => audio.playVictory(), 200);
        } else if (!drew) {
          audio.playDefeat();
        }
      }
    },
    [],
  );

  /**
   * ONE authoritative read of THIS match (`?gameId=`), used on mount, on the
   * per-match socket push, on a reconnect and when the tab comes back. It
   * carries the seat identities and the sanitized view in a single response,
   * so a waiting host and a playing duel share the same loader.
   */
  const loadMatch = useCallback(async () => {
    try {
      const res = await fetch(`/api/odds/pvp/status?gameId=${matchId}`, {
        cache: "no-store",
        credentials: "include",
      });
      const data = await res.json().catch(() => null);
      if (!mountedRef.current) return;
      if (!res.ok || !data?.success || !data?.data?.active) {
        // The server answered, and the answer is "not yours" / "gone": that IS
        // the verdict, so no retry is offered for it.
        setRetryable(false);
        setMissingText(data?.error || "This match isn't available to you.");
        setMatchStage("missing");
        return;
      }
      setRetryable(false);

      const d = data.data;
      isPlayer1Ref.current = Boolean(d.isPlayer1);
      setIsPlayer1(Boolean(d.isPlayer1));
      setWagerLocked(Number(d.wager) || 0);
      setOpponentId(d.opponentId ?? null);
      setMyName(d.myName || "You");
      setMyIconKey(d.myIconKey || null);
      setMyNameColor(d.myNameColor || null);
      setMyProfileFrame(d.myProfileFrame || null);
      setOpponentName(d.opponentName || "Opponent");
      setOpponentIconKey(d.opponentIconKey || null);
      setOpponentNameColor(d.opponentNameColor || null);
      setOpponentProfileFrame(d.opponentProfileFrame || null);

      if (!d.gameState) {
        // The second seat is still open — the host waits here until it fills.
        setMatchStage("waiting");
        return;
      }
      applyStateFromServer({
        gameState: d.gameState,
        payout: d.payout,
        wager: d.wager,
      });
    } catch {
      if (!mountedRef.current) return;
      // A dropped request says nothing about the match. A board that is already
      // on screen keeps playing; otherwise the player gets a retry rather than
      // a "not found" verdict for a network blip.
      setRetryable(true);
      setMissingText("Couldn't reach the server. Check your connection and try again.");
      setMatchStage((current) => (current === "playing" ? current : "missing"));
    }
  }, [applyStateFromServer, matchId]);

  // The initial read.
  useEffect(() => {
    void loadMatch();
  }, [loadMatch]);

  // ── Lobby: who am I? (emote self-id + the report target) ──
  useEffect(() => {
    const getUser = async () => {
      // A non-JSON error response must not throw out of the mount effect —
      // `res.json()` on an HTML error page rejects and React reports it as an
      // uncaught error. Parse defensively and leave the user id unset.
      const res = await fetch("/api/get-user");
      const json = await res.json().catch(() => null);
      if (json?.success) setUserId(json.data?.userId ?? null);
    };
    void getUser();
  }, []);

  // ── Realtime: the per-match room + the lobby room ──
  //
  // The per-match room carries "the opponent did something" pings; the lobby
  // room carries the JOIN (the joiner's client announces it there), which is
  // what turns the waiting card into a live board without a poll. Every event
  // is only a signal — the authoritative read above does the work.
  useEffect(() => {
    if (!socket) return undefined;
    const roomId = `odds_${myGameId}`;
    const lobbyRoom = "lobby:odds";

    const join = () => {
      socket.emit("join_room", { roomId });
      socket.emit("join_room", { roomId: lobbyRoom });
    };

    join();
    socket.on("connect", join);
    socket.on("reconnect", join);

    // The relayed payload travels through the other browser and must not be
    // trusted — never apply it directly. Treat every event as a "state
    // changed" ping and refetch the authoritative, per-viewer state.
    const handleGameUpdate = () => {
      if (!mountedRef.current) return;
      void loadMatch();
    };
    socket.on("odds:game_update", handleGameUpdate);
    socket.on("odds:state_changed", handleGameUpdate);
    socket.on("lobby:updated", handleGameUpdate);

    // Reconnect / tab-visible reconciliation — interval-free.
    const stopPoll = startMatchSync(loadMatch, socket);

    return () => {
      socket.off("connect", join);
      socket.off("reconnect", join);
      socket.off("odds:game_update", handleGameUpdate);
      socket.off("odds:state_changed", handleGameUpdate);
      socket.off("lobby:updated", handleGameUpdate);
      stopPoll();
      socket.emit("leave_room", { roomId });
      socket.emit("leave_room", { roomId: lobbyRoom });
    };
  }, [socket, myGameId, loadMatch]);

  // ── Forfeit ──
  const handleForfeit = async () => {
    if (!myGameId || forfeiting) return;
    setForfeiting(true);
    try {
      const res = await fetch("/api/odds/pvp/forfeit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: myGameId }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      // Notify opponent
      if (socket) {
        socket.emit("room_event", {
          roomId: `odds_${myGameId}`,
          event: "odds:state_changed",
        });
      }

      // Local state reflects forfeit loss
      setGameOver(true);
      gameOverRef.current = true;
      setFinalWinner(isPlayer1 ? "player2" : "player1");
      setFinalResult(isPlayer1 ? "player2_won" : "player1_won");
      setFinalPayout(data.data.payout);
      setShowForfeitConfirm(false);
      audio.playDefeat();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setForfeiting(false);
    }
  };

  /** Cancelling only exists while waiting: it closes the open seat. */
  const cancelGame = async () => {
    try {
      await fetch("/api/odds/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: myGameId }),
      });
    } catch {}
    router.push("/casino/odds");
  };

  /** A decided duel is not replayable — the lobby opens the next one. */
  const reset = () => {
    router.push("/casino/odds");
  };

  // ── One submission per round ──
  const submitAction = useCallback(
    async (prediction: OddsPrediction) => {
      if (!myGameId || !interactiveState || isSubmitting || gameOver) return;
      setIsSubmitting(true);
      setError("");
      audio.playPick();
      try {
        // The server resolves the round the moment BOTH seats are in, so this
        // one request can also close the match (and settle the pot).
        const res = await fetch("/api/odds/pvp/pick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gameId: myGameId, prediction }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        if (!mountedRef.current) return;

        // applyStateFromServer derives the waiting state from the sanitized
        // view's mySubmitted/opponentSubmitted flags.
        applyStateFromServer({
          gameState: data.data.gameState,
          payout: data.data.payout,
          wager: wagerLocked ?? 0,
        });

        // Notify opponent — the socket events are pure "state changed"
        // pings: the receiving client always refetches the authoritative
        // state from the server, so no game state is relayed through the peer.
        if (socket && myGameId) {
          socket.emit("room_event", {
            roomId: `odds_${myGameId}`,
            event: "odds:game_update",
            payload: {},
          });
          socket.emit("room_event", {
            roomId: `odds_${myGameId}`,
            event: "odds:state_changed",
            payload: {},
          });
        }
      } catch (err: any) {
        if (mountedRef.current) setError(err.message);
      } finally {
        if (mountedRef.current) {
          setIsSubmitting(false);
          if (!gameOverRef.current) {
            // The clock restarts so a failed lock-in cannot instantly re-fire
            // the timeout submit. The CALL itself is deliberately kept: a
            // transport error must not throw away the player's call, and while
            // the round waits on the opponent that same call is what the
            // claim below is about. A new round clears it (applyStateFromServer).
            setTimeLeft(PICK_TIMER_SECONDS);
            setTimeUp(false);
          }
        }
      }
    },
    [
      myGameId,
      interactiveState,
      isSubmitting,
      gameOver,
      socket,
      wagerLocked,
      applyStateFromServer,
    ],
  );

  /**
   * The opponent is idle past the round timeout, so the seat that called the
   * round may bank it.
   *
   * This sends NO prediction — only the claim — so it can never be stored as a
   * late call, and it can never be read as "I changed my mind". The server
   * decides: if the round is not actually due it refuses and nothing moves.
   */
  const claimRound = useCallback(async () => {
    if (!myGameId || isSubmitting) return;
    setIsSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/odds/pvp/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: myGameId, claim: true }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      if (!mountedRef.current) return;
      applyStateFromServer({
        gameState: data.data.gameState,
        payout: data.data.payout,
        wager: wagerLocked ?? 0,
      });
      if (socket) {
        socket.emit("room_event", {
          roomId: `odds_${myGameId}`,
          event: "odds:state_changed",
          payload: {},
        });
      }
    } catch (err: any) {
      if (mountedRef.current) setError(err.message);
    } finally {
      if (mountedRef.current) setIsSubmitting(false);
    }
  }, [myGameId, isSubmitting, socket, wagerLocked, applyStateFromServer]);

  // Keep ref in sync
  useEffect(() => {
    submitActionRef.current = submitAction;
  }, [submitAction]);

  // Round clock. When it expires the client makes a legal call FOR the player
  // (a random exact guess) so the round can still resolve; the server decides
  // whether the round or the match is over.
  const timerUrgentPlayed = useRef(false);
  useEffect(() => {
    if (!interactiveState || gameOver || isSubmitting || waitingForOpponent)
      return;
    if (timeLeft <= 0) {
      setTimeUp(true);
      timerUrgentPlayed.current = false;
      submitActionRef.current(randomPrediction());
      return;
    }
    setTimeUp(false);
    if (timeLeft <= 5 && !timerUrgentPlayed.current) {
      timerUrgentPlayed.current = true;
      audio.playTimerUrgent();
    }
    if (timeLeft > 5) timerUrgentPlayed.current = false;
    const timer = setInterval(() => setTimeLeft((t: number) => t - 1), 1000);
    return () => clearInterval(timer);
  }, [timeLeft, interactiveState, gameOver, isSubmitting, waitingForOpponent, audio.playTimerUrgent]);

  // ── Opponent-idle clock ────────────────────────────────────────────────
  // While I am locked in, the only thing standing between me and a banked
  // round is the opponent's silence. The deadline is the SERVER's round start
  // (it is what the route measures), so this is a countdown to a rule the
  // server enforces — not a timer that can decide anything on its own.
  const roundStartedAt = interactiveState?.roundStartedAt ?? 0;
  const [idleClock, setIdleClock] = useState(0);
  useEffect(() => {
    if (!waitingForOpponent || !roundStartedAt) return undefined;
    setIdleClock(Date.now());
    const tick = setInterval(() => setIdleClock(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [waitingForOpponent, roundStartedAt]);
  const idleForMs = roundStartedAt ? Math.max(0, idleClock - roundStartedAt) : 0;
  const claimDue = waitingForOpponent && idleForMs >= ROUND_TIMEOUT_MS;
  const claimInSeconds = Math.max(
    0,
    Math.ceil((ROUND_TIMEOUT_MS - idleForMs) / 1000),
  );

  const handleSubmitGuess = () => {
    if (!interactiveState || isSubmitting || gameOver) return;
    if (!prediction) return;
    submitAction(prediction);
  };

  // ── Display helpers ──
  const displayGameState: GameState | null = useMemo(() => {
    if (!interactiveState) return null;
    return {
      rounds: roundHistory,
      currentRound: interactiveState.currentRound,
      totalRounds: interactiveState.totalRounds,
      winner: gameOver ? finalWinner : "",
      result: gameOver ? finalResult : "player1_won",
      payout: finalPayout,
      p1Score: interactiveState.p1Score,
      p2Score: interactiveState.p2Score,
    };
  }, [
    interactiveState,
    roundHistory,
    gameOver,
    finalWinner,
    finalResult,
    finalPayout,
    wagerLocked,
  ]);

  const userWon =
    gameOver &&
    ((isPlayer1 && finalWinner === "player1") ||
      (!isPlayer1 && finalWinner === "player2"));
  const userDrew = gameOver && finalWinner === "";
  // Shortcuts
  const gameId = myGameId;
  const liveRound = interactiveState
    ? interactiveState.rounds[interactiveState.currentRound - 1]
    : null;

  // The input card shows until I have locked in for this round.
  const showPredictUI =
    gameId &&
    interactiveState &&
    !gameOver &&
    !interactiveState.mySubmitted &&
    !waitingForOpponent;

  // ── Render ──
  return (
    <div>
      {matchStage === "loading" && (
        // Branded skeleton instead of a bare "Loading..." line.
        <SkeletonRows rows={3} className="mx-auto max-w-md py-4" label="Loading game" />
      )}

      {matchStage === "missing" && (
        <div className={`${LOBBY_CARD} p-8 text-center`}>
          <p className="flex items-center justify-center gap-2 text-lg font-bold text-amber-300">
            <IconAlertTriangle size={18} className="shrink-0 text-amber-300" />
            {missingText || "This match isn't available to you."}
          </p>
          <p className="mt-2 text-sm text-white/50">
            Open tables live in the lobby — you can start a new duel from there.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            {retryable && (
              <button
                type="button"
                onClick={() => {
                  setRetryable(false);
                  setMatchStage("loading");
                  void loadMatch();
                }}
                className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/40 bg-cyan-400/10 px-5 py-2.5 text-sm font-bold text-cyan-100 transition hover:bg-cyan-400/20"
              >
                <IconRefresh size={15} /> Try again
              </button>
            )}
            <button
              type="button"
              onClick={reset}
              className={`inline-flex items-center gap-2 rounded-xl px-6 py-2.5 text-sm font-extrabold ${LOBBY_PLAY}`}
            >
              <IconSwords size={15} className="text-black/70" /> Back to the lobby
            </button>
          </div>
        </div>
      )}

      {/* WAITING for opponent — the host sits here until the seat fills */}
      {matchStage === "waiting" && (
        <div className={`${LOBBY_CARD} px-4 py-8 text-center`}>
          <motion.div
            animate={reduce ? undefined : { scale: [1, 1.06, 1] }}
            transition={reduce ? undefined : { repeat: Infinity, duration: 2 }}
            className="mb-4 flex justify-center"
          >
            <IconDice size={34} className="text-amber-300 drop-shadow-[0_0_16px_rgba(251,191,36,0.5)]" />
          </motion.div>
          <p className="text-lg font-bold text-amber-300">Waiting for opponent…</p>
          <p className="mt-2 text-xs text-white/50">
            Stake {Number(wagerLocked ?? 0).toLocaleString()} coins · both stakes are escrowed the moment a challenger joins, and the winner takes the pot
          </p>
          <button
            type="button"
            onClick={() =>
              navigator.clipboard?.writeText(window.location.href)?.catch(() => {})
            }
            className="mt-4 rounded-xl border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-xs font-bold text-cyan-100 transition hover:bg-cyan-400/20"
          >
            Copy invite link
          </button>
          <div className="mt-4 flex justify-center">
            <button
              onClick={cancelGame}
              className="rounded-xl border border-red-500/40 bg-red-500/10 px-5 py-2.5 text-sm font-bold text-red-300 transition hover:bg-red-500/20"
            >
              Cancel lobby
            </button>
          </div>
        </div>
      )}

      {interactiveState && (
      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="order-1 space-y-3 lg:order-2">

      {/* PLAYING: the one submission of this round (inline so the board stays visible) */}
      {showPredictUI && (
        <motion.div
          key={`call-${interactiveState.currentRound}`}
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: motionSeconds(reduce, 0.24), ease: "easeOut" }}
          className="odds-hud odds-chamfer odds-hud--amber odds-board-bg p-3 sm:p-4"
        >
          <div className="flex items-center justify-between gap-2 border-b border-[#f5ff3b]/20 pb-2">
            <span className="odds-label flex items-center gap-2 text-[#f5ff3b]">
              <IconCrystalBall size={12} /> call the number
            </span>
            <span className="odds-label text-white/35">
              round {interactiveState.currentRound}/{interactiveState.totalRounds}
            </span>
          </div>

          <p className="odds-label mt-3 text-white/35">the clue · same for both seats</p>
          <ClueReveal clue={liveRound?.clue} round={interactiveState.currentRound} />

          <p className="odds-label mt-3 text-white/45">
            one call · a number, or a range like 40-50 · hidden until the reveal
          </p>

          <PickHistoryStrip
            rounds={roundHistory}
            isPlayer1={isPlayer1}
            userLabel={myName}
            oppLabel={opponentName}
            className="mt-3"
          />

          {/* Timer — a readout plus a bar that drains, so the pressure is
              readable at a glance without parsing the number. */}
          <div className="mt-3 flex items-center gap-3">
            <span
              className={`odds-readout flex shrink-0 items-center gap-1.5 border px-2.5 py-1 text-lg ${
                timeLeft <= 5
                  ? "animate-pulse border-red-500/50 text-red-400 motion-reduce:animate-none"
                  : "border-cyan-400/25 text-cyan-200/80"
              }`}
            >
              <IconClock size={16} /> {timeLeft}s
            </span>
            <div className="h-1 min-w-0 flex-1 bg-white/10">
              <div
                className={`h-full transition-[width] duration-1000 ease-linear ${
                  timeLeft <= 5 ? "bg-red-500" : "bg-cyan-400"
                }`}
                style={{ width: `${Math.max(0, Math.min(100, (timeLeft / 15) * 100))}%` }}
              />
            </div>
          </div>

          {/* Time's up indicator */}
          {timeUp && isSubmitting && (
            <p className="odds-label mt-3 animate-pulse text-amber-300 motion-reduce:animate-none">
              <span className="inline-flex items-center gap-1"><IconAlarm size={13} /> time's up · locking in
              </span>
            </p>
          )}

          {/* The call: wheel, manual entry, presets and the live preview. */}
          <PredictionPanel
            className="mt-3"
            clue={liveRound?.clue ?? null}
            value={prediction}
            onChange={setPrediction}
            onSubmit={handleSubmitGuess}
            disabled={isSubmitting}
          />
          <button
            onClick={handleSubmitGuess}
            disabled={isSubmitting || prediction === null}
            className="odds-chamfer odds-label mt-2 w-full bg-[#f5ff3b] px-6 py-3.5 text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {isSubmitting ? "locking in…" : "lock in"}
          </button>

          {/* Emotes */}
          <div className="mt-3 flex justify-center">
              <EmotePicker
                compact
                incomingEmote={incomingEmote}
                myEmote={myEmote}
                onSend={(emote) => sendEmote(emote)}
              />
            </div>

            {error && (
              <p className="mt-3 text-center text-sm text-red-400">{error}</p>
            )}

            {/* Sound toggle + Forfeit */}
            <div className="mt-4 flex items-center justify-center gap-3">
              <button
                onClick={() => audio.setEnabled(!audio.enabled)}
                className={`rounded-full border px-3 py-1 text-sm transition ${
                  audio.enabled
                    ? "border-white/10 text-white/60 hover:text-white"
                    : "border-red-400/40 text-red-400/60"
                }`}
                title={audio.enabled ? "Sounds on" : "Sounds off"}
              >
                {audio.enabled ? <IconVolume size={16} /> : <IconVolumeOff size={16} />}
              </button>
              <button
                onClick={() => setShowForfeitConfirm(true)}
                className="rounded-full border border-red-400/30 px-3 py-1 text-sm text-red-400/70 hover:bg-red-500/10 hover:text-red-300 transition"
                title="Forfeit game"
              >
                <span className="inline-flex items-center gap-1"><IconFlag size={14} /> Forfeit</span>
              </button>
            </div>

            {/* Forfeit confirmation */}
            {showForfeitConfirm && (
              <div className="mt-3 rounded-lg border border-red-400/30 bg-red-900/10 p-3 text-center">
                <p className="text-sm text-red-300 mb-2">
                  Forfeit? Your opponent will win the pot.
                </p>
                <div className="flex items-center justify-center gap-3">
                  <button
                    onClick={handleForfeit}
                    disabled={forfeiting}
                    className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-bold text-white hover:bg-red-500 transition disabled:opacity-50"
                  >
                    {forfeiting ? "Forfeiting..." : "Yes, Forfeit"}
                  </button>
                  <button
                    onClick={() => setShowForfeitConfirm(false)}
                    disabled={forfeiting}
                    className="rounded-lg border border-white/20 px-4 py-1.5 text-sm text-white/60 hover:text-white transition"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
        </motion.div>
      )}


      {/* WAITING FOR OPPONENT — the call card hides once you've locked in;
          a compact banner shows while the opponent catches up */}
      {interactiveState && !gameOver && waitingForOpponent && (
        <div className="odds-hud odds-chamfer odds-board-bg p-4 text-center">
          <p className="odds-label flex items-center justify-center gap-1.5 text-[#f5ff3b]">
            <IconHourglass size={13} /> waiting for opponent to call
          </p>
          <p className="odds-label mt-2 text-white/40">
            round {interactiveState.currentRound}/{interactiveState.totalRounds} ·{" "}
            your call is locked
          </p>

          {/* The round timeout, made reachable: once the opponent has been
              silent for the whole window the seat that called the round may
              bank it. The button sends the claim only — never a call. */}
          {claimDue ? (
            <button
              type="button"
              onClick={() => void claimRound()}
              disabled={isSubmitting}
              className="odds-chamfer odds-label mt-3 w-full bg-[#f5ff3b] px-4 py-2.5 text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isSubmitting
                ? "claiming…"
                : "opponent idle · claim the round"}
            </button>
          ) : (
            <p className="odds-label mt-2 text-white/25">
              claim unlocks in {claimInSeconds}s if they stay idle
            </p>
          )}

          {error && (
            <p className="odds-label mt-2 text-red-400">{error}</p>
          )}

          {/* Forfeit from waiting state */}
          <div className="mt-3 flex justify-center">
            {!showForfeitConfirm ? (
              <button
                onClick={() => setShowForfeitConfirm(true)}
                className="rounded-full border border-red-400/30 px-3 py-1 text-sm text-red-400/70 hover:bg-red-500/10 hover:text-red-300 transition"
              >
                <span className="inline-flex items-center gap-1"><IconFlag size={14} /> Forfeit</span>
              </button>
            ) : (
              <div className="rounded-lg border border-red-400/30 bg-red-900/10 p-3 text-center">
                <p className="text-sm text-red-300 mb-2">
                  Forfeit? Your opponent will win the pot.
                </p>
                <div className="flex items-center justify-center gap-3">
                  <button
                    onClick={handleForfeit}
                    disabled={forfeiting}
                    className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-bold text-white hover:bg-red-500 transition disabled:opacity-50"
                  >
                    {forfeiting ? "Forfeiting..." : "Yes, Forfeit"}
                  </button>
                  <button
                    onClick={() => setShowForfeitConfirm(false)}
                    disabled={forfeiting}
                    className="rounded-lg border border-white/20 px-4 py-1.5 text-sm text-white/60 hover:text-white transition"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      </div>

      {/* Readout column: score strip, surviving range, round log */}
      <div className="order-2 space-y-3 lg:order-1">
        {displayGameState && (
          <OddsGameDisplay
            gameState={displayGameState}
            revealedRounds={roundHistory.length}
            gameOver={gameOver}
            userWon={userWon}
            userDrew={userDrew}
            isPlayer1={isPlayer1}
            userLabel={myName}
            oppLabel={opponentName}
            oppIconKey={opponentIconKey}
            oppProfileFrame={opponentProfileFrame}
            oppNameColor={opponentNameColor}
            onPlayAgain={reset}
          />
        )}
      </div>
      </div>
      )}

      {/* Report button */}
      {gameOver && opponentId && (
        <div className="flex justify-center mt-4">
          <button
            onClick={() => setShowReportModal(true)}
            className="px-4 py-1.5 rounded-lg bg-red-500/20 border border-red-500/40 text-xs font-bold text-red-300 hover:bg-red-500/30"
          >
            <span className="inline-flex items-center gap-1"><IconFlag size={12} /> Report</span>
          </button>
        </div>
      )}

      <ReportModal
        isOpen={showReportModal && !!opponentId}
        onClose={() => setShowReportModal(false)}
        onSubmit={async (reason, details) => {
          const res = await fetch("/api/reports/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reportedClerkId: opponentId,
              gameType: "odds",
              gameId: myGameId ? String(myGameId) : undefined,
              reason,
              details: details || undefined,
            }),
          });
          const data = await res.json();
          if (!data.success)
            throw new Error(data.error || "Failed to submit report");
        }}
        reportedPlayerName={opponentName || "Opponent"}
        gameType="Odds"
      />
    </div>
  );
}

// ─── Call History Strip ──────────────────────────────────────────────────
// Compact per-round summary of each player's CALL (an exact number or a range)
// on the rounds already resolved, so players can read their opponent's habits
// themselves. Only revealed rounds are shown — the live round's calls stay
// hidden until both seats are in.
//
// Two single-line readouts, not two wrapping clouds of chips: this strip sits
// above the input on every round, so every pixel of its height is a pixel the
// player has to scroll past. Each line scrolls sideways once five rounds stop
// fitting.
function PickHistoryStrip({
  rounds,
  isPlayer1,
  userLabel,
  oppLabel,
  className = "",
}: {
  rounds: GameRound[];
  isPlayer1: boolean;
  userLabel: string;
  oppLabel: string;
  className?: string;
}) {
  // Only resolved rounds are public: the live round's target and calls are
  // still secret, so it never appears here.
  const revealed = rounds.filter((round) => round.resolved);
  if (revealed.length === 0) return null;
  const userPoss = userLabel === "You" ? "Your" : `${userLabel}'s`;

  const line = (
    label: string,
    tone: "cyan" | "amber",
    valueOf: (round: GameRound) => string,
  ) => (
    <div className="flex items-center gap-2">
      <span
        className={`odds-label w-[4.5rem] shrink-0 ${
          tone === "cyan" ? "text-cyan-300/75" : "text-[#f5ff3b]/75"
        }`}
      >
        {label}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pb-0.5">
        {revealed.map((round, index) => (
          <span
            key={`${tone}-${index}`}
            className={`odds-readout flex shrink-0 items-center gap-1 border px-1.5 py-0.5 text-[11px] ${
              tone === "cyan"
                ? "border-cyan-400/30 bg-cyan-400/5 text-cyan-200"
                : "border-[#f5ff3b]/30 bg-[#f5ff3b]/5 text-[#f5ff3b]"
            }`}
          >
            <span className="text-[9px] opacity-50">R{index + 1}</span>
            {valueOf(round)}
          </span>
        ))}
      </div>
    </div>
  );

  return (
    <div className={`space-y-1 text-left ${className}`}>
      {line(
        `${oppLabel} calls`,
        "cyan",
        (round) => describePrediction(isPlayer1 ? round.player2Prediction : round.player1Prediction),
      )}
      {line(
        `${userPoss} calls`,
        "amber",
        (round) => describePrediction(isPlayer1 ? round.player1Prediction : round.player2Prediction),
      )}
    </div>
  );
}

// ─── Clue Reveal ───────────────────────────────────────────────────────────
/**
 * The round's clue, fading in when it changes.
 *
 * Keyed by round, so the animation runs once per round and cannot replay on a
 * poll, a re-render or a reconnect. The text is the server's; the motion is
 * only how it arrives.
 */
function ClueReveal({
  clue,
  round,
}: {
  clue: string | null | undefined;
  round: number;
}) {
  const reduce = useReducedMotionSafe();
  return (
    <motion.p
      key={`clue-${round}`}
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: motionSeconds(reduce, CLUE_SECONDS), ease: "easeOut" }}
      className="mt-1 text-sm leading-relaxed text-white/75"
    >
      {clue ?? "—"}
    </motion.p>
  );
}

// ─── Shared Game Display Component ─────────────────────────────────────────
function OddsGameDisplay({
  gameState,
  revealedRounds,
  gameOver,
  userWon,
  userDrew,
  isPlayer1,
  userLabel,
  oppLabel,
  onPlayAgain,
  onReturnToLobby = null,
  oppIconKey,
  oppProfileFrame,
  oppNameColor,
}: {
  gameState: GameState;
  revealedRounds: number;
  gameOver: boolean;
  userWon: boolean;
  userDrew: boolean;
  isPlayer1: boolean;
  userLabel: string;
  oppLabel: string;
  onPlayAgain: () => void;
  /** Practice/AI only: the popup's way back to the Odds lobby. A live PvP
   *  match passes nothing, so the result panel keeps its resign-only exit. */
  onReturnToLobby?: (() => void) | null;
  oppIconKey?: string | null;
  oppProfileFrame?: unknown;
  oppNameColor?: string | null;
}) {
  const reduce = useReducedMotionSafe();
  const myPts = isPlayer1 ? gameState.p1Score : gameState.p2Score;
  const oppPts = isPlayer1 ? gameState.p2Score : gameState.p1Score;

  // Round result popup — shown after every revealed round so both
  // players see who won the prediction and the points earned. Has a
  // "Next Round" button that auto-advances after 5 seconds.
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [countdown, setCountdown] = useState(5);
  const prevRevealedRef = useRef(revealedRounds);
  useEffect(() => {
    const increased = revealedRounds > prevRevealedRef.current;
    prevRevealedRef.current = revealedRounds;
    if (!increased) return;
    setShowBreakdown(true);
    setCountdown(5);
  }, [revealedRounds]);

  // Countdown → auto-dismiss (auto "Next Round") after 5s.
  useEffect(() => {
    if (!showBreakdown) return;
    if (countdown <= 0) {
      setShowBreakdown(false);
      return;
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [showBreakdown, countdown]);

  const userPoss = userLabel === "You" ? "Your" : `${userLabel}'s`;
  const oppPoss =
    oppLabel === "Opponent"
      ? "Opponent's"
      : oppLabel === "AI"
        ? "AI's"
        : `${oppLabel}'s`;

  const latestRound =
    revealedRounds > 0 ? gameState.rounds[revealedRounds - 1] : null;
  // Both seats call the SAME target, so a round's breakdown is a comparison of
  // two calls against one revealed number — no "off by" arithmetic any more.
  const breakdown =
    latestRound && {
      target: latestRound.target,
      myPred: describePrediction(
        isPlayer1 ? latestRound.player1Prediction : latestRound.player2Prediction,
      ),
      oppPred: describePrediction(
        isPlayer1 ? latestRound.player2Prediction : latestRound.player1Prediction,
      ),
      // The raw call, not its label: the reveal draws the band from these
      // numbers. Null only if the round somehow resolved without a call.
      myCall: (isPlayer1
        ? latestRound.player1Prediction
        : latestRound.player2Prediction) ?? null,
      myPts: isPlayer1 ? latestRound.player1Score : latestRound.player2Score,
      oppPts: isPlayer1 ? latestRound.player2Score : latestRound.player1Score,
    };

  return (
    <div className="space-y-3">
      {/* Board readout: the two cumulative scores plus the round counter. The
          domain is fixed at 1–100 for all five rounds, so there is no shrinking
          window to show — the clue is what tightens. */}
      <div className="odds-hud odds-chamfer odds-board-bg p-2.5">
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="odds-label text-cyan-300/70">
            round {gameState.currentRound}/{gameState.totalRounds}
          </span>
          <span className="odds-label text-white/35">target 1–100</span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="odds-hud odds-chamfer odds-hud--amber px-3 py-2">
            <p className="odds-label truncate text-[#f5ff3b]/70">{userLabel}</p>
            <p className="odds-readout mt-1 text-3xl text-[#f5ff3b] drop-shadow-[0_0_14px_rgba(245,255,59,0.45)]">
              <AnimatedScore value={myPts} />
            </p>
          </div>
          <div className="odds-hud odds-chamfer px-3 py-2">
            <p className="odds-label truncate text-cyan-300/70">{oppLabel}</p>
            <p className="odds-readout mt-1 text-3xl text-cyan-200 drop-shadow-[0_0_14px_rgba(0,229,255,0.4)]">
              <AnimatedScore value={oppPts} />
            </p>
          </div>
        </div>
      </div>

      {/* The compact pick strip lives on the INPUT side of the board (see the
          pick/predict panels) — the log below already carries every number per
          round, so repeating it here only added height. */}

      {/* Round result popup — who won the prediction + points earned.
          "Next Round" advances immediately; otherwise auto-advances after 5s. */}
      <AnimatePresence>
        {showBreakdown && breakdown && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: motionSeconds(reduce, 0.25) }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          >
            <motion.div
              initial={reduce ? false : { opacity: 0, scale: 0.8, y: 30 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.8, y: 30 }}
              transition={
                reduce
                  ? { duration: 0 }
                  : { type: "spring", stiffness: 260, damping: 22, delay: 0.1 }
              }
              className="odds-hud odds-chamfer odds-hud--amber odds-board-bg max-h-[92vh] w-full max-w-md overflow-y-auto p-5 text-center"
            >
              <p className="odds-label text-[#f5ff3b]/70">
                round {revealedRounds} result
              </p>
              <motion.p
                initial={reduce ? false : { scale: 0 }}
                animate={{ scale: 1 }}
                transition={
                  reduce
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 300, damping: 15, delay: 0.2 }
                }
                className="text-5xl mt-3"
              >
                {breakdown.myPts > breakdown.oppPts
                  ? <IconTarget size={48} className="text-yellow-400" />
                  : breakdown.oppPts > breakdown.myPts
                    ? <IconMoodAngry size={48} className="text-white/80" />
                    : <IconHeartHandshake size={48} className="text-white/70" />}
              </motion.p>
              <h3
                className={`mt-2 text-2xl font-black ${
                  breakdown.myPts > breakdown.oppPts
                    ? "text-yellow-400"
                    : breakdown.oppPts > breakdown.myPts
                      ? "text-white/80"
                      : "text-white/70"
                }`}
              >
                {breakdown.myPts > breakdown.oppPts
                  ? "You called it!"
                  : breakdown.oppPts > breakdown.myPts
                    ? `${oppLabel} called it`
                    : "It's a tie!"}
              </h3>
              {/* The target is already resolved server-side by the time this
                  popup exists, so the ring has nothing to invent: the marker
                  lands on the segment the server named and the hit/miss
                  label comes from the points the server awarded. */}
              <TargetReveal
                key={`reveal-${revealedRounds}`}
                target={breakdown.target}
                prediction={breakdown.myCall}
                points={breakdown.myPts}
                className="mt-2"
              />
              <p className="odds-label mt-2 text-white/40">
                {userLabel} +{breakdown.myPts} · {oppLabel} +{breakdown.oppPts}
              </p>

              <div className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                <div className="odds-hud odds-chamfer odds-hud--amber p-3">
                  <p className="odds-label text-[#f5ff3b]/70">{userPoss} call</p>
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-[11px] text-white/45">your call</span>
                    <span className="odds-readout text-white">{breakdown.myPred}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-white/45">target</span>
                    <span className="odds-readout text-white">{breakdown.target ?? "—"}</span>
                  </div>
                  <p className="odds-readout mt-1.5 text-right text-[#f5ff3b]">+{breakdown.myPts}</p>
                </div>
                <div className="odds-hud odds-chamfer p-3">
                  <p className="odds-label text-cyan-300/70">{oppPoss} call</p>
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-[11px] text-white/45">their call</span>
                    <span className="odds-readout text-white">{breakdown.oppPred}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-white/45">target</span>
                    <span className="odds-readout text-white">{breakdown.target ?? "—"}</span>
                  </div>
                  <p className="odds-readout mt-1.5 text-right text-cyan-200">+{breakdown.oppPts}</p>
                </div>
              </div>

              <button
                onClick={() => setShowBreakdown(false)}
                className="odds-chamfer odds-label mt-3 w-full bg-[#f5ff3b] px-6 py-3.5 text-black transition hover:brightness-110"
              >
                {gameOver ? "see final results" : "next round"}
                {countdown > 0 && (
                  <span className="ml-2 opacity-60">({countdown}s)</span>
                )}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Round log — one compact row per round, newest first, scrolling
          inside a bounded window (`odds-log`). This is deliberately NOT a
          stack of full round cards any more: six of those made the board three
          screens tall, which pushed the input the player actually needs off
          screen. The full breakdown for the round just resolved still gets its
          own popup, so nothing is lost. */}
      <RoundLog
        rounds={gameState.rounds}
        revealedRounds={revealedRounds}
        isPlayer1={isPlayer1}
        userLabel={userLabel}
        oppLabel={oppLabel}
      />

      {/* Game over result screen — waits for the final round's result popup to dismiss */}
      {gameOver && !showBreakdown && (
        <PvpResultScreen
          open
          outcome={userWon ? "win" : userDrew ? "draw" : "loss"}
          gameName="Odds"
          onReturnToLobby={onReturnToLobby}
          headline={
            userWon
              ? "You called it right"
              : userDrew
                ? "Evenly matched"
                : "The odds didn't fall your way"
          }
          subline={userDrew ? "You tied." : undefined}
          opponent={{
            name: oppLabel,
            iconKey: oppIconKey || null,
            profileFrame: oppProfileFrame || null,
            isAi: oppLabel === "AI",
          }}
          summary={[
            { label: "Final Score", value: `${userLabel} ${myPts} – ${oppPts} ${oppLabel}` },
            { label: "Rounds", value: String(gameState.totalRounds) },
          ]}
          playAgain={{ onClick: onPlayAgain }}
        />
      )}
    </div>
  );
}

// ─── Round Log ─────────────────────────────────────────────────────────────
/**
 * The board's history as one compact row per round.
 *
 * Every value that decided a round is on a single line — your pick, their
 * pick, your prediction, their prediction, then the points each side took and
 * the verdict. Newest first, like a live log, and the whole thing lives inside
 * a fixed-height window (`.odds-log`) so six rounds take the same space as
 * one: the old markup gave each round a full four-row card, which turned the
 * board into three screens of scrolling and pushed the input off the bottom.
 *
 * A round that has not been revealed yet keeps its row and stays redacted
 * rather than disappearing, so the shape of the match is always legible.
 */
function RoundLog({
  rounds,
  revealedRounds,
  isPlayer1,
  userLabel,
  oppLabel,
}: {
  rounds: GameRound[];
  revealedRounds: number;
  isPlayer1: boolean;
  userLabel: string;
  oppLabel: string;
}) {
  // Newest first. `index` stays the original round index, so "visible" is
  // decided by the caller's own revealed count, exactly as before.
  const reduce = useReducedMotionSafe();
  const ordered = rounds.map((round, index) => ({ round, index })).reverse();
  // Six columns: round, both calls, the revealed target, the points pair, and
  // the verdict. One line per round, so a round costs ~2rem of height instead
  // of ~15rem.
  const grid =
    "grid grid-cols-[1.6rem_minmax(0,1.1fr)_minmax(0,1.1fr)_2.2rem_3rem_2.4rem] items-center gap-1.5";

  return (
    <div className="odds-hud odds-chamfer overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-cyan-400/15 bg-black/35 px-3 py-2">
        <span className="odds-label flex items-center gap-2 text-cyan-300/75">
          <IconTarget size={12} /> round log
        </span>
        <span className="odds-label text-white/30">
          {revealedRounds}/{rounds.length} revealed
        </span>
      </div>

      {rounds.length === 0 ? (
        <p className="odds-label px-3 py-5 text-center text-white/30">
          no rounds logged yet
        </p>
      ) : (
        <div className="odds-log">
          {/* Column headers, so the four numbers never need a legend. */}
          <div className={`${grid} border-b border-white/5 px-3 py-1.5`}>
            <span className="odds-label text-white/25">rnd</span>
            <span className="odds-label text-[#f5ff3b]/60">your call</span>
            <span className="odds-label text-cyan-300/60">{oppLabel} call</span>
            <span className="odds-label text-fuchsia-300/50">tgt</span>
            <span className="odds-label text-right text-white/25">pts</span>
            <span className="odds-label text-right text-white/25">out</span>
          </div>

          {ordered.map(({ round, index }) => {
            const visible = index < revealedRounds;
            const myPts = isPlayer1 ? round.player1Score : round.player2Score;
            const oppPts = isPlayer1 ? round.player2Score : round.player1Score;
            // Both seats are scored against the SAME target, so the round
            // verdict is simply the higher score (null = nobody scored more).
            const roundWon =
              myPts === null || oppPts === null
                ? null
                : myPts === oppPts
                  ? null
                  : myPts > oppPts;
            const outcome = !visible
              ? "—"
              : roundWon === null
                ? "tie"
                : roundWon
                  ? "won"
                  : "lost";
            const outcomeTone = !visible
              ? "text-white/20"
              : roundWon === null
                ? "text-white/45"
                : roundWon
                  ? "text-[#f5ff3b]"
                  : "text-rose-300/70";

            return (
              <motion.div
                key={index}
                initial={reduce ? false : { opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: motionSeconds(reduce, 0.3), delay: reduce ? 0 : visible ? 0.05 : 0 }}
                className={`${grid} border-b border-white/5 px-3 py-2 last:border-b-0`}
              >
                <span className="odds-label text-white/35">R{index + 1}</span>

                {visible ? (
                  <>
                    <span className="odds-readout text-center text-sm text-[#f5ff3b]">
                      {describePrediction(
                        isPlayer1 ? round.player1Prediction : round.player2Prediction,
                      )}
                    </span>
                    <span className="odds-readout text-center text-sm text-cyan-200">
                      {describePrediction(
                        isPlayer1 ? round.player2Prediction : round.player1Prediction,
                      )}
                    </span>
                    <span className="odds-readout text-center text-sm text-fuchsia-300">
                      {round.target ?? "—"}
                    </span>
                  </>
                ) : (
                  <span className="odds-label col-span-3 text-white/20">
                    locked · awaiting reveal
                  </span>
                )}

                <span className="odds-readout flex items-center justify-end gap-1 text-[11px]">
                  {visible ? (
                    <>
                      <span className="text-[#f5ff3b]">+{myPts}</span>
                      <span className="text-white/20">/</span>
                      <span className="text-cyan-200/70">+{oppPts}</span>
                    </>
                  ) : (
                    <span className="text-white/20">—</span>
                  )}
                </span>
                <span className={`odds-label text-right ${outcomeTone}`}>{outcome}</span>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
