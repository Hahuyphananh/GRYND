"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import NavigationBar from "../../../../components/navigation-bar";
import { celebrateWin, gameOverModal, turnBanner as turnBannerAnim } from "../../../../lib/animations";

const PIECE_VALUES: Record<string, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 20000,
};

const PST = {
  p: [
    0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30,
    20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5,
    -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0,
    0,
  ],
  n: [
    -50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 5, 5, 0, -20, -40, -30,
    5, 10, 15, 15, 10, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 15, 20,
    20, 15, 5, -30, -30, 0, 10, 15, 15, 10, 0, -30, -40, -20, 0, 0, 0, 0, -20,
    -40, -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  b: [
    -20, -10, -10, -10, -10, -10, -10, -20, -10, 5, 0, 0, 0, 0, 5, -10, -10, 10,
    10, 10, 10, 10, 10, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 5, 5, 10, 10,
    5, 5, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 0, 0, 0, 0, 0, 0, -10, -20,
    -10, -10, -10, -10, -10, -10, -20,
  ],
  r: [
    0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0,
    -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0,
    0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0,
  ],
  q: [
    -20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 5, 0, 0, 0, 0, -10, -10, 5, 5,
    5, 5, 5, 0, -10, 0, 0, 5, 5, 5, 5, 0, -5, -5, 0, 5, 5, 5, 5, 0, -5, -10, 0,
    5, 5, 5, 5, 0, -10, -10, 0, 0, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10,
    -10, -20,
  ],
  k: [
    -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40,
    -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40,
    -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20,
    -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20,
  ],
};

function toIndex(square: string) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return (7 - rank) * 8 + file;
}

function pieceSquareValue(type: string, color: "w" | "b", square: string) {
  const table = PST[type as keyof typeof PST] || null;
  if (!table) return 0;
  const idx = toIndex(square);
  return color === "w" ? table[idx] : table[63 - idx];
}

function evaluatePosition(game: Chess, aiColor: "w" | "b") {
  if (game.isCheckmate()) {
    return game.turn() === aiColor ? -999999 : 999999;
  }
  if (game.isDraw() || game.isStalemate() || game.isThreefoldRepetition())
    return 0;

  let score = 0;
  const board = game.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r][f];
      if (!piece) continue;
      const square = String.fromCharCode(97 + f) + (8 - r);
      const val =
        PIECE_VALUES[piece.type] +
        pieceSquareValue(piece.type, piece.color as "w" | "b", square);
      score += piece.color === aiColor ? val : -val;
    }
  }

  // Small mobility bonus
  const moveCount = game.moves().length;
  score += game.turn() === aiColor ? moveCount * 2 : -moveCount * 2;
  return score;
}

function orderedMoves(game: Chess) {
  return game.moves({ verbose: true }).sort((a, b) => {
    const aScore =
      (a.captured ? 10 : 0) +
      (a.promotion ? 8 : 0) +
      (a.san.includes("+") ? 4 : 0);
    const bScore =
      (b.captured ? 10 : 0) +
      (b.promotion ? 8 : 0) +
      (b.san.includes("+") ? 4 : 0);
    return bScore - aScore;
  });
}

function minimax(
  game: Chess,
  depth: number,
  alpha: number,
  beta: number,
  maximizing: boolean,
  aiColor: "w" | "b",
) {
  if (depth === 0 || game.isGameOver()) {
    return evaluatePosition(game, aiColor);
  }

  const moves = orderedMoves(game);

  if (maximizing) {
    let best = -Infinity;
    for (const move of moves) {
      game.move(move);
      const val = minimax(game, depth - 1, alpha, beta, false, aiColor);
      game.undo();
      best = Math.max(best, val);
      alpha = Math.max(alpha, val);
      if (beta <= alpha) break;
    }
    return best;
  }

  let best = Infinity;
  for (const move of moves) {
    game.move(move);
    const val = minimax(game, depth - 1, alpha, beta, true, aiColor);
    game.undo();
    best = Math.min(best, val);
    beta = Math.min(beta, val);
    if (beta <= alpha) break;
  }
  return best;
}

function pickBestMove(game: Chess, aiColor: "w" | "b", aiLevel: number) {
  const depth = Math.min(5, Math.max(1, aiLevel + 1));
  const maximizing = game.turn() === aiColor;
  const moves = orderedMoves(game);
  let bestMove = moves[0];
  let bestScore = maximizing ? -Infinity : Infinity;

  for (const move of moves) {
    game.move(move);
    const score = minimax(
      game,
      depth - 1,
      -Infinity,
      Infinity,
      !maximizing,
      aiColor,
    );
    game.undo();

    if (
      (maximizing && score > bestScore) ||
      (!maximizing && score < bestScore)
    ) {
      bestScore = score;
      bestMove = move;
    }
  }

  return bestMove;
}

