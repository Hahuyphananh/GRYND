// /app/casino/chess/ai/page.tsx
"use client";

import { useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";

export default function ChessAIPage() {
  const [game, setGame] = useState(new Chess());

  function makeAIMove(gameInstance: any) {
    const moves = gameInstance.moves();
    if (moves.length === 0) return;
    const move = moves[Math.floor(Math.random() * moves.length)];
    gameInstance.move(move);
    setGame(new Chess(gameInstance.fen()));
  }

  function onDrop(sourceSquare: string, targetSquare: string) {
    const gameCopy = new Chess(game.fen());
    const move = gameCopy.move({
      from: sourceSquare,
      to: targetSquare,
      promotion: "q",
    });

    if (move === null) return false;
    setGame(gameCopy);

    setTimeout(() => makeAIMove(gameCopy), 500);
    return true;
  }

  return (
    <div className="min-h-screen bg-[#003366] text-white p-6 flex flex-col items-center">
      <h1 className="text-3xl font-bold text-[#FFD700] mb-4">🤖 AI Chess</h1>
      <Chessboard
        position={game.fen()}
        onPieceDrop={onDrop}
        boardWidth={500}
        boardOrientation="white"
        customBoardStyle={{
          borderRadius: "12px",
          boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
        }}
        customDarkSquareStyle={{ backgroundColor: "#779952" }}
        customLightSquareStyle={{ backgroundColor: "#edeed1" }}
      />
    </div>
  );
}
