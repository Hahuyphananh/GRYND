"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { usePostHog } from "posthog-js/react";
import NavigationBar from "../../../components/navigation-bar";
import { useRecordPlayedGame } from "../../../hooks/useRecordPlayedGame";
import useActiveGamePresence from "../../../hooks/useActiveGamePresence";
import { RulesModal, useFirstVisitRules } from "../../../components/lobby/PvpLobby";
import AiDifficultyPicker from "../../../components/lobby/AiDifficultyPicker";
import ReportModal from "../../../components/ReportModal";
import PvpResultScreen from "../../../components/result/PvpResultScreen";
import EmotePicker from "../../../components/game/EmotePicker";
import useGameEmotes from "../../../hooks/useGameEmotes";
import { useSocket } from "../../../context/SocketProvider";
import { useOddsAudio } from "../../../lib/oddsAudio";
import { SkeletonRows } from "../../../components/skeletons/Skeleton";
import {
  IconDice,
  IconCoins,
  IconDeviceGamepad2,
  IconSwords,
  IconTarget,
  IconCrystalBall,
  IconVolume,
  IconVolumeOff,
  IconFlag,
  IconHourglass,
  IconMoodAngry,
  IconHeartHandshake,
  IconClock,
  IconAlarm,
  IconRobot,
  IconAlertTriangle,
  IconTrophy,
  IconRefresh,
} from "@tabler/icons-react";
import {
  type AiDifficulty,
  readStoredAiDifficulty,
} from "../../../lib/aiDifficulty";
import { startSocketAwareInterval } from "../../../hooks/useVisiblePoll";
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

// Lobby palette — mirrors the shared PvpLobby tokens (amber + cyan on the dark
// purple-to-navy gradient) so a player arriving from any other casino lobby
// recognises the same room. Only the LOBBY uses these; the in-game board keeps
// its own HUD look.
const LOBBY_CARD =
  "rounded-2xl border border-amber-700/60 bg-black/40 shadow-[0_0_30px_rgba(251,191,36,0.12)] backdrop-blur-xl";
const LOBBY_TITLE =
  "text-transparent bg-clip-text bg-gradient-to-r from-amber-300 via-amber-400 to-yellow-500 drop-shadow-[0_0_18px_rgba(251,191,36,0.5)]";
const LOBBY_CHIP_ACTIVE =
  "border-amber-400 bg-amber-500/20 text-amber-300 shadow-[0_0_15px_rgba(251,191,36,0.3)]";
const LOBBY_CHIP_IDLE =
  "border-gray-600 bg-gray-800/50 text-gray-400 hover:border-amber-600/50 hover:text-amber-200";
const LOBBY_PLAY =
  "border-amber-700 bg-amber-500 text-black hover:brightness-110 shadow-[0_0_25px_rgba(251,191,36,0.4)]";
const LOBBY_ROW =
  "border-cyan-700/30 bg-slate-900/80 hover:border-cyan-500/50";

/**
 * Shared "free play / no stake" pill shown at the top of every lobby card,
 * matching the one the shared PvpLobby renders.
 */
function LobbyFreePlayPill() {
  return (
    <div className="mb-5 text-center text-sm">
      <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-emerald-300">
        Free play · no tokens at stake
      </span>
    </div>
  );
}

