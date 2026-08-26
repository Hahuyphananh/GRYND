"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { usePostHog } from "posthog-js/react";
import NavigationBar from "../../../components/navigation-bar";
import { RulesModal, useFirstVisitRules } from "../../../components/lobby/PvpLobby";
import ReportModal from "../../../components/ReportModal";
import { useSocket } from "../../../context/SocketProvider";
import { celebrateWin } from "../../../lib/animations";
import { useOddsAudio } from "../../../lib/oddsAudio";
import {
  IconDice,
  IconCoins,
  IconDeviceGamepad2,
  IconTarget,
  IconCrystalBall,
  IconVolume,
  IconVolumeOff,
  IconFlag,
  IconHourglass,
  IconTrophy,
  IconMoodAngry,
  IconHeartHandshake,
  IconMoodSad,
  IconClock,
  IconAlarm,
} from "@tabler/icons-react";
import {
  TOTAL_ROUNDS,
  type InteractiveOddsState as InteractiveOddsStateType,
  type OddsPlayerView,
  type OddsRound,
  type PvPInteractiveOddsState,
} from "../../../lib/odds";

type GameRound = OddsRound;

type GameState = {
  rounds: GameRound[];
  currentRound: number;
  totalRounds: number;
  currentMax: number;
  winner: string; // "player1" | "player2" | "" (draw)
  result: string;
  payout: number;
  p1Score: number;
  p2Score: number;
};

type PvPInteractiveState = PvPInteractiveOddsState;

export default function OddsPage() {
  const [mode, setMode] = useState<"ai" | "pvp">("pvp");
  const [showRules, setShowRules] = useState(false);
  const firstVisitRules = useFirstVisitRules("odds");
  useEffect(() => {
    if (firstVisitRules) setShowRules(true);
  }, [firstVisitRules]);
  const audio = useOddsAudio();

  return (
    <div
      className="relative flex min-h-screen flex-col items-center justify-start overflow-x-clip bg-gradient-to-b from-[#0a0118] to-[#061b3d] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8"
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(251,191,36,0.08),transparent_70%)] pointer-events-none" />
      <NavigationBar currentPath="/casino" />
      <div className="mt-6 w-full max-w-2xl rounded-2xl border border-amber-700/60 bg-black/40 p-4 text-white shadow-[0_0_24px_rgba(251,191,36,0.12)] sm:mt-10 sm:p-6">
        <h1 className="mb-2 text-center text-2xl font-extrabold tracking-wide text-amber-400 sm:text-3xl drop-shadow-[0_0_15px_rgba(251,191,36,0.4)]">
          <span className="inline-flex items-center gap-2"><IconDice size={28} /> Odds Game</span>
        </h1>
        <p className="mb-4 text-center text-sm text-white/60">
          Pick your number and predict your opponent's. Closest predictions win. Range halves each round.
        </p>

        {/* How to Play — rules modal at the top of the lobby */}
        <div className="mb-5 text-center">
          <button
            onClick={() => setShowRules(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-bold text-amber-300 transition-all duration-300 hover:bg-amber-500/20 hover:scale-105 shadow-[0_0_14px_rgba(251,191,36,0.15)]"
          >
            <IconCrystalBall size={15} /> How to Play
          </button>
        </div>
        {showRules && (
          <RulesModal
            title="How to Play"
            sections={[
              {
                heading: "Two-phase prediction duel",
                body: (
                  <>
                    Each round you <b>pick a hidden number</b>, then{" "}
                    <b>predict your opponent&apos;s number</b>.
                  </>
                ),
              },
              {
                heading: "Band scoring",
                body: (
                  <>
                    The closer your predictions, the more points you
                    score. Hitting the exact band pays the most.
                  </>
                ),
              },
              {
                heading: "Shrinking range",
                body: (
                  <>
                    The number range <b>halves each round</b> over 6
                    rounds. Later rounds are higher-stakes.
                  </>
                ),
              },
              {
                heading: "Win the match",
                body: (
                  <>
                    The player with the most points after all rounds
                    takes the pot (minus the house fee).
                  </>
                ),
              },
            ]}
            onClose={() => setShowRules(false)}
          />
        )}

        <div className="mb-6 grid grid-cols-2 gap-2 sm:flex sm:justify-center sm:space-x-4 sm:gap-0">
          <button
            className={`px-4 py-2 rounded font-semibold ${
              mode === "pvp"
                ? "border-b-4 border-amber-700 bg-amber-500 text-black shadow-[0_0_14px_rgba(251,191,36,0.5)]"
                : "border border-gray-600 bg-gray-800/50 text-gray-400 hover:border-amber-600/50 hover:text-amber-200"
            }`}
            onClick={() => setMode("pvp")}
          >
            PvP
          </button>
          <button
            className={`px-4 py-2 rounded font-semibold ${
              mode === "ai"
                ? "border-b-4 border-amber-700 bg-amber-500 text-black shadow-[0_0_14px_rgba(251,191,36,0.5)]"
                : "border border-gray-600 bg-gray-800/50 text-gray-400 hover:border-amber-600/50 hover:text-amber-200"
            }`}
            onClick={() => setMode("ai")}
          >
            vs AI
          </button>
        </div>

        {mode === "ai" ? <AIOddsGame audio={audio} /> : <PvPOddsGame audio={audio} />}
      </div>
    </div>
  );
}

