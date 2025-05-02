"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import { Chess } from "chess.js";

// Correct dynamic import of named export
const Chessboard = dynamic(() =>
  import("react-chessboard").then((mod) => mod.Chessboard),
  { ssr: false }
);

export default function ChessGamePage() {
  const [game, setGame] = useState(new Chess());
  const [fen, setFen] = useState("start");
  const [status, setStatus] = useState("");

  const onDrop = (source, target) => {
    const move = {
      from: source,
      to: target,
      promotion: "q",
    };

    const updatedGame = new Chess(game.fen());
    const result = updatedGame.move(move);
    if (result) {
      setGame(updatedGame);
      setFen(updatedGame.fen());
      if (updatedGame.isGameOver()) {
        setStatus("Game Over");
      }
    }
  };

  return (
    <div className="min-h-screen bg-[#003366] text-white flex flex-col items-center p-6">
      <h1 className="text-3xl font-bold text-[#FFD700] mb-4">♟️ Chess Game</h1>

      <div className="mb-4">
        <Chessboard
          position={fen}
          onPieceDrop={onDrop}
          boardWidth={400}
          boardOrientation="white"
        />
      </div>

      {status && <p className="text-lg">{status}</p>}
    </div>
  );
}
