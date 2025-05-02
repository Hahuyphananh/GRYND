"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import { Chess } from "chess.js";

const Chessboard = dynamic(() => import("react-chessboard"), { ssr: false });

export default function ChessGamePage() {
  const [game, setGame] = useState(new Chess());
  const [fen, setFen] = useState("start");
  const [status, setStatus] = useState("");

  function makeAMove(move) {
    const gameCopy = new Chess(game.fen());
    const result = gameCopy.move(move);
    if (result) {
      setGame(gameCopy);
      setFen(gameCopy.fen());

      if (gameCopy.isGameOver()) {
        if (gameCopy.isCheckmate()) {
          setStatus("Checkmate!");
        } else if (gameCopy.isDraw()) {
          setStatus("Draw.");
        } else {
          setStatus("Game over.");
        }
      }
    }
    return result;
  }

  function onDrop(sourceSquare, targetSquare) {
    const move = {
      from: sourceSquare,
      to: targetSquare,
      promotion: "q", // always promote to queen for simplicity
    };
    makeAMove(move);
  }

  function resetGame() {
    const newGame = new Chess();
    setGame(newGame);
    setFen("start");
    setStatus("");
  }

  return (
    <div className="min-h-screen bg-[#003366] text-white flex flex-col items-center p-6">
      <h1 className="text-3xl font-bold text-[#FFD700] mb-4">♟️ Chess Game</h1>

      <div className="mb-4">
        <Chessboard
          position={fen}
          onPieceDrop={onDrop}
          boardWidth={400}
          boardOrientation="white"
          arePiecesDraggable
        />
      </div>

      {status && <div className="text-lg text-yellow-300 mb-2">{status}</div>}

      <button
        onClick={resetGame}
        className="bg-green-600 hover:bg-green-700 px-6 py-2 rounded-lg text-white font-bold"
      >
        New Game
      </button>
    </div>
  );
}