// ─── AI Mode (Interactive) ─────────────────────────────────────────────────
function AIOddsGame({ audio }: { audio: ReturnType<typeof useOddsAudio> }) {
  const PICK_TIMER_SECONDS = 15;

  const [wager, setWager] = useState(50);
  const [loading, setLoading] = useState(false);
  const [gameId, setGameId] = useState<number | null>(null);
  const [interactiveState, setInteractiveState] = useState<InteractiveOddsStateType | null>(null);
  const posthog = usePostHog();
  const [roundHistory, setRoundHistory] = useState<GameRound[]>([]);
  const [pickValue, setPickValue] = useState("");
  const [predictValue, setPredictValue] = useState("");
  const [autoPick, setAutoPick] = useState(false);
  const [timeLeft, setTimeLeft] = useState(PICK_TIMER_SECONDS);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [gameOver, setGameOver] = useState(false);
  const [finalWinner, setFinalWinner] = useState<"player1" | "player2" | "">("player1");
  const [finalResult, setFinalResult] = useState<"player1_won" | "player2_won" | "draw">("player1_won");
  const [finalPayout, setFinalPayout] = useState(0);
  const [timeUp, setTimeUp] = useState(false);
  const [resuming, setResuming] = useState(true);

  // Wrap handlePick in a ref so timer/autopick effects can call it without stale closures
  const submitActionRef = useRef<(value: number, isPrediction: boolean) => void>(() => {});
  const mountedRef = useRef(true);
  const autoPickTriggeredRef = useRef(false);
  const gameOverRef = useRef(false);
  gameOverRef.current = gameOver;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // On mount: check for an active game to resume
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/odds/ai/status");
        const data = await res.json();
        if (cancelled || !data.success || !data.data.active) return;

        const st = data.data.gameState;
        setGameId(data.data.gameId);
        setWager(data.data.wager);
        setInteractiveState(st);
        setRoundHistory(data.data.rounds ?? []);
        setPickValue("");
        setPredictValue("");
        setTimeLeft(PICK_TIMER_SECONDS);
        setTimeUp(false);
        autoPickTriggeredRef.current = false;

        if (st?.gameOver) {
          setGameOver(true);
          setFinalWinner(st.winner ?? "");
          setFinalResult(
            st.winner === "player1"
              ? "player1_won"
              : st.winner === "player2"
                ? "player2_won"
                : "draw",
          );
          setFinalPayout(data.data.payout);
        }
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
    setPickValue("");
    setPredictValue("");
    setTimeLeft(PICK_TIMER_SECONDS);
    setGameOver(false);
    setFinalPayout(0);

    try {
      const res = await fetch("/api/odds/ai/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wager }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to start game");
      setGameId(data.data.gameId);
      setInteractiveState(data.data.gameState);
      posthog?.capture("odds_game_started", { mode: "ai", wager, game_id: data.data.gameId });
    } catch (err: any) {
      setError(err.message || "Error starting game");
    } finally {
      setLoading(false);
    }
  };

  const submitAction = useCallback(
    async (value: number, isPrediction: boolean) => {
      if (!gameId || !interactiveState || isSubmitting || gameOver) return;
      autoPickTriggeredRef.current = true; // prevent double-trigger
      setIsSubmitting(true);
      setError("");
      audio.playPick();
      try {
        const res = await fetch("/api/odds/ai/pick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isPrediction
              ? { gameId, prediction: value }
              : { gameId, playerNumber: value },
          ),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        if (!mountedRef.current) return;

        const updatedState = data.data.updatedState;

        // A resolved round (both predictions in) comes back with the
        // round data; a phase transition (number locked in) does not.
        if (data.data.round) {
          setRoundHistory((prev) => [...prev, data.data.round]);
        }
        setInteractiveState(updatedState);

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
        posthog?.capture("odds_game_ended", { result: isPlayer1Win ? "win" : drew ? "draw" : "loss", mode: "ai", wager, payout: data.data.payout || 0 });

        if (isPlayer1Win) {
          setTimeout(() => {
            if (mountedRef.current) {
              celebrateWin();
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
          setTimeLeft(PICK_TIMER_SECONDS);
          setTimeUp(false);
          setPickValue("");
          autoPickTriggeredRef.current = false;
        }
      }
    }
    },
    [gameId, interactiveState, isSubmitting, gameOver],
  );

  const handlePick = useCallback(
    (number: number) => submitAction(number, false),
    [submitAction],
  );
  const handlePredict = useCallback(
    (prediction: number) => submitAction(prediction, true),
    [submitAction],
  );

  // Keep ref in sync
  useEffect(() => {
    submitActionRef.current = submitAction;
  }, [submitAction]);

  // Timer countdown
  const timerUrgentPlayed = useRef(false);
  useEffect(() => {
    if (!interactiveState || gameOver || isSubmitting) return;
    if (timeLeft <= 0) {
      setTimeUp(true);
      timerUrgentPlayed.current = false;
      const range = interactiveState.currentMax;
      submitActionRef.current(
        Math.floor(Math.random() * range) + 1,
        interactiveState.phase === "predict",
      );
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
  }, [timeLeft, interactiveState, gameOver, isSubmitting, audio.playTimerUrgent]);

  // Autopick: auto-submit a random number when a new round starts and autopick is ON
  useEffect(() => {
    if (!interactiveState || gameOver || isSubmitting) return;
    if (!autoPick) return;
    if (autoPickTriggeredRef.current) return;
    autoPickTriggeredRef.current = true;
    const range = interactiveState.currentMax;
    const t = setTimeout(() => {
      submitActionRef.current(
        Math.floor(Math.random() * range) + 1,
        interactiveState.phase === "predict",
      );
    }, 600);
    return () => clearTimeout(t);
  }, [interactiveState, autoPick, gameOver, isSubmitting]);

  const handleSubmitPick = () => {
    if (!interactiveState || isSubmitting || gameOver) return;
    const num = parseInt(pickValue, 10);
    const range = interactiveState.currentMax;
    if (isNaN(num) || num < 1 || num > range) return;
    handlePick(num);
  };

  const handleSubmitPredict = () => {
    if (!interactiveState || isSubmitting || gameOver) return;
    const pred = parseInt(predictValue, 10);
    const range = interactiveState.currentMax;
    if (isNaN(pred) || pred < 1 || pred > range) return;
    handlePredict(pred);
  };

  // Digit-only input constrained to the current 1..range (returns the
  // new value string, or the previous value when invalid).
  const handlePickInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const range = interactiveState?.currentMax ?? 100;
    if (val === "" || /^\d+$/.test(val)) {
      const num = parseInt(val, 10);
      if (val === "" || (num >= 1 && num <= range)) {
        setPickValue(val);
      }
    }
  };

  const handlePredictInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const range = interactiveState?.currentMax ?? 100;
    if (val === "" || /^\d+$/.test(val)) {
      const num = parseInt(val, 10);
      if (val === "" || (num >= 1 && num <= range)) {
        setPredictValue(val);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    if (interactiveState?.phase === "predict") handleSubmitPredict();
    else handleSubmitPick();
  };

  // Build a synthetic GameState for the display component
  const displayGameState: GameState | null = useMemo(() => {
    if (!interactiveState) return null;
    return {
      rounds: roundHistory,
      currentRound: interactiveState.currentRound,
      totalRounds: interactiveState.totalRounds,
      currentMax: interactiveState.currentMax,
      winner: gameOver ? finalWinner : "",
      result: gameOver ? finalResult : "player1_won",
      payout: gameOver ? finalPayout : wager * 2,
      p1Score: interactiveState.p1Score,
      p2Score: interactiveState.p2Score,
    };
  }, [interactiveState, roundHistory, gameOver, finalWinner, finalResult, finalPayout, wager]);

  const handlePlayAgain = () => {
    setGameId(null);
    setInteractiveState(null);
    setRoundHistory([]);
    setPickValue("");
    setPredictValue("");
    setGameOver(false);
    setFinalPayout(0);
    setError("");
    setTimeLeft(PICK_TIMER_SECONDS);
  };

  const range = interactiveState?.currentMax ?? 100;
  const userWon = gameOver && finalWinner === "player1";
  const userDrew = gameOver && finalWinner === "";

  return (
    <div>
      {resuming && (
        <p className="text-center text-white/40 py-8">Loading...</p>
      )}

      {!resuming && !gameId && (
        <>
          <div className="mb-4 rounded-lg border-2 border-dashed border-amber-400/40 bg-amber-500/10 p-3 text-center">
            <p className="flex items-center justify-center gap-1.5 text-xs font-bold uppercase tracking-widest text-amber-300"><IconDeviceGamepad2 size={14} /> Free Play</p>
            <p className="mt-1 text-[10px] text-amber-200/70">No tokens are wagered. Playing vs AI is free.</p>
          </div>
          <button
            onClick={startGame}
            disabled={loading}
            className="w-full rounded-xl border-b-4 border-amber-700 bg-amber-500 p-3 font-bold text-lg text-black shadow-[0_0_18px_rgba(251,191,36,0.4)] hover:brightness-110 transition active:translate-y-[2px] disabled:opacity-50"
          >
            {loading ? "Starting..." : <span className="inline-flex items-center gap-2"><IconDice size={18} /> Play vs AI</span>}
          </button>
          {error && <p className="mt-3 text-center text-red-400">{error}</p>}
        </>
      )}

      {gameId && interactiveState && !gameOver && interactiveState.phase === "pick" && (
        <div className="mb-4 rounded-2xl border-2 border-yellow-400/40 bg-[#0a1a3a]/95 p-6 text-center shadow-[0_0_60px_rgba(250,204,21,0.25)]">
            <p className="text-3xl mb-1"><IconTarget size={36} className="text-yellow-400" /></p>
            <h2 className="text-xl font-extrabold text-yellow-400">Pick Your Number</h2>
            <p className="text-xs text-white/40 mt-1">
              Round {interactiveState.currentRound} of {interactiveState.totalRounds} · Wager {wager} <IconCoins size={12} className="inline" />
            </p>
            <p className="text-sm text-white/60 mt-2 mb-4">
              Choose a number from <span className="text-yellow-400 font-bold">1–{range}</span>. It stays
              hidden from the AI until reveal.
            </p>

            <PickHistoryStrip
              rounds={roundHistory}
              isPlayer1={true}
              userLabel="You"
              oppLabel="AI"
              className="mb-4"
            />

            {/* Timer */}
            <div className="flex items-center justify-center mb-4">
              <div
                className={`rounded-full border px-4 py-1 text-lg font-bold transition-colors ${
                  timeLeft <= 5
                    ? "border-red-500/50 text-red-400 animate-pulse"
                    : "border-white/10 text-white/60"
                }`}
              >
                <IconClock size={18} className="inline" /> {timeLeft}s
              </div>
            </div>

            {/* Time's up indicator */}
            {timeUp && isSubmitting && (
              <p className="text-center text-sm text-amber-400 animate-pulse mb-3">
                <span className="inline-flex items-center gap-1"><IconAlarm size={14} /> Time's up! Locking in automatically...</span>
              </p>
            )}

            {/* Number input + Lock In */}
            <label htmlFor="odds-ai-pick" className="sr-only">Your number 1–{range}</label>
            <input
              id="odds-ai-pick"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              className="w-full rounded-lg border border-yellow-400/30 bg-[#08142f] p-3 text-center text-lg font-bold text-white placeholder-white/20"
              placeholder={`1–${range}`}
              value={pickValue}
              onChange={handlePickInputChange}
              onKeyDown={handleKeyDown}
              disabled={isSubmitting || autoPick}
            />
            <button
              onClick={handleSubmitPick}
              disabled={isSubmitting || autoPick || pickValue === ""}
              className="mt-3 w-full rounded-lg bg-gradient-to-r from-yellow-500 to-amber-500 px-6 py-3 font-bold text-black transition hover:scale-105 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {isSubmitting ? "Locking in..." : "Lock In"}
            </button>

            {/* Sound + Autopick toggles */}
            <div className="mt-4 flex items-center justify-center gap-4">
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
                    autoPick ? "bg-yellow-500" : "bg-white/20"
                  }`}
                  onClick={() => {
                    setAutoPick(!autoPick);
                    if (!autoPick) {
                      // Turning autopick ON: clear any manual input
                      setPickValue("");
                    }
                  }}
                >
                  <div
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                      autoPick ? "translate-x-6" : "translate-x-0.5"
                    }`}
                  />
                </div>
                <span className="text-sm text-white/60">Autopick</span>
              </label>
            </div>

            {error && (
              <p className="mt-3 text-center text-sm text-red-400">{error}</p>
            )}
        </div>
      )}

      {gameId && interactiveState && !gameOver && interactiveState.phase === "predict" && (
        <div className="mb-4 rounded-2xl border-2 border-yellow-400/40 bg-[#0a1a3a]/95 p-6 text-center shadow-[0_0_60px_rgba(250,204,21,0.25)]">
            <p className="text-3xl mb-1"><IconCrystalBall size={36} className="text-fuchsia-400" /></p>
            <h2 className="text-xl font-extrabold text-yellow-400">Predict Your Opponent</h2>
            <p className="text-xs text-white/40 mt-1">
              Round {interactiveState.currentRound} of {interactiveState.totalRounds} · Wager {wager} <IconCoins size={12} className="inline" />
            </p>
            <p className="text-sm text-white/60 mt-2 mb-4">
              Which number do you think they chose? Pick from{" "}
              <span className="text-yellow-400 font-bold">1–{range}</span>. Your
              prediction stays hidden until the reveal.
            </p>

            <PickHistoryStrip
              rounds={roundHistory}
              isPlayer1={true}
              userLabel="You"
              oppLabel="AI"
              className="mb-4"
            />

            {/* Timer */}
            <div className="flex items-center justify-center mb-4">
              <div
                className={`rounded-full border px-4 py-1 text-lg font-bold transition-colors ${
                  timeLeft <= 5
                    ? "border-red-500/50 text-red-400 animate-pulse"
                    : "border-white/10 text-white/60"
                }`}
              >
                <IconClock size={18} className="inline" /> {timeLeft}s
              </div>
            </div>

            {/* Time's up indicator */}
            {timeUp && isSubmitting && (
              <p className="text-center text-sm text-amber-400 animate-pulse mb-3">
                <span className="inline-flex items-center gap-1"><IconAlarm size={14} /> Time's up! Locking in automatically...</span>
              </p>
            )}

            {/* Prediction input + Lock In */}
            <label htmlFor="odds-ai-prediction" className="sr-only">Your prediction 1–{range}</label>
            <input
              id="odds-ai-prediction"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              className="w-full rounded-lg border border-yellow-400/30 bg-[#08142f] p-3 text-center text-lg font-bold text-white placeholder-white/20"
              placeholder={`1–${range}`}
              value={predictValue}
              onChange={handlePredictInputChange}
              onKeyDown={handleKeyDown}
              disabled={isSubmitting || autoPick}
            />
            <button
              onClick={handleSubmitPredict}
              disabled={isSubmitting || autoPick || predictValue === ""}
              className="mt-3 w-full rounded-lg bg-gradient-to-r from-yellow-500 to-amber-500 px-6 py-3 font-bold text-black transition hover:scale-105 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {isSubmitting ? "Locking in..." : "Lock In"}
            </button>

            {/* Sound + Autopick toggles */}
            <div className="mt-4 flex items-center justify-center gap-4">
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
                    autoPick ? "bg-yellow-500" : "bg-white/20"
                  }`}
                  onClick={() => setAutoPick(!autoPick)}
                >
                  <div
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                      autoPick ? "translate-x-6" : "translate-x-0.5"
                    }`}
                  />
                </div>
                <span className="text-sm text-white/60">Autopick</span>
              </label>
            </div>

            {error && (
              <p className="mt-3 text-center text-sm text-red-400">{error}</p>
            )}
        </div>
      )}

      {/* Round history + scoreboard */}
      {displayGameState && (
        <div className="mt-6">
          <OddsGameDisplay
            gameState={displayGameState}
            revealedRounds={roundHistory.length}
            gameOver={gameOver}
            userWon={userWon}
            userDrew={userDrew}
            isPlayer1={true}
            userLabel="You"
            oppLabel="AI"
            wager={wager}
            payout={displayGameState.payout}
            onPlayAgain={handlePlayAgain}
          />
        </div>
      )}

      {/* Game over with no rounds (should be very rare) */}
      {gameOver && roundHistory.length === 0 && (
        <div className="mt-4 text-center">
          <p className="text-white/40">Game ended unexpectedly.</p>
          <button
            onClick={handlePlayAgain}
            className="mt-4 w-full rounded-xl bg-gradient-to-r from-yellow-500 to-amber-500 px-6 py-3 font-bold text-black shadow-lg transition-all hover:scale-105"
          >
            Play Again
          </button>
        </div>
      )}
    </div>
  );
}