export default function ChessAIPageInner() {
  const [game, setGame] = useState(new Chess());
  const [aiLevel, setAiLevel] = useState(5);
  const [gameOver, setGameOver] = useState(false);
  const [playerColor, setPlayerColor] = useState<"white" | "black">("white");
  const [gameResult, setGameResult] = useState<
    "win" | "lose" | "draw" | "pending"
  >("pending");
  const [winnerText, setWinnerText] = useState("");
  const [turnBanner, setTurnBanner] = useState<string | null>(null);
  const [showResultModal, setShowResultModal] = useState(false);

  const prevIsPlayerTurnRef = useRef<boolean | null>(null);
  const resultCelebratedRef = useRef(false);
  const [captureFlash, setCaptureFlash] = useState(false);

  const router = useRouter();
  const searchParams = useSearchParams();
  const bet = searchParams.get("bet");
  const gameId = searchParams.get("gameId");

  const endGameCalled = useRef(false);

  const aiColor = useMemo<"w" | "b">(
    () => (playerColor === "white" ? "b" : "w"),
    [playerColor],
  );

  async function endGame(result?: "win" | "loss" | "draw") {
    if (endGameCalled.current) return;
    endGameCalled.current = true;

    try {
      await fetch("/api/chess/end-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameId: gameId ? Number(gameId) : undefined,
          result,
        }),
      });
    } catch (e) {
      console.error("Failed to end game:", e);
    }
  }

  useEffect(() => {
    const handleLeave = () => {
      if (endGameCalled.current) return;
      const payload = JSON.stringify({
        gameId: gameId ? Number(gameId) : undefined,
        result: "loss",
      });
      navigator.sendBeacon(
        "/api/chess/end-game",
        new Blob([payload], { type: "application/json" }),
      );
      endGameCalled.current = true;
    };

    window.addEventListener("beforeunload", handleLeave);
    return () => {
      handleLeave();
      window.removeEventListener("beforeunload", handleLeave);
    };
  }, [gameId]);

  useEffect(() => {
    const randomColor = Math.random() > 0.5 ? "white" : "black";
    const newGame = new Chess();
    setPlayerColor(randomColor);
    setGame(newGame);
    setGameOver(false);
    setWinnerText("");
    setGameResult("pending");
    endGameCalled.current = false;

    if (randomColor === "black") {
      setTimeout(() => makeAIMMove(newGame), 450);
    }
  }, []);

  function isPlayersTurn(gameInstance: Chess) {
    const playerTurnChar = playerColor === "white" ? "w" : "b";
    return gameInstance.turn() === playerTurnChar;
  }

  function makeAIMMove(gameInstance: Chess) {
    if (!gameInstance || gameInstance.isGameOver()) {
      handleGameOver(gameInstance);
      return;
    }

    const move = pickBestMove(gameInstance, aiColor, aiLevel);
    if (!move) return;

    // Capture flash for AI capture
    if (move.captured) {
      setCaptureFlash(true);
      setTimeout(() => setCaptureFlash(false), 400);
    }

    gameInstance.move(move);
    setGame(new Chess(gameInstance.fen()));

    if (gameInstance.isGameOver()) handleGameOver(gameInstance);
  }

  useEffect(() => {
    if (!game || game.isGameOver()) return;
    if (game.turn() !== aiColor) return;

    const t = setTimeout(() => makeAIMMove(new Chess(game.fen())), 300);
    return () => clearTimeout(t);
  }, [game, aiColor, aiLevel]);

  function onDrop(sourceSquare: string, targetSquare: string) {
    if (game.isGameOver() || !isPlayersTurn(game)) return false;

    const gameCopy = new Chess(game.fen());
    const move = gameCopy.move({
      from: sourceSquare,
      to: targetSquare,
      promotion: "q",
    });

    if (move === null) return false;

    // Capture flash
    if (move.captured) {
      setCaptureFlash(true);
      setTimeout(() => setCaptureFlash(false), 400);
    }

    setGame(new Chess(gameCopy.fen()));
    if (gameCopy.isGameOver()) handleGameOver(gameCopy);
    return true;
  }

  async function handleGameOver(gameInstance: Chess) {
    setGameOver(true);

    if (!gameInstance) {
      setWinnerText("Game Over!");
      setGameResult("draw");
      await endGame("draw");
      setShowResultModal(true);
      return;
    }

    if (gameInstance.isCheckmate()) {
      const winnerColor = gameInstance.turn() === "w" ? "black" : "white";
      if (winnerColor === playerColor) {
        setWinnerText("You win!");
        setGameResult("win");
        await endGame("win");
        if (!resultCelebratedRef.current) {
          resultCelebratedRef.current = true;
          celebrateWin();
        }
      } else {
        setWinnerText("AI wins!");
        setGameResult("lose");
        await endGame("loss");
      }
      setShowResultModal(true);
      return;
    }

    if (gameInstance.isDraw()) {
      setWinnerText("Draw!");
      setGameResult("draw");
      await endGame("draw");
      setShowResultModal(true);
      return;
    }

    setWinnerText("Game Over!");
    setGameResult("draw");
    await endGame("draw");
    setShowResultModal(true);
  }

  async function handleResign() {
    setGameOver(true);
    setWinnerText("AI wins! (You resigned)");
    setGameResult("lose");
    await endGame("loss");
    setShowResultModal(true);
  }

  function resetGame() {
    const newGame = new Chess();
    const randomColor = Math.random() > 0.5 ? "white" : "black";
    setPlayerColor(randomColor);
    setGame(newGame);
    setGameOver(false);
    setWinnerText("");
    setGameResult("pending");
    setShowResultModal(false);
    endGameCalled.current = false;
    resultCelebratedRef.current = false;

    if (randomColor === "black") {
      setTimeout(() => makeAIMMove(newGame), 450);
    }
  }

  const opponentColor = playerColor === "white" ? "Black" : "White";
  const playerSideLabel = `You (${playerColor === "white" ? "White" : "Black"})`;
  const aiSideLabel = `AI (${opponentColor})`;
  const isPlayerTurnNow = isPlayersTurn(game);

  // Turn banner animation
  useEffect(() => {
    if (prevIsPlayerTurnRef.current !== null && prevIsPlayerTurnRef.current !== isPlayerTurnNow && !gameOver) {
      setTurnBanner(isPlayerTurnNow ? "Your Turn" : "AI's Turn");
      setTimeout(() => setTurnBanner(null), 1800);
    }
    prevIsPlayerTurnRef.current = isPlayerTurnNow;
  }, [isPlayerTurnNow, gameOver]);

  return (
    <div className="min-h-screen bg-[#030817] text-white flex flex-col items-center p-6">
      <NavigationBar currentPath="/casino" />

      {/* Turn Banner */}
      <AnimatePresence>
        {turnBanner && (
          <motion.div
            key="turn-banner"
            {...turnBannerAnim}
            className="fixed left-1/2 top-1/3 z-50 -translate-x-1/2 -translate-y-1/2 rounded-2xl border-4 border-amber-400 bg-gradient-to-r from-amber-700 to-orange-700 px-10 py-6 shadow-[0_0_60px_rgba(251,191,36,0.5)]"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.15, type: "spring", stiffness: 400 }}
              className="text-center text-3xl font-black tracking-widest text-white drop-shadow-lg"
            >
              {turnBanner}
            </motion.div>
            <div className="mt-2 flex justify-center gap-1">
              {[0, 1, 2].map((i) => (
                <motion.div
                  key={i}
                  className="h-2 w-2 rounded-full bg-amber-300"
                  animate={{ scale: [1, 1.8, 1], opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.2 }}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Spring Game Over Modal */}
      <AnimatePresence>
        {showResultModal && (
          <motion.div
            key="chess-ai-end"
            {...gameOverModal.backdrop}
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm"
          >
            <motion.div
              {...gameOverModal.panel}
              className={`relative w-full max-w-md overflow-hidden rounded-3xl border-4 p-6 text-center shadow-2xl ${
                gameResult === "win"
                  ? "border-amber-400 bg-gradient-to-b from-[#1a3a1a] to-[#0d2b0d] shadow-[0_0_60px_rgba(251,191,36,0.4)]"
                  : gameResult === "draw"
                    ? "border-yellow-400 bg-gradient-to-b from-[#1a2a1a] to-[#0d1a0d] shadow-[0_0_60px_rgba(250,204,21,0.3)]"
                    : "border-red-500 bg-gradient-to-b from-[#3a1a1a] to-[#2b0d0d] shadow-[0_0_60px_rgba(239,68,68,0.3)]"
              }`}
            >
              <motion.div
                initial={{ scale: 0, rotate: -30 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: "spring", stiffness: 300, damping: 12, delay: 0.3 }}
                className="mb-2 text-7xl"
              >
                {gameResult === "win" ? "🏆" : gameResult === "draw" ? "🤝" : "💀"}
              </motion.div>
              <motion.h2
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.5, duration: 0.4 }}
                className={`mt-3 text-4xl font-black uppercase ${
                  gameResult === "win" ? "text-amber-300" : gameResult === "draw" ? "text-yellow-300" : "text-red-400"
                }`}
              >
                {winnerText}
              </motion.h2>
              {bet && (
                <motion.p
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.6, duration: 0.4 }}
                  className="mt-3 text-xl font-semibold"
                >
                  {gameResult === "win" ? (
                    <span className="text-green-400">
                      You won ${(Number(bet) * 1.98).toFixed(2)}!
                    </span>
                  ) : gameResult === "draw" ? (
                    <span className="text-yellow-400">Bet returned.</span>
                  ) : (
                    <span className="text-red-400">You lost ${bet}.</span>
                  )}
                </motion.p>
              )}
              {gameResult === "win" && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 1.0 }}
                  className="mt-3 flex justify-center gap-1"
                >
                  {["✨", "🌟", "✨", "🌟", "✨"].map((s, i) => (
                    <motion.span
                      key={i}
                      className="text-xl"
                      animate={{ y: [0, -6, 0], opacity: [0.4, 1, 0.4] }}
                      transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.12 }}
                    >
                      {s}
                    </motion.span>
                  ))}
                </motion.div>
              )}
              <motion.div
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.8, duration: 0.4 }}
                className="mt-6 flex gap-4 justify-center"
              >
                <button
                  onClick={resetGame}
                  className="rounded-xl border-b-4 border-green-700 bg-green-500 px-6 py-3 font-black text-white shadow-[0_0_15px_rgba(34,197,94,0.4)] transition active:translate-y-[2px]"
                >
                  Play Again
                </button>
                <button
                  onClick={() => router.push("/casino/chess")}
                  className="rounded-xl border-b-4 border-gray-600 bg-gray-700 px-6 py-3 font-black text-white transition active:translate-y-[2px]"
                >
                  Return to Lobby
                </button>
              </motion.div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <h1 className="text-4xl font-bold text-[#FFD700] mb-2 mt-12">
        ♟️ AI Chess Arena
      </h1>

      {bet && (
        <p className="text-2xl font-semibold text-green-400 mb-6">
          Bet: ${bet}
        </p>
      )}

      <div className="flex gap-4 mb-4 items-center">
        <button
          onClick={handleResign}
          className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded shadow"
        >
          Resign
        </button>

        <div className="mb-0 text-center">
          <label className="mr-2 font-semibold">AI Level:</label>
          <select
            value={aiLevel}
            onChange={(e) => setAiLevel(Number(e.target.value))}
            className="text-black px-2 py-1 rounded"
          >
            {[1, 2, 3, 4, 5].map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="w-full max-w-4xl mx-auto text-center mb-4">
        <h2 className="text-xl font-semibold">
          {playerSideLabel} vs {aiSideLabel}
        </h2>
        <div className="text-sm text-yellow-300 mt-2">
          {gameOver ? "" : isPlayerTurnNow ? "Your turn" : (<span className="inline-flex items-center gap-1">AI is thinking... <motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }} className="inline-block">🤖</motion.span></span>)}
        </div>
      </div>

      <div className="w-full flex justify-center items-center mb-8">
        <div className="w-[500px] relative">
          <AnimatePresence>
            {captureFlash && (
              <motion.div
                initial={{ opacity: 0.7 }}
                animate={{ opacity: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4 }}
                className="absolute inset-0 z-10 rounded-xl bg-red-500 pointer-events-none"
              />
            )}
          </AnimatePresence>
          <Chessboard
            position={game.fen()}
            onPieceDrop={onDrop}
            boardWidth={500}
            boardOrientation={playerColor}
            customBoardStyle={{
              borderRadius: "12px",
              boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
            }}
            customDarkSquareStyle={{ backgroundColor: "#779952" }}
            customLightSquareStyle={{ backgroundColor: "#edeed1" }}
          />
        </div>
      </div>

    </div>
  );
}
