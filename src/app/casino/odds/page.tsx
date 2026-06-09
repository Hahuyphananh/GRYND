"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import NavigationBar from "../../../components/navigation-bar";
import ReportModal from "../../../components/ReportModal";
import { useSocket } from "../../../context/SocketProvider";
import { celebrateWin } from "../../../lib/animations";

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

export default function OddsPage() {
  const [mode, setMode] = useState<"ai" | "pvp">("pvp");

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

        {mode === "ai" ? <AIOddsGame /> : <PvPOddsGame />}
      </div>
    </div>
  );
}

// ─── AI Mode ───────────────────────────────────────────────────────────────
function AIOddsGame() {
  const [wager, setWager] = useState(50);
  const [loading, setLoading] = useState(false);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [revealedRounds, setRevealedRounds] = useState(0);
  const [showReverse, setShowReverse] = useState(false);
  const [error, setError] = useState("");

  const playGame = async () => {
    setLoading(true);
    setError("");
    setGameState(null);
    setRevealedRounds(0);
    setShowReverse(false);

    try {
      const res = await fetch("/api/odds/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wager, isAi: true }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to start game");
      setGameState(data.data.gameState);
    } catch (err: any) {
      setError(err.message || "Error starting game");
    } finally {
      setLoading(false);
    }
  };

  // Reveal rounds one at a time with reverse popup
  useEffect(() => {
    if (!gameState || revealedRounds >= gameState.rounds.length) return;
    const timer = setTimeout(() => {
      setRevealedRounds((r) => r + 1);
    }, 1400);
    return () => clearTimeout(timer);
  }, [gameState, revealedRounds]);

  // Show reverse popup when revealing the second sub-round of a pair
  useEffect(() => {
    if (!gameState || revealedRounds < 1) return;
    const round = gameState.rounds[revealedRounds - 1];
    const prevRound = revealedRounds >= 2 ? gameState.rounds[revealedRounds - 2] : null;
    // Show reverse when this round has same max as previous AND different starter
    if (prevRound && round.max === prevRound.max && round.starter !== prevRound.starter) {
      setShowReverse(true);
      const t = setTimeout(() => setShowReverse(false), 1200);
      return () => clearTimeout(t);
    }
  }, [gameState, revealedRounds]);

  // Celebrate on win
  useEffect(() => {
    if (gameState && revealedRounds >= gameState.rounds.length && gameState.winner === "player1") {
      const t = setTimeout(() => celebrateWin(), 400);
      return () => clearTimeout(t);
    }
  }, [gameState, revealedRounds]);

  const gameOver = gameState && revealedRounds >= gameState.rounds.length;
  const userWon = gameState?.winner === "player1";

  return (
    <div>
      {!gameState && (
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
            onClick={playGame}
            disabled={loading}
            className="w-full p-3 rounded font-bold text-lg bg-gradient-to-r from-yellow-500 to-amber-500 text-black hover:scale-105 transition shadow-[0_0_18px_rgba(250,204,21,0.5)]"
          >
            {loading ? "Rolling..." : "🎲 Play vs AI"}
          </button>
          {error && <p className="mt-3 text-center text-red-400">{error}</p>}
        </>
      )}

      {gameState && (
        <OddsGameDisplay
          gameState={gameState}
          revealedRounds={revealedRounds}
          gameOver={gameOver}
          userWon={userWon}
          isPlayer1={true}
          userLabel="You"
          oppLabel="AI"
          wager={wager}
          payout={gameState.payout}
          showReverse={showReverse}
          onPlayAgain={() => { setGameState(null); setRevealedRounds(0); }}
        />
      )}
    </div>
  );
}