export default function OddsPage() {
  const [mode, setMode] = useState<"ai" | "pvp">("pvp");
  const [showRules, setShowRules] = useState(false);
  const firstVisitRules = useFirstVisitRules("odds");
  useEffect(() => {
    if (firstVisitRules) setShowRules(true);
  }, [firstVisitRules]);
  const audio = useOddsAudio();

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-b from-[#0a0118] to-[#061b3d] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto mt-4 max-w-5xl sm:mt-8">
        {/* Page identity — the same centred amber-gradient title every other
            casino lobby uses. */}
        <motion.h1
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="flex items-center justify-center gap-3 text-center text-3xl font-extrabold tracking-wide sm:text-4xl"
        >
          <IconDice size={30} className="text-amber-300" />
          <span className={LOBBY_TITLE}>Odds Game</span>
        </motion.h1>
        <p className="mx-auto mb-5 mt-2 max-w-2xl text-center text-sm text-white/60">
          Lock a hidden number, then read your opponent&apos;s. The range halves every round.
        </p>

        {/* Lobby controls — mode switch + rules, in the shared lobby palette. */}
        <div className="mb-6 flex flex-wrap items-center justify-center gap-3">
          <div className="flex gap-1 rounded-xl border border-amber-700/40 bg-black/40 p-1">
            <button
              className={`rounded-lg border px-4 py-2 text-sm font-bold transition-all ${
                mode === "pvp" ? LOBBY_CHIP_ACTIVE : LOBBY_CHIP_IDLE
              }`}
              onClick={() => setMode("pvp")}
            >
              PvP
            </button>
            <button
              className={`rounded-lg border px-4 py-2 text-sm font-bold transition-all ${
                mode === "ai" ? LOBBY_CHIP_ACTIVE : LOBBY_CHIP_IDLE
              }`}
              onClick={() => setMode("ai")}
            >
              vs AI
            </button>
          </div>
          <button
            onClick={() => setShowRules(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-bold text-amber-300 shadow-[0_0_14px_rgba(251,191,36,0.15)] transition-all duration-300 hover:scale-105 hover:bg-amber-500/20"
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
                    takes the pot (minus the platform fee).
                  </>
                ),
              },
            ]}
            onClose={() => setShowRules(false)}
          />
        )}


        <div className="mt-4">
          {mode === "ai" ? <AIOddsGame audio={audio} /> : <PvPOddsGame audio={audio} />}
        </div>
      </div>
    </div>
  );
}

