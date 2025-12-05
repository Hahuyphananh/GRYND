"use client";

import { useState, useEffect, useRef } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { useRouter, useSearchParams } from "next/navigation";
import NavigationBar from "../../../../components/navigation-bar";

export default function ChessAIPageInner() {
  const [game, setGame] = useState(new Chess());
  const [aiLevel, setAiLevel] = useState(1);
  const [gameOver, setGameOver] = useState(false);
  const [winner, setWinner] = useState("");
  const [playerColor, setPlayerColor] = useState<"white" | "black">("white");

  const router = useRouter();
  const searchParams = useSearchParams();
  const bet = searchParams.get("bet");
  const [gameResult, setGameResult] = useState<"win" | "lose" | "draw" | "pending">("pending");
const [winnerText, setWinnerText] = useState(""); // text shown in popup

  // Prevent duplicate calls
  const endGameCalled = useRef(false);

  // END GAME API CALL
  async function endGame() {
    if (endGameCalled.current) return; // 🔥 prevents duplicates
    endGameCalled.current = true;

    try {
      await fetch("/api/chess/end-game", {
        method: "POST",
      });
    } catch (e) {
      console.error("Failed to end game:", e);
    }
  }

  // Trigger endGame when leaving page
  useEffect(() => {
    const handleLeave = () => {
      if (!endGameCalled.current) {
        navigator.sendBeacon("/api/chess/end-game"); // safer for unload
        endGameCalled.current = true;
      }
    };

    window.addEventListener("beforeunload", handleLeave);
    return () => window.removeEventListener("beforeunload", handleLeave);
  }, []);

  // GAME INITIALIZATION
  useEffect(() => {
    const randomColor = Math.random() > 0.5 ? "white" : "black";
    setPlayerColor(randomColor);
    const newGame = new Chess();
    setGame(newGame);
    setGameOver(false);
    setWinner("");
    endGameCalled.current = false;

    if (randomColor === "black") {
      setTimeout(() => makeAIMMove(newGame), 500);
    }
  }, []);

  function isPlayersTurn(gameInstance: Chess) {
    if (!gameInstance) return false;
    const turn = gameInstance.turn();
    const playerTurnChar = playerColor === "white" ? "w" : "b";
    return turn === playerTurnChar;
  }

  function makeAIMMove(gameInstance: any) {
    if (!gameInstance || gameInstance.isGameOver())
      return handleGameOver(gameInstance);

    const moves = gameInstance.moves();
    if (moves.length === 0) return;

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

  useEffect(() => {
    if (!game) return;
    if (game.isGameOver()) return;

    const aiColor = playerColor === "white" ? "black" : "white";
    const aiTurnChar = aiColor === "white" ? "w" : "b";

    if (game.turn() === aiTurnChar) {
      const t = setTimeout(
        () => makeAIMMove(new Chess(game.fen())),
        450
      );
      return () => clearTimeout(t);
    }
  }, [game, playerColor, aiLevel]);

  function onDrop(sourceSquare: string, targetSquare: string) {
    if (game.isGameOver() || !isPlayersTurn(game)) return false;

    const gameCopy = new Chess(game.fen());
    const move = gameCopy.move({
      from: sourceSquare,
      to: targetSquare,
      promotion: "q",
    });

    if (move === null) return false;

    setGame(new Chess(gameCopy.fen()));

    if (gameCopy.isGameOver()) handleGameOver(gameCopy);

    return true;
  }

// Example for handleGameOver
async function handleGameOver(gameInstance: any) {
  setGameOver(true);
  await endGame();

  if (!gameInstance) {
    setWinnerText("Game Over!");
    setGameResult("draw");
    return;
  }

  if (gameInstance.isCheckmate()) {
    const winnerColor = gameInstance.turn() === "w" ? "black" : "white";
    if (winnerColor === playerColor) {
      setWinnerText("You win!");
      setGameResult("win");
    } else {
      setWinnerText("AI wins!");
      setGameResult("lose");
    }
  } else if (gameInstance.isDraw()) {
    setWinnerText("Draw!");
    setGameResult("draw");
  } else {
    setWinnerText("Game Over!");
    setGameResult("draw");
  }
}
async function handleResign() {
  setGameOver(true);
  setWinner("AI wins! (You resigned)");
  await fetch("/api/chess/end-game", { method: "POST" }); // bypass dup prevention
}


  function resetGame() {
    const newGame = new Chess();
    const randomColor = Math.random() > 0.5 ? "white" : "black";
    setPlayerColor(randomColor);
    setGame(newGame);
    setGameOver(false);
    setWinner("");
    endGameCalled.current = false;

    if (randomColor === "black") {
      setTimeout(() => makeAIMMove(newGame), 500);
    }
  }

  const opponentColor = playerColor === "white" ? "Black" : "White";
  const playerSideLabel = `You (${playerColor === "white" ? "White" : "Black"})`;
  const aiSideLabel = `AI (${opponentColor})`;
  const isPlayerTurnNow = isPlayersTurn(game);

  return (
    <div className="min-h-screen bg-[#003366] text-white flex flex-col items-center p-6">
      <NavigationBar currentPath="/casino" />

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
          {gameOver ? "" : isPlayerTurnNow ? "Your turn" : "AI is thinking..."}
        </div>
      </div>

      <div className="w-full flex justify-center items-center mb-8">
        <div className="w-[500px]">
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

      {gameOver && (
        <div className="absolute inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-white text-black rounded-lg p-8 text-center shadow-lg">
            <h2 className="text-3xl font-bold mb-4">{winner}</h2>

     {bet && (
  <p className="text-xl mb-4 font-semibold">
    {gameResult === "win" ? (
      <span className="text-green-600">You won ${Number(bet) * 1.98}!</span>
    ) : gameResult === "draw" ? (
      <span className="text-yellow-600">Bet returned.</span>
    ) : (
      <span className="text-red-600">You lost ${bet}.</span>
    )}
  </p>
)}


            <div className="flex gap-4 justify-center">
              <button
                onClick={resetGame}
                className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded shadow"
              >
                Play Again
              </button>
              <button
                onClick={() => router.push("/casino/chess")}
                className="bg-gray-700 hover:bg-gray-800 text-white px-4 py-2 rounded shadow"
              >
                Return to Lobby
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
