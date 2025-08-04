"use client";

import { useState, useEffect } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { useRouter } from "next/navigation";

export default function ChessAIPage() {
  const [game, setGame] = useState(new Chess());
  const [aiLevel, setAiLevel] = useState(1);
  const [gameOver, setGameOver] = useState(false);
  const [winner, setWinner] = useState("");
  const [playerColor, setPlayerColor] = useState<"white" | "black">("white");
  const router = useRouter();

  useEffect(() => {
    // Randomize starting color when component mounts
    const randomColor = Math.random() > 0.5 ? "white" : "black";
    setPlayerColor(randomColor);
    const newGame = new Chess();
    setGame(newGame);

    // If player is black, AI moves first
    if (randomColor === "black") {
      setTimeout(() => makeAIMove(newGame), 500);
    }
  }, []);

  // AI move logic with difficulty
  function makeAIMove(gameInstance: any) {
    if (gameInstance.isGameOver()) return handleGameOver(gameInstance);

    const moves = gameInstance.moves();
    if (moves.length === 0) return;

    // AI move selection
    let move;
    if (aiLevel <= 2) {
      move = moves[Math.floor(Math.random() * moves.length)];
    } else {
      const captures = moves.filter((m) => m.includes("x"));
      const checks = moves.filter((m) => m.includes("+"));
      if (aiLevel >= 4 && checks.length) {
        move = checks[Math.floor(Math.random() * checks.length)];
      } else if (captures.length) {
        move = captures[Math.floor(Math.random() * captures.length)];
      } else {
        move = moves[Math.floor(Math.random() * moves.length)];
      }
    }

    gameInstance.move(move);
    setGame(new Chess(gameInstance.fen()));

    if (gameInstance.isGameOver()) handleGameOver(gameInstance);
  }

  // Player move handling (includes castling)
  function onDrop(sourceSquare: string, targetSquare: string) {
    const gameCopy = new Chess(game.fen());

    // Detect castling (king moves two squares)
    const piece = gameCopy.get(sourceSquare as any);
    const isKing = piece?.type === "k";
    const fileDiff = sourceSquare.charCodeAt(0) - targetSquare.charCodeAt(0);
    let move = null;

    if (isKing && Math.abs(fileDiff) === 2) {
      const isKingside = fileDiff < 0;
      const castlingMove = isKingside ? "O-O" : "O-O-O";
      move = gameCopy.move(castlingMove);
    } else {
      move = gameCopy.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: "q",
      });
    }

    if (move === null) return false;

    setGame(new Chess(gameCopy.fen()));

    if (gameCopy.isGameOver()) {
      handleGameOver(gameCopy);
    } else {
      setTimeout(() => makeAIMove(gameCopy), 500);
    }

    return true;
  }

  // Game over handler
  function handleGameOver(gameInstance: any) {
    setGameOver(true);

    if (gameInstance.isCheckmate()) {
      if (gameInstance.turn() === "w") {
        // White to move but no moves → black wins
        setWinner(playerColor === "black" ? "You win!" : "AI wins!");
      } else {
        setWinner(playerColor === "white" ? "You win!" : "AI wins!");
      }
    } else if (gameInstance.isDraw()) {
      setWinner("Draw!");
    } else {
      setWinner("Game Over!");
    }
  }

  function handleResign() {
    setGameOver(true);
    setWinner("AI wins! (You resigned)");
  }

  function resetGame() {
    const newGame = new Chess();
    const randomColor = Math.random() > 0.5 ? "white" : "black";
    setPlayerColor(randomColor);
    setGame(newGame);
    setGameOver(false);
    setWinner("");

    if (randomColor === "black") {
      setTimeout(() => makeAIMove(newGame), 500);
    }
  }

  return (
    <div className="min-h-screen bg-[#003366] text-white flex flex-col items-center justify-start p-6 relative">
      {/* Title */}
      <h1 className="text-4xl font-bold text-[#FFD700] mb-6">
        ♟️ AI Chess Arena
      </h1>

      {/* Buttons and Controls */}
      <div className="flex gap-4 mb-4">
        <button
          onClick={() => router.push("/casino")}
          className="bg-gray-700 hover:bg-gray-800 text-white px-4 py-2 rounded shadow"
        >
          ⬅ Return to Casino
        </button>
        <button
          onClick={handleResign}
          className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded shadow"
        >
          Resign
        </button>
      </div>

      {/* AI Level Selector */}
      <div className="mb-6 text-center">
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

      {/* Chessboard */}
      <div className="flex justify-center items-center w-full">
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

      {/* Game Over Modal */}
      {gameOver && (
        <div className="absolute inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-white text-black rounded-lg p-8 text-center shadow-lg">
            <h2 className="text-3xl font-bold mb-4">{winner}</h2>
            <div className="flex gap-4 justify-center">
              <button
                onClick={resetGame}
                className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded shadow"
              >
                Play Again
              </button>
              <button
                onClick={() => router.push("/casino")}
                className="bg-gray-700 hover:bg-gray-800 text-white px-4 py-2 rounded shadow"
              >
                Return to Casino
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