// ─── AI Mode (Interactive) ─────────────────────────────────────────────────
function AIOddsGame({ audio }: { audio: ReturnType<typeof useOddsAudio> }) {
  const PICK_TIMER_SECONDS = 15;

  // The vs-AI match is FREE PLAY: there is no stake to track and none is sent
  // to /api/odds/ai/start (see startGame below), so the HUD, the result screen
  // and analytics all report a 0 stake instead of the player's saved default
  // wager — which used to be persisted and displayed as a real stake even
  // though no token was ever risked. The PvP game (PvPOddsGame) keeps the
  // shared default-wager control.
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
  // The tier the bot plays at for the next match. The picker remembers it per
  // device, so a returning player keeps their choice even before this renders.
  const [aiDifficulty, setAiDifficulty] = useState<AiDifficulty>(() =>
    readStoredAiDifficulty("odds"),
  );

  const gameActive = Boolean(gameId && interactiveState);
  // Record the session into "Recently played" (and the lobby's "Most
  // Played" counter) when the real game starts.
  useRecordPlayedGame("odds", gameActive);
  // Active-player presence (lobby "N playing"): an AI duel counts exactly
  // like a PvP one — the player is in a real game either way — and stops the
  // moment the duel is decided.
  useActiveGamePresence("odds", gameActive && !gameOver, { terminal: gameOver });

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

  // Timer countdown — removed in the vs-AI free-play mode: the player can
  // take as long as they want, so there is no expiry auto-pick, no urgent
  // beeps, and no countdown chip. (The PvP game keeps its 15s pick timer.)
  const timerUrgentPlayed = useRef(false);
  useEffect(() => {
    setTimeUp(false);
    return;
  }, [interactiveState?.currentRound]);

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
    setPickValue("");
    setPredictValue("");
    setGameOver(false);
    setFinalPayout(0);
    setError("");
    setTimeLeft(PICK_TIMER_SECONDS);
  };

  const range = interactiveState?.currentMax ?? 100;
  const userWon = gameOver && finalWinner === "player1";  const userDrew = gameOver && finalWinner === "";
  return (
    <div>
      {resuming && (
        // Branded skeleton instead of a bare "Loading..." line.
        <SkeletonRows rows={3} className="mx-auto max-w-md py-4" label="Loading game" />
      )}

      {!resuming && !gameId && (
        <>
          <div className={`${LOBBY_CARD} p-6`}>
            <LobbyFreePlayPill />
            <p className="mb-4 text-center text-xs leading-relaxed text-white/55">
              Pick a hidden number, then read the bot&apos;s · 6 rounds · the window halves each round.
            </p>
            <AiDifficultyPicker
              gameKey="odds"
              value={aiDifficulty}
              onChange={setAiDifficulty}
              disabled={loading}
              hint={{
                easy: "The bot guesses at random and almost never reads your habit.",
                normal: "The bot mixes guesses with the occasional read on your pattern.",
                hard: "The bot studies your picks and predicts your number most rounds.",
              }}
            />
            <button
              onClick={startGame}
              disabled={loading}
              className={`mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl border-b-4 p-3 text-base font-extrabold transition hover:scale-105 active:scale-95 disabled:opacity-50 disabled:hover:scale-100 ${LOBBY_PLAY}`}
            >
              {loading ? (
                "Starting…"
              ) : (
                <>
                  <IconRobot size={18} className="text-black/70" /> Play vs AI
                </>
              )}
            </button>
            {error && (
              <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-400/40 bg-red-900/30 px-3 py-2 text-sm text-red-200">
                <IconAlertTriangle size={16} className="flex-shrink-0 text-red-300" />
                <span>{error}</span>
              </div>
            )}
          </div>
        </>
      )}

      {gameId && interactiveState && (
      <>
      {/* THE BOARD. On desktop the readout column (score + log) sits beside the
          input column instead of above it, which is what keeps the whole game
          on one screen; on mobile the input keeps the top slot (order-1) so the
          thing you came to do is never below the reference log. */}
      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="order-1 space-y-3 lg:order-2">
      {gameId && interactiveState && !gameOver && interactiveState.phase === "pick" && (
        <div className="odds-hud odds-chamfer odds-hud--amber overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-[#f5ff3b]/20 bg-black/35 px-3 py-2">
            <span className="odds-label flex items-center gap-2 text-[#f5ff3b]">
              <IconTarget size={12} /> phase 1 // pick
            </span>
            <span className="odds-label text-white/35">
              round {interactiveState.currentRound}/{interactiveState.totalRounds}
            </span>
          </div>

          <div className="odds-board-bg p-3 sm:p-4">
            <p className="odds-label text-white/45">
              lock a number · hidden from the AI · window 1–{range}
            </p>

            <PickHistoryStrip
              rounds={roundHistory}
              isPlayer1={true}
              userLabel="You"
              oppLabel="AI"
              className="mt-3"
            />

            {/* Vs-AI mode is untimed — the pick countdown is PvP-only. */}

            {timeUp && isSubmitting && (
              <p className="odds-label mt-3 animate-pulse text-amber-300">
                <span className="inline-flex items-center gap-1"><IconAlarm size={13} /> time's up · locking in
                </span>
              </p>
            )}

            {/* Number input + Lock In */}
            <label htmlFor="odds-ai-pick" className="sr-only">Your number 1–{range}</label>
            <input
              id="odds-ai-pick"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              className="odds-input odds-chamfer mt-3 w-full p-3.5 text-center text-3xl placeholder-white/20"
              placeholder={`1–${range}`}
              value={pickValue}
              onChange={handlePickInputChange}
              onKeyDown={handleKeyDown}
              disabled={isSubmitting || autoPick}
            />
            <button
              onClick={handleSubmitPick}
              disabled={isSubmitting || autoPick || pickValue === ""}
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
                <span className="odds-label text-white/55">autopick</span>
              </label>
            </div>

            {error && (
              <p className="odds-label mt-3 text-center text-red-400">{error}</p>
            )}
          </div>
        </div>
      )}

      {gameId && interactiveState && !gameOver && interactiveState.phase === "predict" && (
        <div className="odds-hud odds-chamfer odds-hud--magenta overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-fuchsia-400/20 bg-black/35 px-3 py-2">
            <span className="odds-label flex items-center gap-2 text-fuchsia-300">
              <IconCrystalBall size={12} /> phase 2 // predict
            </span>
            <span className="odds-label text-white/35">
              round {interactiveState.currentRound}/{interactiveState.totalRounds}
            </span>
          </div>

          <div className="odds-board-bg p-3 sm:p-4">
            <p className="odds-label text-white/45">
              read their number · window 1–{range} · hidden until reveal
            </p>

            <PickHistoryStrip
              rounds={roundHistory}
              isPlayer1={true}
              userLabel="You"
              oppLabel="AI"
              className="mt-3"
            />

            {/* Timer — a readout plus a bar that drains, so the pressure is
                visible without reading the number. */}
            <div className="mt-3 flex items-center gap-3">
              <span
                className={`odds-readout flex shrink-0 items-center gap-1.5 border px-2.5 py-1 text-lg ${
                  timeLeft <= 5
                    ? "animate-pulse border-red-500/50 text-red-400"
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
              <p className="odds-label mt-3 animate-pulse text-amber-300">
                <span className="inline-flex items-center gap-1"><IconAlarm size={13} /> time's up · locking in
                </span>
              </p>
            )}

            {/* Prediction input + Lock In */}
            <label htmlFor="odds-ai-prediction" className="sr-only">Your prediction 1–{range}</label>
            <input
              id="odds-ai-prediction"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              className="odds-input odds-chamfer mt-3 w-full p-3.5 text-center text-3xl placeholder-white/20"
              placeholder={`1–${range}`}
              value={predictValue}
              onChange={handlePredictInputChange}
              onKeyDown={handleKeyDown}
              disabled={isSubmitting || autoPick}
            />
            <button
              onClick={handleSubmitPredict}
              disabled={isSubmitting || autoPick || predictValue === ""}
              className="odds-chamfer odds-label mt-2 w-full bg-fuchsia-400 px-6 py-3.5 text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30"
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
                    autoPick ? "bg-fuchsia-400" : "bg-white/20"
                  }`}
                  onClick={() => setAutoPick(!autoPick)}
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
            isPlayer1={true}
            userLabel="You"
            oppLabel="AI"
            onPlayAgain={handlePlayAgain}
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
    </div>
  );
}

// ─── PvP Mode (Interactive) ───────────────────────────────────────────────
function PvPOddsGame({ audio }: { audio: ReturnType<typeof useOddsAudio> }) {
  const PICK_TIMER_SECONDS = 15;
  const { socket } = useSocket();

  // ── Lobby state ──
  // STAKES ARE RETIRED (src/lib/games/stakes.js): a match is free to enter.
  const wager = 0;
  const [userId, setUserId] = useState<string | null>(null);
  const [games, setGames] = useState<any[]>([]);
  const [myGameId, setMyGameId] = useState<number | null>(null);
  const [wagerLocked, setWagerLocked] = useState<number | null>(null);
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

  // Emotes — dedicated per-match room (mirrors the other PvP games).
  const { incomingEmote, myEmote, sendEmote } = useGameEmotes({
    socket,
    roomId: myGameId != null ? `odds:emote:${myGameId}` : null,
    eventName: "odds:emote",
    selfId: userId,
  });
  const [forfeiting, setForfeiting] = useState(false);
  const [resuming, setResuming] = useState(true);

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
        setMyName(d.myName || "You");
        setMyIconKey(d.myIconKey || null);
        setMyNameColor(d.myNameColor || null);
        setMyProfileFrame(d.myProfileFrame || null);
        setOpponentName(d.opponentName || "Opponent");
        setOpponentIconKey(d.opponentIconKey || null);
        setOpponentNameColor(d.opponentNameColor || null);
        setOpponentProfileFrame(d.opponentProfileFrame || null);
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
      // A non-JSON error response must not throw out of the mount effect —
      // `res.json()` on an HTML error page rejects and React reports it as an
      // uncaught error. Parse defensively and leave the user id unset.
      const res = await fetch("/api/get-user");
      const json = await res.json().catch(() => null);
      if (json?.success) setUserId(json.data?.userId ?? null);
    };
    void getUser();
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
    
    // Polling fallback to handle missed socket events. Socket-aware and
    // visibility-gated: 30s while the push path is healthy, 5s if it drops, and
    // off entirely while the tab is hidden.
    const stopPoll = startSocketAwareInterval(handler, socket);

    return () => {
      socket.off("odds:game_update", handleGameUpdate);
      socket.off("odds:state_changed", handler);
      stopPoll();
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
    // The join also arrives over the socket, so this is a backstop: socket-aware
    // and visibility-gated (30s healthy / 5s if the socket drops) rather than a
    // flat 1.5s hammer — nobody is waiting on an opponent from a hidden tab.
    return startSocketAwareInterval(async () => {
      try {
        const res = await fetch(`/api/odds/status?gameId=${myGameId}`);
        const data = await res.json();
        if (data.success && data.data.status === "playing" && data.data.player2Id) {
          setOpponentId(data.data.player2Id);
          applyStateFromServer(data.data);
        }
      } catch {}
    }, socket);
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
        // Branded skeleton instead of a bare "Loading..." line.
        <SkeletonRows rows={3} className="mx-auto max-w-md py-4" label="Loading game" />
      )}

      {/* LOBBY: no game yet */}
      {!resuming && !gameId && !interactiveState && (
        <>
          <div className={`${LOBBY_CARD} p-6`}>
            <LobbyFreePlayPill />
            <div className="flex flex-col items-center gap-3 text-center">
              <p className="text-xs leading-relaxed text-white/55">
                Open a lobby and wait for a challenger, or join one below · 6 rounds · the window halves each round.
              </p>
              <button
                onClick={createGame}
                disabled={loading}
                className={`inline-flex items-center justify-center gap-2 rounded-xl border-b-4 px-8 py-3 text-base font-extrabold transition hover:scale-105 active:scale-95 disabled:opacity-50 disabled:hover:scale-100 ${LOBBY_PLAY}`}
              >
                {loading ? (
                  "Creating…"
                ) : (
                  <>
                    <IconSwords size={18} className="text-black/70" /> Create Lobby
                  </>
                )}
              </button>
            </div>
            {message && (
              <p className="mt-4 text-center text-sm text-amber-300">{message}</p>
            )}
          </div>

          <div className={`${LOBBY_CARD} mt-6 p-5`}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-bold uppercase tracking-wider text-cyan-300">
                <IconTrophy size={18} /> Open Lobbies
              </h2>
              <button
                type="button"
                onClick={fetchGames}
                className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-black transition hover:bg-cyan-400"
              >
                <IconRefresh size={14} /> Refresh
              </button>
            </div>
            {games.filter((g) => g.player1Id !== userId).length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-white/60">
                <IconDeviceGamepad2 size={16} className="text-white/40" />
                No open lobbies yet. Be the first to make one.
              </p>
            ) : (
              <div className="space-y-2.5">
                {games
                  .filter((g) => g.player1Id !== userId)
                  .map((game) => (
                    <div
                      key={game.id}
                      className={`flex items-center justify-between rounded-xl border p-3 transition ${LOBBY_ROW}`}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-white">
                          {game.player1Name}
                        </p>
                        <p className="mt-0.5 text-xs text-white/60">Free play</p>
                      </div>
                      <button
                        onClick={() => joinGame(game.id)}
                        disabled={loading}
                        className="shrink-0 rounded-lg bg-cyan-500 px-4 py-1.5 text-sm font-bold text-black transition hover:bg-cyan-400 disabled:opacity-50"
                      >
                        Join
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </>
      )}

      {gameId && (
      <>
      {/* WAITING for opponent */}
      {gameId && !interactiveState && (
        <div className={`${LOBBY_CARD} px-4 py-8 text-center`}>
          <motion.div
            animate={{ scale: [1, 1.06, 1] }}
            transition={{ repeat: Infinity, duration: 2 }}
            className="mb-4 flex justify-center"
          >
            <IconDice size={34} className="text-amber-300 drop-shadow-[0_0_16px_rgba(251,191,36,0.5)]" />
          </motion.div>
          <p className="text-lg font-bold text-amber-300">
            {message || "Waiting for opponent…"}
          </p>
          <p className="mt-2 text-xs text-white/50">Free play · no stake</p>
          <button
            onClick={cancelGame}
            className="mt-5 rounded-xl border border-red-500/40 bg-red-500/10 px-5 py-2.5 text-sm font-bold text-red-300 transition hover:bg-red-500/20"
          >
            Cancel
          </button>
        </div>
      )}

      {/* THE BOARD. Same two-column rule as vs-AI: the input column keeps the
          top slot on mobile (order-1) and moves to the right on desktop, with
          the readout column (score + log) beside it. */}
      {interactiveState && (
      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="order-1 space-y-3 lg:order-2">

      {/* PLAYING: Pick Your Number card (inline so the game board stays visible) */}
      {showPickUI && (
        <div className="odds-hud odds-chamfer odds-hud--amber odds-board-bg p-3 sm:p-4">
          <div className="flex items-center justify-between gap-2 border-b border-[#f5ff3b]/20 pb-2">
            <span className="odds-label flex items-center gap-2 text-[#f5ff3b]">
              <IconTarget size={12} /> phase 1 // pick
            </span>
            <span className="odds-label text-white/35">
              round {interactiveState.currentRound}/{interactiveState.totalRounds}
            </span>
          </div>

          <p className="odds-label mt-3 text-white/45">
            lock a number · hidden until both players commit · window 1–{range}
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
                  ? "animate-pulse border-red-500/50 text-red-400"
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
            <p className="odds-label mt-3 animate-pulse text-amber-300">
              <span className="inline-flex items-center gap-1"><IconAlarm size={13} /> time's up · locking in
              </span>
            </p>
          )}

          {/* Number input + Lock In */}
          <label htmlFor="odds-pvp-pick" className="sr-only">Your number 1–{range}</label>
          <input
            id="odds-pvp-pick"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            className="odds-input odds-chamfer mt-3 w-full p-3.5 text-center text-3xl placeholder-white/20"
            placeholder={`1–${range}`}
            value={pickValue}
            onChange={handlePickInputChange}
            onKeyDown={handleKeyDown}
            disabled={isSubmitting}
          />
          <button
            onClick={handleSubmitPick}
            disabled={isSubmitting || pickValue === ""}
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
        </div>
      )}

      {/* PREDICT OPPONENT card (inline so the game board stays visible) */}
      {showPredictUI && (
        <div className="odds-hud odds-chamfer odds-hud--magenta odds-board-bg p-3 sm:p-4">
          <div className="flex items-center justify-between gap-2 border-b border-fuchsia-400/20 pb-2">
            <span className="odds-label flex items-center gap-2 text-fuchsia-300">
              <IconCrystalBall size={12} /> phase 2 // predict
            </span>
            <span className="odds-label text-white/35">
              round {interactiveState.currentRound}/{interactiveState.totalRounds}
            </span>
          </div>

          <p className="odds-label mt-3 text-white/45">
            read their number · hidden until the reveal · window 1–{range}
          </p>

          <PickHistoryStrip
            rounds={roundHistory}
            isPlayer1={isPlayer1}
            userLabel={myName}
            oppLabel={opponentName}
            className="mt-3"
          />

          {/* Timer */}
          <div className="mt-3 flex items-center gap-3">
            <span
              className={`odds-readout flex shrink-0 items-center gap-1.5 border px-2.5 py-1 text-lg ${
                timeLeft <= 5
                  ? "animate-pulse border-red-500/50 text-red-400"
                  : "border-cyan-400/25 text-cyan-200/80"
              }`}
            >
              <IconClock size={16} /> {timeLeft}s
            </span>
            <div className="h-1 min-w-0 flex-1 bg-white/10">
              <div
                className={`h-full transition-[width] duration-1000 ease-linear ${
                  timeLeft <= 5 ? "bg-red-500" : "bg-fuchsia-400"
                }`}
                style={{ width: `${Math.max(0, Math.min(100, (timeLeft / 15) * 100))}%` }}
              />
            </div>
          </div>

          {/* Time's up indicator */}
          {timeUp && isSubmitting && (
            <p className="odds-label mt-3 animate-pulse text-amber-300">
              <span className="inline-flex items-center gap-1"><IconAlarm size={13} /> time's up · locking in
              </span>
            </p>
          )}

          {/* Prediction input + Lock In */}
          <label htmlFor="odds-pvp-prediction" className="sr-only">Your prediction 1–{range}</label>
          <input
            id="odds-pvp-prediction"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            className="odds-input odds-chamfer mt-3 w-full p-3.5 text-center text-3xl placeholder-white/20"
            placeholder={`1–${range}`}
            value={predictValue}
            onChange={handlePredictInputChange}
            onKeyDown={handleKeyDown}
            disabled={isSubmitting}
          />
          <button
            onClick={handleSubmitPredict}
            disabled={isSubmitting || predictValue === ""}
            className="odds-chamfer odds-label mt-2 w-full bg-fuchsia-400 px-6 py-3.5 text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {isSubmitting ? "locking in…" : "lock in"}
          </button>

            {/* Emotes */}
            <div className="mt-4 flex justify-center">
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
        </div>
      )}

      {/* WAITING FOR OPPONENT — the pick/predict card hides once you've
          locked in; a compact banner shows while the opponent catches up */}
      {interactiveState && !gameOver && waitingForOpponent && (
        <div className="odds-hud odds-chamfer odds-board-bg p-4 text-center">
          <p className="odds-label flex items-center justify-center gap-1.5 text-[#f5ff3b]">
            <IconHourglass size={13} />{" "}
            {interactiveState.phase === "predict"
              ? "waiting for opponent to predict"
              : "waiting for opponent to pick"}
          </p>
          <p className="odds-label mt-2 text-white/40">
            round {interactiveState.currentRound}/{interactiveState.totalRounds} ·{" "}
            {interactiveState.phase === "predict"
              ? "your prediction is locked"
              : "your number is locked"}
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
      </>
      )}
    </div>
  );
}

// ─── Pick History Strip ────────────────────────────────────────────────────
// Compact per-round summary of each player's PICKED numbers so players can
// spot the opponent's tendencies themselves. Shows raw numbers only — no
// pattern detection or hints are computed or surfaced.
//
// Two single-line readouts, not two wrapping clouds of chips: this strip sits
// above the input on every round, so every pixel of its height is a pixel the
// player has to scroll past. Each line scrolls sideways once six rounds stop
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
  if (rounds.length === 0) return null;
  const userPoss = userLabel === "You" ? "Your" : `${userLabel}'s`;

  const line = (
    label: string,
    tone: "cyan" | "amber",
    valueOf: (round: GameRound) => number,
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
        {rounds.map((round, index) => (
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
        `${oppLabel} picks`,
        "cyan",
        (round) => (isPlayer1 ? round.player2Number : round.player1Number),
      )}
      {line(
        `${userPoss} picks`,
        "amber",
        (round) => (isPlayer1 ? round.player1Number : round.player2Number),
      )}
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
  onPlayAgain,
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
  oppIconKey?: string | null;
  oppProfileFrame?: unknown;
  oppNameColor?: string | null;
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
    <div className="space-y-3">
      {/* Board readout: the two scores plus the live telemetry every HUD
          readout needs (which round, how wide the window still is). The range
          bar collapses as the window halves, so the shrinking range — the
          game's whole tension curve — is visible at a glance. */}
      <div className="odds-hud odds-chamfer odds-board-bg p-2.5">
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="odds-label text-cyan-300/70">
            round {gameState.currentRound}/{gameState.totalRounds}
          </span>
          <span className="odds-label text-white/35">window 1–{gameState.currentMax}</span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="odds-hud odds-chamfer odds-hud--amber px-3 py-2">
            <p className="odds-label truncate text-[#f5ff3b]/70">{userLabel}</p>
            <p className="odds-readout mt-1 text-3xl text-[#f5ff3b] drop-shadow-[0_0_14px_rgba(245,255,59,0.45)]">
              {myPts}
            </p>
          </div>
          <div className="odds-hud odds-chamfer px-3 py-2">
            <p className="odds-label truncate text-cyan-300/70">{oppLabel}</p>
            <p className="odds-readout mt-1 text-3xl text-cyan-200 drop-shadow-[0_0_14px_rgba(0,229,255,0.4)]">
              {oppPts}
            </p>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2 px-1">
          <span className="odds-label shrink-0 text-white/30">range</span>
          <div className="h-1 min-w-0 flex-1 bg-white/10">
            <div
              className="odds-range-bar"
              style={{
                width: `${Math.max(2, Math.min(100, (gameState.currentMax / 100) * 100))}%`,
              }}
            />
          </div>
          <span className="odds-readout shrink-0 text-[10px] text-white/40">
            {Math.round((gameState.currentMax / 100) * 100)}%
          </span>
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
            transition={{ duration: 0.25 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.8, y: 30 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.8, y: 30 }}
              transition={{ type: "spring", stiffness: 260, damping: 22, delay: 0.1 }}
              className="odds-hud odds-chamfer odds-hud--amber odds-board-bg w-full max-w-md p-5 text-center"
            >
              <p className="odds-label text-[#f5ff3b]/70">
                round {revealedRounds} result
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
              <p className="odds-label mt-2 text-white/40">
                window 1–{latestRound?.max} · {userLabel} +{breakdown.myPts} ·{" "}
                {oppLabel} +{breakdown.oppPts}
              </p>

              <div className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                <div className="odds-hud odds-chamfer odds-hud--amber p-3">
                  <p className="odds-label text-[#f5ff3b]/70">{userPoss} read</p>
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-[11px] text-white/45">prediction</span>
                    <span className="odds-readout text-white">{breakdown.myPred}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-white/45">their number</span>
                    <span className="odds-readout text-white">{breakdown.oppActual}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-white/45">off by</span>
                    <span className="odds-readout text-white">{breakdown.myDiff}</span>
                  </div>
                  <p className="odds-readout mt-1.5 text-right text-[#f5ff3b]">+{breakdown.myPts}</p>
                </div>
                <div className="odds-hud odds-chamfer p-3">
                  <p className="odds-label text-cyan-300/70">{oppPoss} read</p>
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-[11px] text-white/45">prediction</span>
                    <span className="odds-readout text-white">{breakdown.oppPred}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-white/45">your number</span>
                    <span className="odds-readout text-white">{breakdown.myActual}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-white/45">off by</span>
                    <span className="odds-readout text-white">{breakdown.oppDiff}</span>
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
  const ordered = rounds.map((round, index) => ({ round, index })).reverse();
  // Seven columns: round, the four numbers, the points pair, and the verdict.
  // One line per round, so a round costs ~2rem of height instead of ~15rem.
  const grid =
    "grid grid-cols-[1.6rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_3rem_2.4rem] items-center gap-1.5";

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
            <span className="odds-label text-[#f5ff3b]/60">your pick</span>
            <span className="odds-label text-cyan-300/60">{oppLabel} pick</span>
            <span className="odds-label text-fuchsia-300/60">your pred</span>
            <span className="odds-label text-fuchsia-300/45">{oppLabel} pred</span>
            <span className="odds-label text-right text-white/25">pts</span>
            <span className="odds-label text-right text-white/25">out</span>
          </div>

          {ordered.map(({ round, index }) => {
            const visible = index < revealedRounds;
            const myPts = isPlayer1 ? round.player1Score : round.player2Score;
            const oppPts = isPlayer1 ? round.player2Score : round.player1Score;
            const roundWon =
              round.roundWinner === "draw"
                ? null
                : round.roundWinner === (isPlayer1 ? "player1" : "player2");
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
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3, delay: visible ? 0.05 : 0 }}
                className={`${grid} border-b border-white/5 px-3 py-2 last:border-b-0`}
              >
                <span className="odds-label text-white/35">R{index + 1}</span>

                {visible ? (
                  <>
                    <span className="odds-readout text-center text-sm text-[#f5ff3b]">
                      {isPlayer1 ? round.player1Number : round.player2Number}
                    </span>
                    <span className="odds-readout text-center text-sm text-cyan-200">
                      {isPlayer1 ? round.player2Number : round.player1Number}
                    </span>
                    <span className="odds-readout text-center text-sm text-fuchsia-300">
                      {isPlayer1 ? round.player1Prediction : round.player2Prediction}
                    </span>
                    <span className="odds-readout text-center text-sm text-fuchsia-300/70">
                      {isPlayer1 ? round.player2Prediction : round.player1Prediction}
                    </span>
                  </>
                ) : (
                  <span className="odds-label col-span-4 text-white/20">
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