// ─── PvP Mode (Interactive) ───────────────────────────────────────────────
function PvPOddsGame({ audio }: { audio: ReturnType<typeof useOddsAudio> }) {
  const PICK_TIMER_SECONDS = 15;
  const { socket } = useSocket();

  // ── Lobby state ──
  const [wager, setWager] = useState(50);
  const [userId, setUserId] = useState<string | null>(null);
  const [games, setGames] = useState<any[]>([]);
  const [myGameId, setMyGameId] = useState<number | null>(null);
  const [wagerLocked, setWagerLocked] = useState<number | null>(null);
  const [opponentId, setOpponentId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [isPlayer1, setIsPlayer1] = useState(true);

  // ── Game state ──
  const [interactiveState, setInteractiveState] = useState<PvPInteractiveState | null>(null);
  const [roundHistory, setRoundHistory] = useState<GameRound[]>([]);
  const [pickValue, setPickValue] = useState("");
  const [predictValue, setPredictValue] = useState("");
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
  const [forfeiting, setForfeiting] = useState(false);
  const [resuming, setResuming] = useState(true);

  // Refs for timer/autopick
  const submitActionRef = useRef<(value: number, isPrediction: boolean) => void>(() => {});
  const mountedRef = useRef(true);
  const myGameIdRef = useRef<number | null>(null);
  const gameOverRef = useRef(false);
  const isPlayer1Ref = useRef(true);
  const wagerLockedRef = useRef<number | null>(null);
  gameOverRef.current = gameOver;
  isPlayer1Ref.current = isPlayer1;
  wagerLockedRef.current = wagerLocked;
  // Track round count to avoid clearing pickValue on every poll/socket event
  const roundCountRef = useRef(0);
  // Track phase to clear inputs when moving pick → predict
  const phaseRef = useRef<"pick" | "predict">("pick");

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Resume: check for active PvP game on mount ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/odds/pvp/status");
        const data = await res.json();
        if (cancelled || !data.success || !data.data.active) return;

        const d = data.data;
        setMyGameId(d.gameId);
        setWagerLocked(d.wager);
        setOpponentId(d.opponentId ?? null);
        setIsPlayer1(d.isPlayer1);
        setInteractiveState(d.gameState);
        setRoundHistory(d.rounds ?? []);
        setPickValue("");
        setPredictValue("");
        setTimeLeft(PICK_TIMER_SECONDS);
        setTimeUp(false);
        setError("");
        setMessage("");

        if (d.userHasPendingPick) {
          setWaitingForOpponent(true);
        }

        if (d.gameOver) {
          setGameOver(true);
          setFinalWinner(d.winner ?? "");
          setFinalResult(
            d.winner === "player1"
              ? "player1_won"
              : d.winner === "player2"
                ? "player2_won"
                : "draw",
          );
          setFinalPayout(d.payout);
        }
      } catch {} finally {
        if (!cancelled) setResuming(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Lobby: get user + subscribe to lobby updates ──
  useEffect(() => {
    const getUser = async () => {
      const res = await fetch("/api/get-user");
      const json = await res.json();
      if (json.success) setUserId(json.data.userId);
    };
    getUser();
  }, []);

  const fetchGames = useCallback(async () => {
    try {
      const res = await fetch("/api/odds/available");
      const json = await res.json();
      if (json.success) setGames(json.data.games);
    } catch {}
  }, []);

  useEffect(() => { fetchGames(); }, [fetchGames]);

  useEffect(() => {
    if (!socket) return;
    const roomId = "lobby:odds";
    socket.emit("join_room", { roomId });
    socket.on("lobby:updated", fetchGames);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("lobby:updated", fetchGames);
    };
  }, [socket, fetchGames]);

  // Keep myGameId ref in sync
  useEffect(() => {
    myGameIdRef.current = myGameId;
  }, [myGameId]);

  // ── Socket: join game room and handle reconnects ──
  useEffect(() => {
    if (!socket || !myGameId) return;
    const roomId = `odds_${myGameId}`;

    const join = () => {
      socket.emit("join_room", { roomId });
    };

    join();
    socket.on("connect", join);
    socket.on("reconnect", join);

    return () => {
      socket.off("connect", join);
      socket.off("reconnect", join);
      socket.emit("leave_room", { roomId });
    };
  }, [socket, myGameId]);

  // Apply server state to local state
  const applyStateFromServer = useCallback(
    (serverData: any) => {
      if (!mountedRef.current) return;
      const st = serverData.gameState as OddsPlayerView | null;
      if (!st) return;

      const myIsPlayer1 = isPlayer1Ref.current;

      setInteractiveState(st);
      setRoundHistory(st.rounds ?? []);

      // Waiting = I've submitted my part of the current phase but the
      // opponent hasn't completed theirs yet. The server sanitizes each
      // player's view, so the opponent's submissions are replaced with
      // opponentPicked/opponentPredicted flags.
      const myPickSet = myIsPlayer1
        ? st.player1Pick !== null
        : st.player2Pick !== null;
      const myPredSet = myIsPlayer1
        ? st.player1Prediction !== null
        : st.player2Prediction !== null;
      setWaitingForOpponent(
        !st.gameOver &&
          ((st.phase === "pick" && myPickSet && !st.opponentPicked) ||
            (st.phase === "predict" && myPredSet && !st.opponentPredicted)),
      );

      // Reset the phase timer only on round/phase transitions — NOT on
      // every poll, otherwise the countdown would never actually elapse
      // (polls arrive every 3s) and the per-phase timeout could never fire.
      const newRoundCount = (st.rounds ?? []).length;
      if (newRoundCount !== roundCountRef.current) {
        roundCountRef.current = newRoundCount;
        setPickValue("");
        setPredictValue("");
        setTimeLeft(PICK_TIMER_SECONDS);
        setTimeUp(false);
      }
      // Clear inputs when moving between phases (number → prediction)
      if (st.phase !== phaseRef.current) {
        phaseRef.current = st.phase;
        setPickValue("");
        setPredictValue("");
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
          setTimeout(() => celebrateWin(), 400);
          setTimeout(() => audio.playVictory(), 200);
        } else if (!drew) {
          setTimeout(() => audio.playDefeat(), 200);
        }
      }
    },
    [],
  );

  // ── Socket: listen for opponent events when playing ──
  useEffect(() => {
    if (!socket || !myGameId) return;

    // The relayed payload travels through the opponent's browser and
    // must not be trusted — never apply it directly. Treat the event as
    // a "state changed" ping and always refetch the authoritative,
    // per-viewer sanitized state from the server.
    const handleGameUpdate = () => {
      if (!mountedRef.current) return;
      handler();
    };

    // Fallback: refetch state when opponent triggers a change
    const handler = async () => {
      const gid = myGameIdRef.current;
      if (!gid) return;
      try {
        const res = await fetch(`/api/odds/status?gameId=${gid}`);
        const data = await res.json();
        if (mountedRef.current && data.success && data.data) {
          applyStateFromServer(data.data);
        }
      } catch {}
    };

    socket.on("odds:game_update", handleGameUpdate);
    socket.on("odds:state_changed", handler);
    
    // Polling fallback to handle missed socket events
    const pollInterval = setInterval(handler, 3000);

    return () => {
      socket.off("odds:game_update", handleGameUpdate);
      socket.off("odds:state_changed", handler);
      clearInterval(pollInterval);
    };
  }, [socket, myGameId, applyStateFromServer]);

  // ── Create / Join / Cancel ──
  const createGame = async () => {
    setMessage("Creating game...");
    setLoading(true);
    try {
      const res = await fetch("/api/odds/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wager, isAi: false }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setMyGameId(data.data.gameId);
      setWagerLocked(wager);
      setIsPlayer1(true);
      setMessage("Waiting for opponent to join...");
      socket?.emit("room_event", {
        roomId: "lobby:odds",
        event: "lobby:updated",
      });
    } catch (err: any) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  const joinGame = async (gameId: number) => {
    setMessage("Joining game...");
    setLoading(true);
    try {
      const res = await fetch("/api/odds/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setMyGameId(gameId);
      setIsPlayer1(false);
      setWagerLocked(data.data.wager ?? null);
      setOpponentId(data.data.player1Id ?? null);
      setInteractiveState(data.data.gameState);
      setRoundHistory(data.data.gameState?.rounds ?? []);
      setGameOver(false);
      setMessage("");
      setWaitingForOpponent(false);
      setTimeLeft(PICK_TIMER_SECONDS);
      socket?.emit("room_event", {
        roomId: "lobby:odds",
        event: "lobby:updated",
      });
    } catch (err: any) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Poll for opponent joining (when player1 is waiting)
  useEffect(() => {
    if (!myGameId || interactiveState || !isPlayer1) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/odds/status?gameId=${myGameId}`);
        const data = await res.json();
        if (data.success && data.data.status === "playing" && data.data.player2Id) {
          setOpponentId(data.data.player2Id);
          applyStateFromServer(data.data);
        }
      } catch {}
    }, 1500);
    return () => clearInterval(interval);
  }, [myGameId, interactiveState, isPlayer1, applyStateFromServer]);

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

  const cancelGame = async () => {
    try {
      await fetch("/api/odds/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: myGameId }),
      });
    } catch {}
    setMyGameId(null);
    setWagerLocked(null);
    setInteractiveState(null);
    setRoundHistory([]);
    setMessage("");
    setGameOver(false);
    socket?.emit("room_event", {
      roomId: "lobby:odds",
      event: "lobby:updated",
    });
  };

  const reset = () => {
    setMyGameId(null);
    setInteractiveState(null);
    setRoundHistory([]);
    setGameOver(false);
    setWagerLocked(null);
    setOpponentId(null);
    setIsPlayer1(true);
    setMessage("");
    setError("");
    setWaitingForOpponent(false);
    setPickValue("");
    setPredictValue("");
    setTimeLeft(PICK_TIMER_SECONDS);
    setFinalPayout(0);
    setShowForfeitConfirm(false);
    roundCountRef.current = 0;
  };

  // ── Pick / Predict handling ──
  const submitAction = useCallback(
    async (value: number, isPrediction: boolean) => {
      if (!myGameId || !interactiveState || isSubmitting || gameOver) return;
      setIsSubmitting(true);
      setError("");
      audio.playPick();
      try {
        const res = await fetch("/api/odds/pvp/pick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isPrediction
              ? { gameId: myGameId, prediction: value }
              : { gameId: myGameId, playerNumber: value },
          ),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        if (!mountedRef.current) return;

        // applyStateFromServer derives the waiting state from the
        // sanitized view + opponentPicked/opponentPredicted flags.
        applyStateFromServer({
          gameState: data.data.gameState,
          payout: data.data.payout,
          wager: wagerLocked ?? wager,
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
            setTimeLeft(PICK_TIMER_SECONDS);
            setTimeUp(false);
            if (isPrediction) setPredictValue("");
            else setPickValue("");
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
      wager,
      applyStateFromServer,
    ],
  );

  const handlePick = useCallback(
    (number: number) => submitAction(number, false),
    [submitAction],
  );
  const handlePredict = useCallback(
    (prediction: number) => submitAction(prediction, true),
    [submitAction],
  );

  // Keep ref in sync
  useEffect(() => {
    submitActionRef.current = submitAction;
  }, [submitAction]);

  // Timer
  const timerUrgentPlayed = useRef(false);
  useEffect(() => {
    if (!interactiveState || gameOver || isSubmitting || waitingForOpponent)
      return;
    if (timeLeft <= 0) {
      setTimeUp(true);
      timerUrgentPlayed.current = false;
      const range = interactiveState.currentMax;
      submitActionRef.current(
        Math.floor(Math.random() * range) + 1,
        interactiveState.phase === "predict",
      );
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

  const handleSubmitPick = () => {
    if (!interactiveState || isSubmitting || gameOver) return;
    const num = parseInt(pickValue, 10);
    const range = interactiveState.currentMax;
    if (isNaN(num) || num < 1 || num > range) return;
    handlePick(num);
  };

  const handleSubmitPredict = () => {
    if (!interactiveState || isSubmitting || gameOver) return;
    const pred = parseInt(predictValue, 10);
    const range = interactiveState.currentMax;
    if (isNaN(pred) || pred < 1 || pred > range) return;
    handlePredict(pred);
  };

  const handlePickInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val === "" || /^\d+$/.test(val)) {
      const range = interactiveState?.currentMax ?? 100;
      const num = parseInt(val, 10);
      if (val === "" || (num >= 1 && num <= range)) {
        setPickValue(val);
      }
    }
  };

  const handlePredictInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val === "" || /^\d+$/.test(val)) {
      const range = interactiveState?.currentMax ?? 100;
      const num = parseInt(val, 10);
      if (val === "" || (num >= 1 && num <= range)) {
        setPredictValue(val);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    if (interactiveState?.phase === "predict") handleSubmitPredict();
    else handleSubmitPick();
  };

  // ── Display helpers ──
  const displayGameState: GameState | null = useMemo(() => {
    if (!interactiveState) return null;
    return {
      rounds: roundHistory,
      currentRound: interactiveState.currentRound,
      totalRounds: interactiveState.totalRounds,
      currentMax: interactiveState.currentMax,
      winner: gameOver ? finalWinner : "",
      result: gameOver ? finalResult : "player1_won",
      payout: gameOver ? finalPayout : (wagerLocked ?? wager) * 2,
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
    wager,
  ]);

  const userWon =
    gameOver &&
    ((isPlayer1 && finalWinner === "player1") ||
      (!isPlayer1 && finalWinner === "player2"));
  const userDrew = gameOver && finalWinner === "";
  const range = interactiveState?.currentMax ?? 100;
  const phase = interactiveState?.phase ?? "pick";
  const myPickSet =
    !gameOver &&
    interactiveState &&
    ((isPlayer1 && interactiveState.player1Pick !== null) ||
      (!isPlayer1 && interactiveState.player2Pick !== null));
  const myPredSet =
    !gameOver &&
    interactiveState &&
    ((isPlayer1 && interactiveState.player1Prediction !== null) ||
      (!isPlayer1 && interactiveState.player2Prediction !== null));
  // Shortcuts
  const gameId = myGameId;

  const showPickUI =
    gameId &&
    interactiveState &&
    !gameOver &&
    phase === "pick" &&
    !myPickSet &&
    !waitingForOpponent;
  const showPredictUI =
    gameId &&
    interactiveState &&
    !gameOver &&
    phase === "predict" &&
    !myPredSet &&
    !waitingForOpponent;

  // ── Render ──
  return (
    <div>
      {resuming && (
        <p className="text-center text-white/40 py-8">Loading...</p>
      )}

      {/* LOBBY: no game yet */}
      {!resuming && !gameId && !interactiveState && (
        <>
          <div className="mb-4 text-center text-sm">
            <span className="uppercase tracking-widest text-[11px] text-white/55 mr-2">Wager</span>
            <div className="mt-2 flex flex-wrap justify-center gap-1.5">
              {[10, 25, 50, 100, 250, 500].map((v) => (
                <button
                  key={v}
                  onClick={() => setWager(v)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition ${
                    wager === v
                      ? "border-amber-400 bg-amber-500/20 text-amber-300 shadow-[0_0_15px_rgba(251,191,36,0.3)]"
                      : "border-gray-600 bg-gray-800/50 text-gray-400 hover:border-amber-600/50 hover:text-amber-200"
                  }`}
                >
                  {v.toLocaleString()}
                </button>
              ))}
            </div>
            <input
              id="odds-pvp-wager"
              type="number"
              aria-label="Wager amount"
              className="mt-2 w-full rounded-md border border-amber-600/50 bg-[#020617] px-2 py-1.5 text-xs text-white outline-none focus:border-amber-400"
              value={wager}
              onChange={(e) => setWager(Number(e.target.value))}
              min={1}
            />
          </div>
          <button
            onClick={createGame}
            disabled={loading}
            className="w-full rounded-xl border-b-4 border-amber-700 bg-amber-500 p-3 font-bold text-lg text-black shadow-[0_0_18px_rgba(251,191,36,0.4)] hover:brightness-110 transition active:translate-y-[2px] disabled:opacity-50 mb-6"
          >
            {loading ? "Creating..." : <span className="inline-flex items-center gap-2"><IconDice size={18} /> Create PvP Game</span>}
          </button>

          <h2 className="text-lg font-bold mb-3 text-cyan-300">Available Games</h2>
          {games.filter((g) => g.player1Id !== userId).length === 0 && (
            <p className="text-center text-white/40 italic">
              No games available. Create one!
            </p>
          )}
          <div className="space-y-3">
            {games
              .filter((g) => g.player1Id !== userId)
              .map((game) => (
                <div
                  key={game.id}
                  className="rounded-xl border border-cyan-700/30 bg-slate-900/80 p-4 flex justify-between items-center hover:border-cyan-500/50 transition"
                >
                  <div>
                    <p className="font-bold text-white">
                      {game.player1Name}
                    </p>
                    <p className="text-sm text-white/50">
                      Wager: <span className="text-yellow-300 font-semibold">{game.wager}</span> <IconCoins size={12} className="inline" />
                    </p>
                  </div>
                  <button
                    onClick={() => joinGame(game.id)}
                    disabled={loading}
                    className="px-4 py-2 rounded-lg font-bold bg-cyan-500 text-black hover:bg-cyan-400 disabled:opacity-50 transition"
                  >
                    Join
                  </button>
                </div>
              ))}
          </div>
          {message && (
            <p className="mt-3 text-center text-yellow-300">{message}</p>
          )}
        </>
      )}

      {/* WAITING for opponent */}
      {gameId && !interactiveState && (
        <div className="text-center py-8">
          <motion.div
            animate={{ scale: [1, 1.05, 1] }}
            transition={{ repeat: Infinity, duration: 2 }}
            className="text-4xl mb-4"
          >
            <IconDice size={36} className="text-yellow-400" />
          </motion.div>
          <p className="text-lg font-bold text-yellow-300">
            {message || "Waiting for opponent..."}
          </p>
          <p className="text-sm text-white/40 mt-2">
            Wager: {wagerLocked} <IconCoins size={12} className="inline" />
          </p>
          <button
            onClick={cancelGame}
            className="mt-6 px-6 py-2 rounded-lg font-bold bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/30"
          >
            Cancel
          </button>
        </div>
      )}

      {/* PLAYING: Pick Your Number card (inline so the game board stays visible) */}
      {showPickUI && (
        <div className="mb-4 rounded-2xl border-2 border-yellow-400/40 bg-[#0a1a3a]/95 p-6 text-center shadow-[0_0_60px_rgba(250,204,21,0.25)]">
            <p className="text-3xl mb-1"><IconTarget size={36} className="text-yellow-400" /></p>
            <h2 className="text-xl font-extrabold text-yellow-400">Pick Your Number</h2>
            <p className="text-xs text-white/40 mt-1">
              Round {interactiveState.currentRound} of {interactiveState.totalRounds} · Wager {wagerLocked ?? wager} <IconCoins size={12} className="inline" />
            </p>
            <p className="text-sm text-white/60 mt-2 mb-4">
              Choose a number from <span className="text-yellow-400 font-bold">1–{range}</span>. It stays
              hidden from your opponent until both players lock in.
            </p>

            <PickHistoryStrip
              rounds={roundHistory}
              isPlayer1={isPlayer1}
              userLabel="You"
              oppLabel="Opponent"
              className="mb-4"
            />

            {/* Timer */}
            <div className="flex items-center justify-center mb-4">
              <div
                className={`rounded-full border px-4 py-1 text-lg font-bold transition-colors ${
                  timeLeft <= 5
                    ? "border-red-500/50 text-red-400 animate-pulse"
                    : "border-white/10 text-white/60"
                }`}
              >
                <IconClock size={18} className="inline" /> {timeLeft}s
              </div>
            </div>

            {/* Time's up indicator */}
            {timeUp && isSubmitting && (
              <p className="text-center text-sm text-amber-400 animate-pulse mb-3">
                <span className="inline-flex items-center gap-1"><IconAlarm size={14} /> Time's up! Locking in automatically...</span>
              </p>
            )}

            {/* Number input + Lock In */}
            <label htmlFor="odds-pvp-pick" className="sr-only">Your number 1–{range}</label>
            <input
              id="odds-pvp-pick"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              className="w-full rounded-lg border border-yellow-400/30 bg-[#08142f] p-3 text-center text-lg font-bold text-white placeholder-white/20"
              placeholder={`1–${range}`}
              value={pickValue}
              onChange={handlePickInputChange}
              onKeyDown={handleKeyDown}
              disabled={isSubmitting}
            />
            <button
              onClick={handleSubmitPick}
              disabled={isSubmitting || pickValue === ""}
              className="mt-3 w-full rounded-lg bg-gradient-to-r from-yellow-500 to-amber-500 px-6 py-3 font-bold text-black transition hover:scale-105 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {isSubmitting ? "Locking in..." : "Lock In"}
            </button>

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
        </div>
      )}

      {/* PREDICT OPPONENT card (inline so the game board stays visible) */}
      {showPredictUI && (
        <div className="mb-4 rounded-2xl border-2 border-yellow-400/40 bg-[#0a1a3a]/95 p-6 text-center shadow-[0_0_60px_rgba(250,204,21,0.25)]">
            <p className="text-3xl mb-1"><IconCrystalBall size={36} className="text-fuchsia-400" /></p>
            <h2 className="text-xl font-extrabold text-yellow-400">Predict Your Opponent</h2>
            <p className="text-xs text-white/40 mt-1">
              Round {interactiveState.currentRound} of {interactiveState.totalRounds} · Wager {wagerLocked ?? wager} <IconCoins size={12} className="inline" />
            </p>
            <p className="text-sm text-white/60 mt-2 mb-4">
              Which number do you think they chose? Pick from{" "}
              <span className="text-yellow-400 font-bold">1–{range}</span>. Your
              prediction stays hidden from your opponent until the reveal.
            </p>

            <PickHistoryStrip
              rounds={roundHistory}
              isPlayer1={isPlayer1}
              userLabel="You"
              oppLabel="Opponent"
              className="mb-4"
            />

            {/* Timer */}
            <div className="flex items-center justify-center mb-4">
              <div
                className={`rounded-full border px-4 py-1 text-lg font-bold transition-colors ${
                  timeLeft <= 5
                    ? "border-red-500/50 text-red-400 animate-pulse"
                    : "border-white/10 text-white/60"
                }`}
              >
                <IconClock size={18} className="inline" /> {timeLeft}s
              </div>
            </div>

            {/* Time's up indicator */}
            {timeUp && isSubmitting && (
              <p className="text-center text-sm text-amber-400 animate-pulse mb-3">
                <span className="inline-flex items-center gap-1"><IconAlarm size={14} /> Time's up! Locking in automatically...</span>
              </p>
            )}

            {/* Prediction input + Lock In */}
            <label htmlFor="odds-pvp-prediction" className="sr-only">Your prediction 1–{range}</label>
            <input
              id="odds-pvp-prediction"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              className="w-full rounded-lg border border-yellow-400/30 bg-[#08142f] p-3 text-center text-lg font-bold text-white placeholder-white/20"
              placeholder={`1–${range}`}
              value={predictValue}
              onChange={handlePredictInputChange}
              onKeyDown={handleKeyDown}
              disabled={isSubmitting}
            />
            <button
              onClick={handleSubmitPredict}
              disabled={isSubmitting || predictValue === ""}
              className="mt-3 w-full rounded-lg bg-gradient-to-r from-yellow-500 to-amber-500 px-6 py-3 font-bold text-black transition hover:scale-105 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {isSubmitting ? "Locking in..." : "Lock In"}
            </button>

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
        </div>
      )}

      {/* WAITING FOR OPPONENT — the pick/predict card hides once you've
          locked in; a compact banner shows while the opponent catches up */}
      {interactiveState && !gameOver && waitingForOpponent && (
        <div className="mb-4 rounded-xl border border-yellow-400/20 bg-[#0a1a3a]/70 p-4 text-center">
          <p className="text-base font-bold text-yellow-300">
            <IconHourglass size={16} className="inline" />{" "}
            {interactiveState.phase === "predict"
              ? "Waiting for opponent to predict..."
              : "Waiting for opponent to pick..."}
          </p>
          <p className="mt-1 text-xs text-white/40">
            Round {interactiveState.currentRound} of {interactiveState.totalRounds} ·{" "}
            {interactiveState.phase === "predict"
              ? "Your prediction is locked in"
              : "Your number is locked in"}
          </p>

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

      {/* Round history + scoreboard */}
      {displayGameState && (
        <div className="mt-6">
          <OddsGameDisplay
            gameState={displayGameState}
            revealedRounds={roundHistory.length}
            gameOver={gameOver}
            userWon={userWon}
            userDrew={userDrew}
            isPlayer1={isPlayer1}
            userLabel="You"
            oppLabel="Opponent"
            wager={wagerLocked ?? wager}
            payout={displayGameState.payout}
            onPlayAgain={reset}
          />
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
        reportedPlayerName="Opponent"
        gameType="Odds"
      />
    </div>
  );
}

// ─── Pick History Strip ────────────────────────────────────────────────────
// Compact per-round summary of each player's PICKED numbers so players can
// spot the opponent's tendencies themselves. Shows raw numbers only — no
// pattern detection or hints are computed or surfaced.
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
  if (rounds.length === 0) return null;
  const userPoss = userLabel === "You" ? "Your" : `${userLabel}'s`;
  return (
    <div className={`space-y-1.5 text-left ${className}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-bold uppercase tracking-widest text-blue-300/80">
          {oppLabel} Picks
        </span>
        {rounds.map((r, i) => (
          <span
            key={`o-${i}`}
            className="rounded-md border border-blue-400/30 bg-white/5 px-1.5 py-0.5 text-[11px] font-bold text-blue-300"
          >
            R{i + 1}: {isPlayer1 ? r.player2Number : r.player1Number}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-bold uppercase tracking-widest text-yellow-300/80">
          {userPoss} Picks
        </span>
        {rounds.map((r, i) => (
          <span
            key={`m-${i}`}
            className="rounded-md border border-yellow-400/30 bg-white/5 px-1.5 py-0.5 text-[11px] font-bold text-yellow-300"
          >
            R{i + 1}: {isPlayer1 ? r.player1Number : r.player2Number}
          </span>
        ))}
      </div>
    </div>
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
  wager,
  payout,
  onPlayAgain,
}: {
  gameState: GameState;
  revealedRounds: number;
  gameOver: boolean;
  userWon: boolean;
  userDrew: boolean;
  isPlayer1: boolean;
  userLabel: string;
  oppLabel: string;
  wager: number;
  payout: number;
  onPlayAgain: () => void;
}) {
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
  const breakdown =
    latestRound && {
      myPred: isPlayer1 ? latestRound.player1Prediction : latestRound.player2Prediction,
      oppActual: isPlayer1 ? latestRound.player2Number : latestRound.player1Number,
      myActual: isPlayer1 ? latestRound.player1Number : latestRound.player2Number,
      oppPred: isPlayer1 ? latestRound.player2Prediction : latestRound.player1Prediction,
      myDiff: Math.abs(
        (isPlayer1 ? latestRound.player1Prediction : latestRound.player2Prediction) -
          (isPlayer1 ? latestRound.player2Number : latestRound.player1Number),
      ),
      oppDiff: Math.abs(
        (isPlayer1 ? latestRound.player2Prediction : latestRound.player1Prediction) -
          (isPlayer1 ? latestRound.player1Number : latestRound.player2Number),
      ),
      myPts: isPlayer1 ? latestRound.player1Score : latestRound.player2Score,
      oppPts: isPlayer1 ? latestRound.player2Score : latestRound.player1Score,
    };

  return (
    <div className="space-y-4">
      {/* Scoreboard: cumulative points + round + range */}
      <div className="rounded-xl border border-yellow-400/20 bg-[#0a1a3a] p-3">
        <div className="mb-2 flex items-center justify-between text-[11px] font-bold tracking-wider text-white/40">
          <span>ROUND {gameState.currentRound}/{gameState.totalRounds}</span>
          <span>RANGE: 1–{gameState.currentMax}</span>
        </div>
        <p className="mb-1 text-center text-[10px] font-bold uppercase tracking-widest text-white/30">
          Total Score
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-yellow-400/30 bg-white/5 p-3 text-center">
            <p className="text-[10px] font-bold uppercase tracking-widest text-yellow-300/70">
              {userLabel}
            </p>
            <p className="text-2xl font-black text-yellow-400">{myPts}</p>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-center">
            <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">
              {oppLabel}
            </p>
            <p className="text-2xl font-black text-white/70">{oppPts}</p>
          </div>
        </div>
      </div>

      {/* Compact pick history for pattern reading */}
      <PickHistoryStrip
        rounds={gameState.rounds}
        isPlayer1={isPlayer1}
        userLabel={userLabel}
        oppLabel={oppLabel}
      />

      {/* Round result popup — who won the prediction + points earned.
          "Next Round" advances immediately; otherwise auto-advances after 5s. */}
      <AnimatePresence>
        {showBreakdown && breakdown && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.8, y: 30 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.8, y: 30 }}
              transition={{ type: "spring", stiffness: 260, damping: 22, delay: 0.1 }}
              className="w-full max-w-sm rounded-2xl border-2 border-yellow-400/40 bg-[#0a1a3a]/95 p-6 text-center shadow-[0_0_60px_rgba(250,204,21,0.3)]"
            >
              <p className="text-[10px] font-bold uppercase tracking-widest text-yellow-300/70">
                Round {revealedRounds} Result
              </p>
              <motion.p
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 300, damping: 15, delay: 0.2 }}
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
                  ? "You read them best!"
                  : breakdown.oppPts > breakdown.myPts
                    ? `${oppLabel} read you best`
                    : "It's a tie!"}
              </h3>
              <p className="mt-1 text-xs text-white/40">
                Range was 1–{latestRound?.max} · {userLabel} +{breakdown.myPts} ·{" "}
                {oppLabel} +{breakdown.oppPts}
              </p>

              <div className="mt-4 space-y-2 text-sm">
                <div className="rounded-lg border border-yellow-400/20 bg-white/5 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-white/50">{userPoss} prediction:</span>
                    <span className="font-bold text-white">{breakdown.myPred}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-white/50">Actual {oppLabel} number:</span>
                    <span className="font-bold text-white">{breakdown.oppActual}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-white/50">Difference:</span>
                    <span className="font-bold text-white">{breakdown.myDiff}</span>
                  </div>
                  <p className="mt-1 text-right font-black text-yellow-400">+{breakdown.myPts} pts</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-white/50">{oppPoss} prediction:</span>
                    <span className="font-bold text-white">{breakdown.oppPred}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-white/50">Actual {userPoss.toLowerCase()} number:</span>
                    <span className="font-bold text-white">{breakdown.myActual}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-white/50">Difference:</span>
                    <span className="font-bold text-white">{breakdown.oppDiff}</span>
                  </div>
                  <p className="mt-1 text-right font-black text-white/70">+{breakdown.oppPts} pts</p>
                </div>
              </div>

              <button
                onClick={() => setShowBreakdown(false)}
                className="mt-5 w-full rounded-xl bg-gradient-to-r from-yellow-500 to-amber-500 px-6 py-3 font-bold text-black shadow-lg transition-all hover:scale-105 hover:shadow-[0_0_20px_rgba(250,204,21,0.5)]"
              >
                {gameOver ? "See Final Results" : "Next Round"}
                {countdown > 0 && (
                  <span className="ml-2 text-sm opacity-70">({countdown}s)</span>
                )}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Rounds display (newest first) */}
      <div className="space-y-3">
        {[...gameState.rounds].reverse().map((round, reversedIdx) => {
          const originalIdx = gameState.rounds.length - 1 - reversedIdx;
          const visible = reversedIdx < revealedRounds;
          const myRoundPts = isPlayer1 ? round.player1Score : round.player2Score;
          const oppRoundPts = isPlayer1 ? round.player2Score : round.player1Score;
          const roundWon =
            round.roundWinner === "draw"
              ? null
              : round.roundWinner === (isPlayer1 ? "player1" : "player2");

          return (
            <motion.div
              key={originalIdx}
              initial={{ opacity: 0, y: 20 }}
              animate={visible ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              transition={{ duration: 0.4 }}
              className={`rounded-xl border p-4 ${
                !visible
                  ? "border-white/5 bg-white/5"
                  : roundWon === null
                  ? "border-white/20 bg-white/5"
                  : "border-yellow-400/20 bg-[#0a1a3a]"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-white/40">Round {originalIdx + 1}</span>
                  {visible && (
                    <span
                      className={`text-xs font-bold ${
                        roundWon === null ? "text-white/40" : "text-yellow-400"
                      }`}
                    >
                      {roundWon === null
                        ? "Tie"
                        : roundWon
                          ? "You read them best"
                          : "They read you best"}
                    </span>
                  )}
                </div>
                <span className="text-xs font-bold text-yellow-400/60">Range: 1–{round.max}</span>
              </div>

              {visible ? (
                <>
                  <div className="space-y-1.5">
                    {/* Picks — the numbers each player actually locked in */}
                    <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-1.5">
                      <span className="text-xs text-white/50">{userLabel} Picked:</span>
                      <motion.span
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: "spring", stiffness: 300, damping: 15, delay: 0.1 }}
                        className="inline-flex w-10 items-center justify-center rounded-full bg-yellow-500 px-2 py-0.5 text-sm font-black text-black shadow-[0_0_10px_rgba(250,204,21,0.4)]"
                      >
                        {isPlayer1 ? round.player1Number : round.player2Number}
                      </motion.span>
                    </div>

                    <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-1.5">
                      <span className="text-xs text-white/50">{oppLabel} Picked:</span>
                      <motion.span
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: "spring", stiffness: 300, damping: 15, delay: 0.15 }}
                        className="inline-flex w-10 items-center justify-center rounded-full bg-blue-500 px-2 py-0.5 text-sm font-black text-white shadow-[0_0_10px_rgba(59,130,246,0.4)]"
                      >
                        {isPlayer1 ? round.player2Number : round.player1Number}
                      </motion.span>
                    </div>

                    {/* Predictions — what each player guessed about the opponent */}
                    <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-1.5">
                      <span className="text-xs text-white/50">{userLabel} Predicted:</span>
                      <motion.span
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: "spring", stiffness: 300, damping: 15, delay: 0.2 }}
                        className="inline-flex w-10 items-center justify-center rounded-full bg-purple-500 px-2 py-0.5 text-sm font-black text-white shadow-[0_0_10px_rgba(168,85,247,0.35)]"
                      >
                        {isPlayer1 ? round.player1Prediction : round.player2Prediction}
                      </motion.span>
                    </div>

                    <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-1.5">
                      <span className="text-xs text-white/50">{oppLabel} Predicted:</span>
                      <motion.span
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: "spring", stiffness: 300, damping: 15, delay: 0.25 }}
                        className="inline-flex w-10 items-center justify-center rounded-full bg-purple-500 px-2 py-0.5 text-sm font-black text-white shadow-[0_0_10px_rgba(168,85,247,0.35)]"
                      >
                        {isPlayer1 ? round.player2Prediction : round.player1Prediction}
                      </motion.span>
                    </div>
                  </div>

                  {/* Points earned this round */}
                  <motion.div
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 }}
                    className="mt-3 flex items-center justify-between rounded-lg border border-yellow-400/20 bg-[#0a1a3a] px-3 py-2 text-sm"
                  >
                    <span className="font-bold text-yellow-400">{userLabel}: +{myRoundPts}</span>
                    <span className="font-bold text-white/70">{oppLabel}: +{oppRoundPts}</span>
                  </motion.div>
                </>
              ) : (
                <div className="flex items-center justify-center gap-6">
                  <div className="w-14 h-14 rounded-full bg-white/5 flex items-center justify-center text-white/20 text-xl">?</div>
                  <div className="text-2xl font-black text-white/10">VS</div>
                  <div className="w-14 h-14 rounded-full bg-white/5 flex items-center justify-center text-white/20 text-xl">?</div>
                </div>
              )}
            </motion.div>
          );
        })}
      </div>

      {/* Game over popup — waits for the final round's result popup to dismiss */}
      <AnimatePresence>
        {gameOver && !showBreakdown && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.6, y: 40 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.6, y: 40 }}
              transition={{ type: "spring", stiffness: 250, damping: 20, delay: 0.1 }}
              className={`mx-4 w-full max-w-sm rounded-2xl border-2 p-8 text-center ${
                userWon
                  ? "border-yellow-400/50 bg-gradient-to-b from-yellow-900/60 via-[#0a1a3a]/95 to-black/95 shadow-[0_0_60px_rgba(250,204,21,0.4)]"
                  : userDrew
                  ? "border-white/30 bg-gradient-to-b from-white/10 via-[#0a1a3a]/95 to-black/95 shadow-[0_0_60px_rgba(255,255,255,0.15)]"
                  : "border-red-400/40 bg-gradient-to-b from-red-900/50 via-[#0a1a3a]/95 to-black/95 shadow-[0_0_60px_rgba(239,68,68,0.3)]"
              }`}
            >
              <motion.div
                animate={userWon ? { scale: [1, 1.2, 1] } : {}}
                transition={{ duration: 0.5, delay: 0.3 }}
              >
                <p className="mb-3 flex justify-center">{userWon ? <IconTrophy size={56} className="text-yellow-400" /> : userDrew ? <IconHeartHandshake size={56} className="text-white/80" /> : <IconMoodSad size={56} className="text-red-400" />}</p>
              </motion.div>
              <motion.p
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className={`text-3xl font-black ${
                  userWon ? "text-yellow-400" : userDrew ? "text-white/80" : "text-red-400"
                }`}
              >
                {userWon ? "You Win!" : userDrew ? "It's a Draw" : "You Lose"}
              </motion.p>
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.35 }}
                className="text-sm text-white/50 mt-3"
              >
                {userDrew
                  ? "Stakes refunded. You tied."
                  : userWon
                    ? <><span className="inline-flex items-center gap-1">Payout: {payout} <IconCoins size={14} /></span></>
                    : <><span className="inline-flex items-center gap-1">{oppLabel} wins the pot of {payout} <IconCoins size={14} /></span></>}
              </motion.p>
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.4 }}
                className="text-xs text-white/30 mt-1 mb-6"
              >
                Final score: {userLabel} {myPts} – {oppPts} {oppLabel} · {gameState.totalRounds} rounds
              </motion.p>
              <motion.button
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5 }}
                onClick={onPlayAgain}
                className="w-full rounded-xl bg-gradient-to-r from-yellow-500 to-amber-500 px-6 py-3 font-bold text-black shadow-lg transition-all hover:scale-105 hover:shadow-[0_0_20px_rgba(250,204,21,0.5)]"
              >
                Play Again
              </motion.button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