// ─── PvP Mode ──────────────────────────────────────────────────────────────
function PvPOddsGame() {
  const { socket } = useSocket();
  const [wager, setWager] = useState(50);
  const [userId, setUserId] = useState<string | null>(null);
  const [games, setGames] = useState<any[]>([]);
  const [myGameId, setMyGameId] = useState<number | null>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [revealedRounds, setRevealedRounds] = useState(0);
  const [showReverse, setShowReverse] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [wagerLocked, setWagerLocked] = useState<number | null>(null);
  const [opponentId, setOpponentId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [isPlayer1, setIsPlayer1] = useState(true);

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

  // Reveal rounds one at a time
  useEffect(() => {
    if (!gameState || revealedRounds >= gameState.rounds.length) return;
    const timer = setTimeout(() => setRevealedRounds((r) => r + 1), 1400);
    return () => clearTimeout(timer);
  }, [gameState, revealedRounds]);

  // Show reverse popup
  useEffect(() => {
    if (!gameState || revealedRounds < 1) return;
    const round = gameState.rounds[revealedRounds - 1];
    const prevRound = revealedRounds >= 2 ? gameState.rounds[revealedRounds - 2] : null;
    if (prevRound && round.max === prevRound.max && round.starter !== prevRound.starter) {
      setShowReverse(true);
      const t = setTimeout(() => setShowReverse(false), 1200);
      return () => clearTimeout(t);
    }
  }, [gameState, revealedRounds]);

  // Mark game over when all rounds revealed
  useEffect(() => {
    if (gameState && revealedRounds >= gameState.rounds.length && !gameOver) {
      setGameOver(true);
      const iWon = isPlayer1 ? gameState.winner === "player1" : gameState.winner === "player2";
      if (iWon) setTimeout(() => celebrateWin(), 400);
    }
  }, [gameState, revealedRounds, gameOver, isPlayer1]);

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
      socket?.emit("room_event", { roomId: "lobby:odds", event: "lobby:updated" });
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
      setGameState(data.data.gameState);
      setRevealedRounds(0);
      setShowReverse(false);
      setGameOver(false);
      setMessage("");
      socket?.emit("room_event", { roomId: "lobby:odds", event: "lobby:updated" });
    } catch (err: any) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!myGameId || gameState) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/odds/status?gameId=${myGameId}`);
        const data = await res.json();
        if (data.success && data.data.status === "finished") {
          setGameState(data.data.gameState);
          setRevealedRounds(0);
          setShowReverse(false);
          setGameOver(false);
          if (data.data.player2Id) setOpponentId(data.data.player2Id);
        }
      } catch {}
    }, 1500);
    return () => clearInterval(interval);
  }, [myGameId, gameState]);

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
    setMessage("");
    socket?.emit("room_event", { roomId: "lobby:odds", event: "lobby:updated" });
  };

  const reset = () => {
    setMyGameId(null);
    setGameState(null);
    setGameOver(false);
    setRevealedRounds(0);
    setShowReverse(false);
    setWagerLocked(null);
    setOpponentId(null);
    setIsPlayer1(true);
    setMessage("");
  };

  const availableGames = games.filter((g) => g.player1Id !== userId && g.id !== myGameId);
  const userWon = gameState ? 
    (isPlayer1 ? gameState.winner === "player1" : gameState.winner === "player2") : false;

  return (
    <div>
      {!myGameId && !gameState && (
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
            onClick={createGame}
            disabled={loading}
            className="w-full p-3 rounded font-bold text-lg bg-gradient-to-r from-yellow-500 to-amber-500 text-black hover:scale-105 transition shadow-[0_0_18px_rgba(250,204,21,0.5)] mb-6"
          >
            {loading ? "Creating..." : "🎲 Create PvP Game"}
          </button>

          <h2 className="text-lg font-bold mb-3">Available Games</h2>
          {availableGames.length === 0 && (
            <p className="text-center text-white/40 italic">No games available. Create one!</p>
          )}
          <div className="space-y-3">
            {availableGames.map((game) => (
              <div key={game.id} className="bg-gray-900 border border-yellow-400/20 rounded-lg p-4 flex justify-between items-center">
                <div>
                  <p className="font-bold text-white">{game.player1Name}</p>
                  <p className="text-sm text-white/50">Wager: {game.wager} 🪙</p>
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
          {message && <p className="mt-3 text-center text-yellow-300">{message}</p>}
        </>
      )}

      {myGameId && !gameState && (
        <div className="text-center py-8">
          <motion.div
            animate={{ scale: [1, 1.05, 1] }}
            transition={{ repeat: Infinity, duration: 2 }}
            className="text-4xl mb-4"
          >
            🎲
          </motion.div>
          <p className="text-lg font-bold text-yellow-300">{message || "Waiting for opponent..."}</p>
          <p className="text-sm text-white/40 mt-2">Wager: {wagerLocked} 🪙</p>
          <button
            onClick={cancelGame}
            className="mt-6 px-6 py-2 rounded-lg font-bold bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/30"
          >
            Cancel
          </button>
        </div>
      )}

      {gameState && (
        <>
          <OddsGameDisplay
            gameState={gameState}
            revealedRounds={revealedRounds}
            gameOver={gameOver}
            userWon={userWon}
            isPlayer1={isPlayer1}
            userLabel="You"
            oppLabel="Opponent"
            wager={wagerLocked ?? wager}
            payout={gameState.payout}
            showReverse={showReverse}
            onPlayAgain={reset}
          />
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
        </>
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
          if (!data.success) throw new Error(data.error || "Failed to submit report");
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

      {/* Rounds display */}
      <div className="space-y-3">
        {gameState.rounds.map((round, i) => {
          const visible = i < revealedRounds;
          const isLastRound = i === gameState.rounds.length - 1;
          const userIsStarter = isUserStarter(round);
          const userIsChallenger = !userIsStarter;
          const prevRound = i > 0 ? gameState.rounds[i - 1] : null;
          const isReverse = prevRound && round.max === prevRound.max && round.starter !== prevRound.starter;

          return (
            <motion.div
              key={i}
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
                  <span className="text-xs font-bold text-white/40">Round {i + 1}</span>
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
                      key={`u-${i}`}
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
                      key={`o-${i}`}
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
              {visible && !round.matched && i === revealedRounds - 1 && (
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

      {/* Game over result */}
      <AnimatePresence>
        {gameOver && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 200, damping: 15 }}
            className={`rounded-2xl border p-6 text-center ${
              userWon
                ? "border-yellow-400/40 bg-gradient-to-b from-yellow-900/30 to-black/50 shadow-[0_0_30px_rgba(250,204,21,0.3)]"
                : "border-red-400/20 bg-gradient-to-b from-red-900/20 to-black/50"
            }`}
          >
            <p className="text-5xl mb-2">{userWon ? "🏆" : "😞"}</p>
            <p className={`text-2xl font-black ${userWon ? "text-yellow-400" : "text-red-400"}`}>
              {userWon ? "You Win!" : "You Lose"}
            </p>
            <p className="text-sm text-white/50 mt-1">
              {userWon ? `Payout: ${payout} 🪙` : `${oppLabel} wins the pot of ${payout} 🪙`}
            </p>
            <p className="text-xs text-white/30 mt-1">
              Total rounds: {gameState.totalRounds}
            </p>
            <button
              onClick={onPlayAgain}
              className="mt-4 w-full rounded-xl bg-gradient-to-r from-yellow-500 to-amber-500 px-6 py-3 font-bold text-black shadow-lg transition-all hover:scale-105"
            >
              Play Again
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
