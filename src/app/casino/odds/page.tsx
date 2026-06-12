"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import NavigationBar from "../../../components/navigation-bar";
import ReportModal from "../../../components/ReportModal";
import { useSocket } from "../../../context/SocketProvider";
import { celebrateWin } from "../../../lib/animations";
import { useOddsAudio } from "../../../lib/oddsAudio";
import type {
  InteractiveOddsState as InteractiveOddsStateType,
  PvPInteractiveOddsState,
} from "../../../lib/odds";

type GameRound = {
  max: number;
  starter: "player1" | "player2";
  player1Number: number;
  player2Number: number;
  matched: boolean;
};

type GameState = {
  rounds: GameRound[];
  totalRounds: number;
  winner: string;
  result: string;
  payout: number;
  firstStarter: "player1" | "player2";
};

type PvPInteractiveState = PvPInteractiveOddsState;

export default function OddsPage() {
  const [mode, setMode] = useState<"ai" | "pvp">("pvp");
  const audio = useOddsAudio();

  return (
    <div
      className="relative flex min-h-screen flex-col items-center justify-start overflow-x-clip px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8"
      style={{ backgroundImage: "linear-gradient(135deg, #020617 0%, #020617 40%, #0f172a 100%)" }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(250,204,21,0.12),transparent_70%)] pointer-events-none" />
      <NavigationBar currentPath="/casino" />
      <div className="mt-6 w-full max-w-2xl rounded-xl border border-yellow-400/30 bg-[#0b224f]/85 p-4 text-white shadow-[0_0_24px_rgba(250,204,21,0.15)] sm:mt-10 sm:p-6">
        <h1 className="mb-2 text-center text-2xl font-extrabold tracking-wide text-yellow-400 sm:text-3xl">
          🎲 Odds Game
        </h1>
        <p className="mb-6 text-center text-sm text-white/60">
          Numbers match → challenger loses. No match → reverse roles. Still no match → odds halve.
        </p>

        <div className="mb-6 grid grid-cols-2 gap-2 sm:flex sm:justify-center sm:space-x-4 sm:gap-0">
          <button
            className={`px-4 py-2 rounded font-semibold ${
              mode === "pvp"
                ? "bg-gradient-to-r from-yellow-500 to-amber-500 text-black shadow-[0_0_14px_rgba(250,204,21,0.5)]"
                : "bg-[#0d335f] hover:bg-[#144a85]"
            }`}
            onClick={() => setMode("pvp")}
          >
            PvP
          </button>
          <button
            className={`px-4 py-2 rounded font-semibold ${
              mode === "ai"
                ? "bg-gradient-to-r from-yellow-500 to-amber-500 text-black shadow-[0_0_14px_rgba(250,204,21,0.5)]"
                : "bg-[#0d335f] hover:bg-[#144a85]"
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
  const [roundHistory, setRoundHistory] = useState<GameRound[]>([]);
  const [pickValue, setPickValue] = useState("");
  const [autoPick, setAutoPick] = useState(false);
  const [timeLeft, setTimeLeft] = useState(PICK_TIMER_SECONDS);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [showReverse, setShowReverse] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [finalWinner, setFinalWinner] = useState<"player1" | "player2">("player1");
  const [finalResult, setFinalResult] = useState<"player1_won" | "player2_won">("player1_won");
  const [finalPayout, setFinalPayout] = useState(0);
  const [timeUp, setTimeUp] = useState(false);
  const [resuming, setResuming] = useState(true);

  // Wrap handlePick in a ref so timer/autopick effects can call it without stale closures
  const handlePickRef = useRef<(n: number) => void>(() => {});
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
        setTimeLeft(PICK_TIMER_SECONDS);
        setTimeUp(false);
        autoPickTriggeredRef.current = false;

        if (st?.gameOver) {
          setGameOver(true);
          setFinalWinner(st.winner ?? "player1");
          setFinalResult(
            st.winner === "player1" ? "player1_won" : "player2_won",
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
    setTimeLeft(PICK_TIMER_SECONDS);
    setGameOver(false);
    setShowReverse(false);
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
    } catch (err: any) {
      setError(err.message || "Error starting game");
    } finally {
      setLoading(false);
    }
  };

  const handlePick = useCallback(async (number: number) => {
    if (!gameId || !interactiveState || isSubmitting || gameOver) return;
    autoPickTriggeredRef.current = true; // prevent double-trigger
    setIsSubmitting(true);
    setError("");
    audio.playPick();
    try {
      const res = await fetch("/api/odds/ai/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId, playerNumber: number }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      if (!mountedRef.current) return;

      const newRound: GameRound = data.data.round;
      const updatedState = data.data.updatedState;

      setRoundHistory((prev) => [...prev, newRound]);
      setInteractiveState(updatedState);

      // Show reverse popup if applicable
      if (data.data.isReverse) {
        setShowReverse(true);
        setTimeout(() => setShowReverse(false), 1200);
      }

      // 🎵 Sound effects
      if (data.data.matched) {
        audio.playMatch();
      } else if (data.data.isReverse) {
        audio.playReverse();
      } else if (data.data.halved) {
        audio.playHalve();
      }

      if (data.data.gameStatus === "finished") {
        const winner = updatedState.winner || (data.data.matched ? updatedState.currentStarter : "player2");
        const isPlayer1Win = winner === "player1";
        
        // Block further picks immediately
        setGameOver(true);
        gameOverRef.current = true;
        autoPickTriggeredRef.current = true;

        setFinalWinner(winner as "player1" | "player2");
        setFinalResult(isPlayer1Win ? "player1_won" : "player2_won");
        setFinalPayout(data.data.payout || 0);
        
        if (isPlayer1Win) {
          setTimeout(() => {
            if (mountedRef.current) {
              celebrateWin();
              audio.playVictory();
            }
          }, 400);
        } else {
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
  }, [gameId, interactiveState, isSubmitting, gameOver]);

  // Keep ref in sync
  useEffect(() => {
    handlePickRef.current = handlePick;
  }, [handlePick]);

  // Timer countdown
  const timerUrgentPlayed = useRef(false);
  useEffect(() => {
    if (!interactiveState || gameOver || isSubmitting) return;
    if (timeLeft <= 0) {
      setTimeUp(true);
      timerUrgentPlayed.current = false;
      const range = interactiveState.currentMax;
      handlePickRef.current(Math.floor(Math.random() * range) + 1);
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
      handlePickRef.current(Math.floor(Math.random() * range) + 1);
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

  const handlePickInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    // Only allow digits (no decimals, no negatives)
    if (val === "" || /^\d+$/.test(val)) {
      const range = interactiveState?.currentMax ?? 100;
      const num = parseInt(val, 10);
      // Prevent entering numbers above range
      if (val === "" || (num >= 1 && num <= range)) {
        setPickValue(val);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSubmitPick();
  };

  // Build a synthetic GameState for the display component
  const displayGameState: GameState | null = useMemo(() => {
    if (!interactiveState || roundHistory.length === 0) return null;
    return {
      rounds: roundHistory,
      totalRounds: roundHistory.length,
      winner: gameOver ? finalWinner : "player1",
      result: gameOver ? finalResult : "player1_won",
      payout: gameOver ? finalPayout : wager * 2,
      firstStarter: interactiveState.firstStarter,
    };
  }, [interactiveState, roundHistory, gameOver, finalWinner, finalResult, finalPayout, wager]);

  const handlePlayAgain = () => {
    setGameId(null);
    setInteractiveState(null);
    setRoundHistory([]);
    setPickValue("");
    setGameOver(false);
    setShowReverse(false);
    setFinalPayout(0);
    setError("");
    setTimeLeft(PICK_TIMER_SECONDS);
  };

  const range = interactiveState?.currentMax ?? 100;
  const isUserStarter = interactiveState?.currentStarter === "player1";
  const userWon = gameOver && finalWinner === "player1";

  return (
    <div>
      {resuming && (
        <p className="text-center text-white/40 py-8">Loading...</p>
      )}

      {!resuming && !gameId && (
        <>
          <label className="block mb-1 text-sm font-semibold">Wager Amount</label>
          <input
            type="number"
            className="w-full bg-[#08142f] border border-yellow-400/30 p-2 rounded mb-4 text-white"
            value={wager}
            onChange={(e) => setWager(Number(e.target.value))}
            min={1}
          />
          <button
            onClick={startGame}
            disabled={loading}
            className="w-full p-3 rounded font-bold text-lg bg-gradient-to-r from-yellow-500 to-amber-500 text-black hover:scale-105 transition shadow-[0_0_18px_rgba(250,204,21,0.5)]"
          >
            {loading ? "Starting..." : "🎲 Play vs AI"}
          </button>
          {error && <p className="mt-3 text-center text-red-400">{error}</p>}
        </>
      )}

      {gameId && interactiveState && !gameOver && (
        <div className="space-y-4">
          {/* Round info header */}
          <div className="text-center">
            <p className="text-sm text-white/50">Wager: {wager} 🪙</p>
            <div className="mt-2 inline-block rounded-full bg-yellow-500/20 border border-yellow-400/30 px-6 py-2">
              <span className="text-sm text-yellow-300/70">Pick a number</span>
              <p className="text-2xl font-black text-yellow-400">1 – {range}</p>
            </div>
            <p className="mt-1 text-xs text-white/30">
              Round {roundHistory.length + 1} •{" "}
              {isUserStarter
                ? <span className="text-yellow-400 font-semibold">You are the Starter ⭐</span>
                : <span className="text-blue-400 font-semibold">You are the Challenger 🎯</span>
              }
            </p>
          </div>

          {/* Timer */}
          <div className="flex items-center justify-center">
            <div
              className={`rounded-full border px-4 py-1 text-lg font-bold transition-colors ${
                timeLeft <= 5
                  ? "border-red-500/50 text-red-400 animate-pulse"
                  : "border-white/10 text-white/60"
              }`}
            >
              ⏱ {timeLeft}s
            </div>
          </div>

          {/* Time's up indicator */}
          {timeUp && isSubmitting && (
            <p className="text-center text-sm text-amber-400 animate-pulse">
              ⏰ Time's up! Auto-picking...
            </p>
          )}

          {/* Number input + Pick button */}
          <div className="flex items-center gap-3">
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              className="flex-1 rounded-lg border border-yellow-400/30 bg-[#08142f] p-3 text-center text-lg font-bold text-white placeholder-white/20"
              placeholder={`1–${range}`}
              value={pickValue}
              onChange={handlePickInputChange}
              onKeyDown={handleKeyDown}
              disabled={isSubmitting || autoPick}
            />
            <button
              onClick={handleSubmitPick}
              disabled={isSubmitting || autoPick || pickValue === ""}
              className="rounded-lg bg-gradient-to-r from-yellow-500 to-amber-500 px-6 py-3 font-bold text-black transition hover:scale-105 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {isSubmitting ? "..." : "Pick"}
            </button>
          </div>

          {/* Sound toggle */}
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => audio.setEnabled(!audio.enabled)}
              className={`rounded-full border px-3 py-1 text-sm transition ${
                audio.enabled
                  ? "border-white/10 text-white/60 hover:text-white"
                  : "border-red-400/40 text-red-400/60"
              }`}
              title={audio.enabled ? "Sounds on" : "Sounds off"}
            >
              {audio.enabled ? "🔊" : "🔇"}
            </button>
          </div>

          {/* Autopick toggle */}
          <div className="flex items-center justify-center gap-3">
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
            <p className="text-center text-sm text-red-400">{error}</p>
          )}
        </div>
      )}

      {/* Round history */}
      {roundHistory.length > 0 && displayGameState && (
        <div className="mt-6">
          <OddsGameDisplay
            gameState={displayGameState}
            revealedRounds={roundHistory.length}
            gameOver={gameOver}
            userWon={userWon}
            isPlayer1={true}
            userLabel="You"
            oppLabel="AI"
            wager={wager}
            payout={displayGameState.payout}
            showReverse={showReverse}
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
  const [timeLeft, setTimeLeft] = useState(PICK_TIMER_SECONDS);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [waitingForOpponent, setWaitingForOpponent] = useState(false);
  const [error, setError] = useState("");
  const [showReverse, setShowReverse] = useState(false);
  const [timeUp, setTimeUp] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [finalWinner, setFinalWinner] = useState<"player1" | "player2">("player1");
  const [finalResult, setFinalResult] = useState<"player1_won" | "player2_won">("player1_won");
  const [finalPayout, setFinalPayout] = useState(0);
  const [showReportModal, setShowReportModal] = useState(false);
  const [showForfeitConfirm, setShowForfeitConfirm] = useState(false);
  const [forfeiting, setForfeiting] = useState(false);
  const [resuming, setResuming] = useState(true);

  // Refs for timer/autopick
  const handlePickRef = useRef<(n: number) => void>(() => {});
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
        setTimeLeft(PICK_TIMER_SECONDS);
        setTimeUp(false);
        setError("");
        setMessage("");

        if (d.userHasPendingPick) {
          setWaitingForOpponent(true);
        }

        if (d.gameOver) {
          setGameOver(true);
          setFinalWinner(d.winner ?? "player1");
          setFinalResult(
            d.winner === "player1" ? "player1_won" : "player2_won",
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
      const st = serverData.gameState as PvPInteractiveState | null;
      if (!st) return;

      const myIsPlayer1 = isPlayer1Ref.current;

      setInteractiveState(st);
      setRoundHistory(st.rounds ?? []);
      setWaitingForOpponent(
        !st.gameOver &&
          ((myIsPlayer1 && st.player1Pick !== null && st.player2Pick === null) ||
            (!myIsPlayer1 && st.player2Pick !== null && st.player1Pick === null)),
      );
      // Only clear pickValue when a new round actually started
      const newRoundCount = (st.rounds ?? []).length;
      if (newRoundCount !== roundCountRef.current) {
        roundCountRef.current = newRoundCount;
        setPickValue("");
      }
      setTimeLeft(PICK_TIMER_SECONDS);
      setTimeUp(false);

      if (st.gameOver) {
        setGameOver(true);
        gameOverRef.current = true;
        setFinalWinner(st.winner!);
        setFinalResult(
          st.winner === "player1" ? "player1_won" : "player2_won",
        );
        setFinalPayout(serverData.payout ?? serverData.wager * 2);
        const iWon =
          (myIsPlayer1 && st.winner === "player1") ||
          (!myIsPlayer1 && st.winner === "player2");
        if (iWon) {
          setTimeout(() => celebrateWin(), 400);
          setTimeout(() => audio.playVictory(), 200);
        } else {
          setTimeout(() => audio.playDefeat(), 200);
        }
      }
    },
    [],
  );

  // ── Socket: listen for opponent events when playing ──
  useEffect(() => {
    if (!socket || !myGameId) return;

    // Direct game state update from opponent (no refetch needed)
    const handleGameUpdate = (data: any) => {
      if (!mountedRef.current) return;
      if (data?.gameState) {
        applyStateFromServer({
          gameState: data.gameState,
          payout: data.payout,
          wager: data.wager ?? (wagerLockedRef.current ?? 50),
        });
      }
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
      setShowReverse(false);
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
    setShowReverse(false);
    setWagerLocked(null);
    setOpponentId(null);
    setIsPlayer1(true);
    setMessage("");
    setError("");
    setWaitingForOpponent(false);
    setPickValue("");
    setTimeLeft(PICK_TIMER_SECONDS);
    setFinalPayout(0);
    setShowForfeitConfirm(false);
    roundCountRef.current = 0;
  };

  // ── Pick handling ──
  const handlePick = useCallback(
    async (number: number) => {
      if (!myGameId || !interactiveState || isSubmitting || gameOver) return;
      setIsSubmitting(true);
      setError("");
      audio.playPick();
      try {
        const res = await fetch("/api/odds/pvp/pick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gameId: myGameId, playerNumber: number }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        if (!mountedRef.current) return;

        applyStateFromServer({
          gameState: data.data.gameState,
          payout: data.data.payout,
          wager: wagerLocked ?? wager,
        });

        if (data.data.resolved) {
          // Round was resolved (both picks in)  
          const gameRounds: GameRound[] = data.data.gameState?.rounds ?? [];
          const lastRound = gameRounds[gameRounds.length - 1];
          if (lastRound?.matched) {
            audio.playMatch();
          } else if (gameRounds.length >= 2) {
            const prevRound = gameRounds[gameRounds.length - 2];
            const currRound = lastRound;
            if (currRound.max === prevRound.max && currRound.starter !== prevRound.starter) {
              audio.playReverse();
              setShowReverse(true);
              setTimeout(() => setShowReverse(false), 1200);
            } else if (currRound.max < prevRound.max) {
              audio.playHalve();
            }
          }
          setWaitingForOpponent(false);
        } else {
          // Waiting for opponent
          setWaitingForOpponent(true);
        }

        // Notify opponent via socket with full game state
        if (socket && myGameId) {
          const payloadToSend = {
            gameState: data.data.gameState,
            payout: data.data.payout,
            wager: wagerLocked ?? wager,
          };
          // Primary: direct state push to opponent
          socket.emit("room_event", {
            roomId: `odds_${myGameId}`,
            event: "odds:game_update",
            payload: payloadToSend,
          });
          // Fallback: trigger opponent to refetch from API
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
            setPickValue("");
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

  // Keep ref in sync
  useEffect(() => {
    handlePickRef.current = handlePick;
  }, [handlePick]);

  // Timer
  const timerUrgentPlayed = useRef(false);
  useEffect(() => {
    if (!interactiveState || gameOver || isSubmitting || waitingForOpponent)
      return;
    if (timeLeft <= 0) {
      setTimeUp(true);
      timerUrgentPlayed.current = false;
      const range = interactiveState.currentMax;
      handlePickRef.current(Math.floor(Math.random() * range) + 1);
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSubmitPick();
  };

  // ── Display helpers ──
  const displayGameState: GameState | null = useMemo(() => {
    if (!interactiveState || roundHistory.length === 0) return null;
    return {
      rounds: roundHistory,
      totalRounds: roundHistory.length,
      winner: gameOver ? finalWinner : "player1",
      result: gameOver ? finalResult : "player1_won",
      payout: gameOver ? finalPayout : (wagerLocked ?? wager) * 2,
      firstStarter: interactiveState.firstStarter,
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
  const range = interactiveState?.currentMax ?? 100;
  const alreadyPicked =
    !gameOver &&
    interactiveState &&
    ((isPlayer1 && interactiveState.player1Pick !== null) ||
      (!isPlayer1 && interactiveState.player2Pick !== null));
  // Shortcuts
  const gameId = myGameId;

  const showPickUI = gameId && interactiveState && !gameOver && !alreadyPicked && !waitingForOpponent;

  // ── Render ──
  return (
    <div>
      {resuming && (
        <p className="text-center text-white/40 py-8">Loading...</p>
      )}

      {/* LOBBY: no game yet */}
      {!resuming && !gameId && !interactiveState && (
        <>
          <label className="block mb-1 text-sm font-semibold">
            Wager Amount
          </label>
          <input
            type="number"
            className="w-full bg-[#08142f] border border-yellow-400/30 p-2 rounded mb-4 text-white"
            value={wager}
            onChange={(e) => setWager(Number(e.target.value))}
            min={1}
          />
          <button
            onClick={createGame}
            disabled={loading}
            className="w-full p-3 rounded font-bold text-lg bg-gradient-to-r from-yellow-500 to-amber-500 text-black hover:scale-105 transition shadow-[0_0_18px_rgba(250,204,21,0.5)] mb-6"
          >
            {loading ? "Creating..." : "🎲 Create PvP Game"}
          </button>

          <h2 className="text-lg font-bold mb-3">Available Games</h2>
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
                  className="bg-gray-900 border border-yellow-400/20 rounded-lg p-4 flex justify-between items-center"
                >
                  <div>
                    <p className="font-bold text-white">
                      {game.player1Name}
                    </p>
                    <p className="text-sm text-white/50">
                      Wager: {game.wager} 🪙
                    </p>
                  </div>
                  <button
                    onClick={() => joinGame(game.id)}
                    disabled={loading}
                    className="px-4 py-2 rounded-lg font-bold bg-gradient-to-r from-emerald-400 to-green-500 text-black shadow-[0_0_12px_rgba(16,185,129,0.5)]"
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
            🎲
          </motion.div>
          <p className="text-lg font-bold text-yellow-300">
            {message || "Waiting for opponent..."}
          </p>
          <p className="text-sm text-white/40 mt-2">
            Wager: {wagerLocked} 🪙
          </p>
          <button
            onClick={cancelGame}
            className="mt-6 px-6 py-2 rounded-lg font-bold bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/30"
          >
            Cancel
          </button>
        </div>
      )}

      {/* PLAYING: pick UI */}
      {showPickUI && (
        <div className="space-y-4">
          <div className="text-center">
            <p className="text-sm text-white/50">
              Wager: {wagerLocked ?? wager} 🪙
            </p>
            <div className="mt-2 inline-block rounded-full bg-yellow-500/20 border border-yellow-400/30 px-6 py-2">
              <span className="text-sm text-yellow-300/70">
                Pick a number
              </span>
              <p className="text-2xl font-black text-yellow-400">
                1 – {range}
              </p>
            </div>
            <p className="mt-1 text-xs text-white/30">
              Round {(roundHistory.length || 0) + 1} •{" "}
              {(isPlayer1 ? interactiveState.currentStarter === "player1" : interactiveState.currentStarter === "player2")
                ? <span className="text-yellow-400 font-semibold">You are the Starter ⭐</span>
                : <span className="text-blue-400 font-semibold">You are the Challenger 🎯</span>
              }
            </p>
          </div>

          <div className="flex items-center justify-center">
            <div
              className={`rounded-full border px-4 py-1 text-lg font-bold transition-colors ${
                timeLeft <= 5
                  ? "border-red-500/50 text-red-400 animate-pulse"
                  : "border-white/10 text-white/60"
              }`}
            >
              ⏱ {timeLeft}s
            </div>
          </div>

          {timeUp && isSubmitting && (
            <p className="text-center text-sm text-amber-400 animate-pulse">
              ⏰ Time's up! Auto-picking...
            </p>
          )}

          <div className="flex items-center gap-3">
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              className="flex-1 rounded-lg border border-yellow-400/30 bg-[#08142f] p-3 text-center text-lg font-bold text-white placeholder-white/20"
              placeholder={`1–${range}`}
              value={pickValue}
              onChange={handlePickInputChange}
              onKeyDown={handleKeyDown}
              disabled={isSubmitting}
            />
            <button
              onClick={handleSubmitPick}
              disabled={isSubmitting || pickValue === ""}
              className="rounded-lg bg-gradient-to-r from-yellow-500 to-amber-500 px-6 py-3 font-bold text-black transition hover:scale-105 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {isSubmitting ? "..." : "Pick"}
            </button>
          </div>

          {error && (
            <p className="text-center text-sm text-red-400">{error}</p>
          )}

          {/* Sound toggle + Forfeit */}
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => audio.setEnabled(!audio.enabled)}
              className={`rounded-full border px-3 py-1 text-sm transition ${
                audio.enabled
                  ? "border-white/10 text-white/60 hover:text-white"
                  : "border-red-400/40 text-red-400/60"
              }`}
              title={audio.enabled ? "Sounds on" : "Sounds off"}
            >
              {audio.enabled ? "🔊" : "🔇"}
            </button>
            <button
              onClick={() => setShowForfeitConfirm(true)}
              className="rounded-full border border-red-400/30 px-3 py-1 text-sm text-red-400/70 hover:bg-red-500/10 hover:text-red-300 transition"
              title="Forfeit game"
            >
              🏳️ Forfeit
            </button>
          </div>

          {/* Forfeit confirmation */}
          {showForfeitConfirm && (
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
      )}

      {/* WAITING FOR OPPONENT after own pick */}
      {interactiveState && !gameOver && waitingForOpponent && (
        <div className="text-center py-8">
          <motion.div
            animate={{ scale: [1, 1.05, 1] }}
            transition={{ repeat: Infinity, duration: 1.5 }}
            className="text-4xl mb-4"
          >
            ⏳
          </motion.div>
          <p className="text-lg font-bold text-yellow-300">
            Waiting for opponent to pick...
          </p>
          {interactiveState && (
            <p className="text-xs text-white/40 mt-1">
              {(isPlayer1 ? interactiveState.currentStarter === "player1" : interactiveState.currentStarter === "player2")
                ? <span className="text-yellow-400">You are the Starter ⭐</span>
                : <span className="text-blue-400">You are the Challenger 🎯</span>
              }
            </p>
          )}
          <p className="text-sm text-white/40 mt-2">
            Your number has been submitted!
          </p>

          {/* Forfeit from waiting state */}
          <div className="mt-4 flex flex-col items-center gap-2">
            {!showForfeitConfirm ? (
              <button
                onClick={() => setShowForfeitConfirm(true)}
                className="rounded-full border border-red-400/30 px-3 py-1 text-sm text-red-400/70 hover:bg-red-500/10 hover:text-red-300 transition"
              >
                🏳️ Forfeit
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

      {/* Round history */}
      {roundHistory.length > 0 && displayGameState && (
        <div className="mt-6">
          <OddsGameDisplay
            gameState={displayGameState}
            revealedRounds={roundHistory.length}
            gameOver={gameOver}
            userWon={userWon}
            isPlayer1={isPlayer1}
            userLabel="You"
            oppLabel="Opponent"
            wager={wagerLocked ?? wager}
            payout={displayGameState.payout}
            showReverse={showReverse}
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
            🚩 Report
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

// ─── Shared Game Display Component ─────────────────────────────────────────
function OddsGameDisplay({
  gameState,
  revealedRounds,
  gameOver,
  userWon,
  isPlayer1,
  userLabel,
  oppLabel,
  wager,
  payout,
  showReverse,
  onPlayAgain,
}: {
  gameState: GameState;
  revealedRounds: number;
  gameOver: boolean;
  userWon: boolean;
  isPlayer1: boolean;
  userLabel: string;
  oppLabel: string;
  wager: number;
  payout: number;
  showReverse: boolean;
  onPlayAgain: () => void;
}) {
  const isUserStarter = (round: GameRound) =>
    isPlayer1 ? round.starter === "player1" : round.starter === "player2";

  return (
    <div className="space-y-4">
      {/* Current range indicator */}
      <div className="text-center">
        <div className="inline-block rounded-full bg-yellow-500/20 border border-yellow-400/30 px-6 py-2">
          <span className="text-sm text-yellow-300/70">Current Range</span>
          <p className="text-2xl font-black text-yellow-400">
            1 – {revealedRounds > 0 ? gameState.rounds[revealedRounds - 1]?.max ?? 100 : 100}
          </p>
        </div>
      </div>

      {/* Reverse popup overlay */}
      <AnimatePresence>
        {showReverse && (
          <motion.div
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.5 }}
            transition={{ type: "spring", stiffness: 300, damping: 15 }}
            className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
          >
            <motion.div
              animate={{ rotate: [0, 10, -10, 5, -5, 0] }}
              transition={{ duration: 0.6, delay: 0.1 }}
              className="rounded-2xl bg-black/80 backdrop-blur-md border-2 border-purple-400/50 px-10 py-6 shadow-[0_0_60px_rgba(168,85,247,0.5)]"
            >
              <div className="flex items-center gap-4">
                <motion.span
                  animate={{ rotate: [0, 180] }}
                  transition={{ duration: 0.6, ease: "easeInOut" }}
                  className="text-4xl"
                >
                  🔄
                </motion.span>
                <span className="text-3xl font-black bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
                  REVERSE!
                </span>
                <motion.span
                  animate={{ rotate: [0, -180] }}
                  transition={{ duration: 0.6, ease: "easeInOut" }}
                  className="text-4xl"
                >
                  🔄
                </motion.span>
              </div>
              <p className="text-center text-sm text-purple-300/80 mt-2">Roles swapped!</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* First starter info */}
      {revealedRounds > 0 && (
        <div className="text-center">
          <span className="text-xs text-white/30">
            First starter: {gameState.firstStarter === (isPlayer1 ? "player1" : "player2") ? userLabel : oppLabel}
          </span>
        </div>
      )}

      {/* Rounds display (newest first) */}
      <div className="space-y-3">
        {[...gameState.rounds].reverse().map((round, reversedIdx) => {
          const originalIdx = gameState.rounds.length - 1 - reversedIdx;
          const visible = reversedIdx < revealedRounds;
          const isLastRound = originalIdx === gameState.rounds.length - 1;
          const userIsStarter = isUserStarter(round);
          const userIsChallenger = !userIsStarter;
          const prevRound = originalIdx > 0 ? gameState.rounds[originalIdx - 1] : null;
          const isReverse = prevRound && round.max === prevRound.max && round.starter !== prevRound.starter;

          return (
            <motion.div
              key={originalIdx}
              initial={{ opacity: 0, y: 20 }}
              animate={visible ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              transition={{ duration: 0.4 }}
              className={`rounded-xl border p-4 ${
                !visible
                  ? "border-white/5 bg-white/5"
                  : isLastRound && round.matched
                  ? "border-red-400/40 bg-red-900/20"
                  : isReverse
                  ? "border-purple-400/30 bg-purple-900/10"
                  : "border-yellow-400/20 bg-[#0a1a3a]"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-white/40">Round {originalIdx + 1}</span>
                  {visible && isReverse && (
                    <span className="text-xs font-bold text-purple-400 animate-pulse">🔄 REVERSE</span>
                  )}
                </div>
                <span className="text-xs font-bold text-yellow-400/60">Max: {round.max}</span>
              </div>

              {/* Role indicators */}
              {visible && (
                <div className="flex items-center justify-center gap-3 mb-2">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                    userIsStarter ? "bg-yellow-500/30 text-yellow-300" : "bg-white/10 text-white/40"
                  }`}>
                    {userIsStarter ? `⭐ Starter` : `Challenger`}
                  </span>
                  <span className="text-white/20">•</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                    !userIsStarter ? "bg-yellow-500/30 text-yellow-300" : "bg-white/10 text-white/40"
                  }`}>
                    {!userIsStarter ? `⭐ Starter` : `Challenger`}
                  </span>
                </div>
              )}

              {visible ? (
                <div className="flex items-center justify-center gap-6">
                  {/* Player number */}
                  <div className="text-center">
                    <p className="text-xs text-white/50 mb-1">{userLabel}</p>
                    <motion.div
                      key={`u-${originalIdx}`}
                      initial={{ scale: 0, rotate: -180 }}
                      animate={{ scale: 1, rotate: 0 }}
                      transition={{ type: "spring", stiffness: 300, damping: 15, delay: 0.1 }}
                      className={`w-14 h-14 rounded-full flex items-center justify-center text-xl font-black ${
                        round.matched
                          ? "bg-red-500 text-white shadow-[0_0_12px_rgba(239,68,68,0.5)]"
                          : userIsStarter
                          ? "bg-yellow-500 text-black shadow-[0_0_12px_rgba(250,204,21,0.4)]"
                          : "bg-purple-500 text-white shadow-[0_0_12px_rgba(168,85,247,0.3)]"
                      }`}
                    >
                      {isPlayer1 ? round.player1Number : round.player2Number}
                    </motion.div>
                  </div>

                  {/* VS */}
                  <div className="text-2xl font-black text-white/30">VS</div>

                  {/* Opponent number */}
                  <div className="text-center">
                    <p className="text-xs text-white/50 mb-1">{oppLabel}</p>
                    <motion.div
                      key={`o-${originalIdx}`}
                      initial={{ scale: 0, rotate: 180 }}
                      animate={{ scale: 1, rotate: 0 }}
                      transition={{ type: "spring", stiffness: 300, damping: 15, delay: 0.5 }}
                      className={`w-14 h-14 rounded-full flex items-center justify-center text-xl font-black ${
                        round.matched
                          ? "bg-red-500 text-white shadow-[0_0_12px_rgba(239,68,68,0.5)]"
                          : !userIsStarter
                          ? "bg-yellow-500 text-black shadow-[0_0_12px_rgba(250,204,21,0.4)]"
                          : "bg-blue-500 text-white shadow-[0_0_12px_rgba(59,130,246,0.4)]"
                      }`}
                    >
                      {isPlayer1 ? round.player2Number : round.player1Number}
                    </motion.div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-6">
                  <div className="w-14 h-14 rounded-full bg-white/5 flex items-center justify-center text-white/20 text-xl">?</div>
                  <div className="text-2xl font-black text-white/10">VS</div>
                  <div className="w-14 h-14 rounded-full bg-white/5 flex items-center justify-center text-white/20 text-xl">?</div>
                </div>
              )}

              {/* Match result */}
              {visible && round.matched && (
                <motion.p
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-2 text-center text-sm font-bold text-red-400"
                >
                  ⚡ MATCH! Challenger loses!
                </motion.p>
              )}
              {visible && !round.matched && isLastRound && (
                <motion.p
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-2 text-center text-sm text-white/40"
                >
                  {isReverse
                    ? "No match — halving range..."
                    : "No match — reversing roles..."}
                </motion.p>
              )}
            </motion.div>
          );
        })}
      </div>

      {/* Game over popup */}
      <AnimatePresence>
        {gameOver && (
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
                  : "border-red-400/40 bg-gradient-to-b from-red-900/50 via-[#0a1a3a]/95 to-black/95 shadow-[0_0_60px_rgba(239,68,68,0.3)]"
              }`}
            >
              <motion.div
                animate={userWon ? { scale: [1, 1.2, 1] } : {}}
                transition={{ duration: 0.5, delay: 0.3 }}
              >
                <p className="text-6xl mb-3">{userWon ? "🏆" : "😞"}</p>
              </motion.div>
              <motion.p
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className={`text-3xl font-black ${
                  userWon ? "text-yellow-400" : "text-red-400"
                }`}
              >
                {userWon ? "You Win!" : "You Lose"}
              </motion.p>
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.35 }}
                className="text-sm text-white/50 mt-3"
              >
                {userWon
                  ? `Payout: ${payout} 🪙`
                  : `${oppLabel} wins the pot of ${payout} 🪙`}
              </motion.p>
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.4 }}
                className="text-xs text-white/30 mt-1 mb-6"
              >
                Total rounds: {gameState.totalRounds}
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
