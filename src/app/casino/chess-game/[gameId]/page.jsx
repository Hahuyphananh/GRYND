"use client";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Chess } from "chess.js";

const Chessboard = dynamic(
  async () => {
    const mod = await import("react-chessboard");
    return mod.Chessboard;
  },
  { ssr: false }
);

export default function ChessGamePage() {
  const { gameId } = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const color = searchParams.get("color") || "white";

  const [fen, setFen] = useState("start");
  const [status, setStatus] = useState("Loading match...");
  const [submittingMove, setSubmittingMove] = useState(false);

  const turn = useMemo(() => {
    const game = new Chess(fen === "start" ? undefined : fen);
    return game.turn() === "w" ? "white" : "black";
  }, [fen]);

  const isMyTurn = turn === color;

  const fetchState = async () => {
    const res = await fetch(`/api/chess/game-state?gameId=${gameId}`, { cache: "no-store" });
    const data = await res.json();

    if (!res.ok) {
      setStatus(data.error || "Unable to load game state");
      return;
    }

    const nextFen = data.data.fen || "start";
    setFen(nextFen);

    if (!data.data.blackPlayerId) {
      setStatus("Waiting for opponent...");
      return;
    }

    if (data.data.status === "finished") {
      setStatus(data.data.result === "draw" ? "Draw." : "Game over.");
      return;
    }

    const turnFromFen = new Chess(nextFen === "start" ? undefined : nextFen).turn() === "w" ? "white" : "black";
    setStatus(turnFromFen === color ? "Your turn" : "Opponent's turn");
  };

  useEffect(() => {
    fetchState();
    const id = setInterval(fetchState, 1500);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, color]);

  async function onDrop(sourceSquare, targetSquare) {
    if (!isMyTurn || submittingMove) return false;

    setSubmittingMove(true);
    try {
      const res = await fetch("/api/chess/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameId: Number(gameId),
          from: sourceSquare,
          to: targetSquare,
          promotion: "q",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setStatus(data.error || "Move rejected");
        return false;
      }

      setFen(data.data.fen);
      setStatus(data.data.isGameOver ? "Game over." : "Opponent's turn");
      return true;
    } catch {
      setStatus("Failed to send move");
      return false;
    } finally {
      setSubmittingMove(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#003366] text-white flex flex-col items-center p-6">
      <h1 className="text-3xl font-bold text-[#FFD700] mb-4">♟️ Chess Game</h1>
      <p className="mb-4">Game #{gameId} · You are {color}</p>

      <div className="mb-4">
        <Chessboard
          position={fen}
          onPieceDrop={onDrop}
          boardWidth={400}
          boardOrientation={color}
          arePiecesDraggable={isMyTurn && !submittingMove}
        />
      </div>

      {status && <div className="text-lg text-yellow-300 mb-2">{status}</div>}

      <button
        onClick={() => router.push("/casino/chess")}
        className="bg-green-600 hover:bg-green-700 px-6 py-2 rounded-lg text-white font-bold"
      >
        Back to Chess Lobby
      </button>
    </div>
  );
}
