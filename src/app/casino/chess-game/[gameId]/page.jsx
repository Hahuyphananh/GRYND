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

  const [liveFen, setLiveFen] = useState("start");
  const [status, setStatus] = useState("Loading match...");
  const [submittingMove, setSubmittingMove] = useState(false);
  const [gameData, setGameData] = useState(null);
  const [moves, setMoves] = useState([]);
  const [moveIndex, setMoveIndex] = useState(-1);

  const displayFen = useMemo(() => {
    if (moveIndex >= 0 && moves[moveIndex]?.fenAfter) return moves[moveIndex].fenAfter;
    return liveFen;
  }, [moveIndex, moves, liveFen]);

const turn = useMemo(() => {
  const game = new Chess(
    liveFen && liveFen.split(" ").length === 6 ? liveFen : undefined
  );
    return game.turn() === "w" ? "white" : "black";
  }, [liveFen]);

  const isMyTurn = turn === color;

  const fetchState = async () => {
    const res = await fetch(`/api/chess/game-state?gameId=${gameId}`, { cache: "no-store" });
    const data = await res.json();

    if (!res.ok) {
      setStatus(data.error || "Unable to load game state");
      return;
    }

    const nextFen =
  data.data.fen && data.data.fen.split(" ").length === 6
    ? data.data.fen
    : null;
    setGameData(data.data);
    setMoves(data.data.moves || []);
    setLiveFen(nextFen);

    if (!data.data.blackPlayerId) {
      setStatus("Waiting for opponent...");
      return;
    }

    if (data.data.status === "finished" || data.data.status === "expired") {
      const myId = color === "white" ? data.data.whitePlayerId : data.data.blackPlayerId;
      if (data.data.result === "draw") {
        setStatus("Draw.");
      } else if (data.data.winnerId) {
        setStatus(data.data.winnerId === myId ? "You won." : "You lost.");
      } else {
        setStatus("Game over.");
      }
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

      setLiveFen(data.data.fen);
      setStatus(data.data.isGameOver ? "Game over." : "Opponent's turn");
      return true;
    } catch {
      setStatus("Failed to send move");
      return false;
    } finally {
      setSubmittingMove(false);
    }
  }

  const myName = color === "white" ? gameData?.whitePlayerName : gameData?.blackPlayerName;
  const opponentName = color === "white" ? gameData?.blackPlayerName : gameData?.whitePlayerName;
  const canReturnToLobby = gameData?.status === "finished" || gameData?.status === "expired";

  return (
    <div className="min-h-screen bg-[#003366] text-white flex flex-col items-center p-6">
      <h1 className="text-3xl font-bold text-[#FFD700] mb-4">♟️ Chess Game</h1>
      <p className="mb-2">Game #{gameId} · You are {color}</p>
      <p className="mb-4 text-lg font-semibold text-[#FFD700]">Bet Amount: ${Number(gameData?.betAmount || 0)}</p>

      <div className="flex flex-col md:flex-row gap-6 items-start">
        <div>
          <p className="text-left font-semibold mb-2 text-yellow-200">{opponentName || "Opponent"}</p>
          <div className="mb-2">
            <Chessboard
              position={displayFen}
              onPieceDrop={onDrop}
              boardWidth={400}
              boardOrientation={color}
              arePiecesDraggable={isMyTurn && !submittingMove && moveIndex === -1 && !canReturnToLobby}
            />
          </div>
          <p className="text-right font-semibold text-yellow-200">{myName || "You"}</p>
        </div>

        <div className="w-full md:w-72 bg-[#002147] rounded-xl p-4 border border-[#FFD700]/40">
          <h3 className="text-xl font-bold text-[#FFD700] mb-2">Move History</h3>
          <div className="max-h-80 overflow-y-auto pr-1 text-sm">
            {moves.length === 0 ? (
              <p className="text-white/70">No moves yet.</p>
            ) : (
              moves.map((move, index) => (
                <button
                  key={move.id}
                  className={`block w-full text-left px-2 py-1 rounded ${moveIndex === index ? "bg-[#FFD700] text-[#003366] font-bold" : "hover:bg-white/10"}`}
                  onClick={() => setMoveIndex(index)}
                >
                  {index + 1}. {move.moveSan}
                </button>
              ))
            )}
          </div>
          <div className="flex items-center justify-between mt-3">
            <button
              onClick={() => setMoveIndex((prev) => Math.max(-1, prev - 1))}
              className="bg-[#FFD700] text-[#003366] px-3 py-1 rounded font-bold disabled:opacity-50"
              disabled={moveIndex <= -1}
            >
              ←
            </button>
            <button
              onClick={() => setMoveIndex((prev) => (prev >= moves.length - 1 ? -1 : prev + 1))}
              className="bg-[#FFD700] text-[#003366] px-3 py-1 rounded font-bold disabled:opacity-50"
              disabled={moves.length === 0}
            >
              →
            </button>
          </div>
          <p className="text-xs mt-2 text-white/70">
            {moveIndex === -1 ? "Live position" : `Viewing move ${moveIndex + 1}`}
          </p>
        </div>
      </div>

      {status && <div className="text-lg text-yellow-300 mb-2">{status}</div>}

      {canReturnToLobby && (
        <button
          onClick={() => router.push("/casino/chess")}
          className="bg-green-600 hover:bg-green-700 px-6 py-2 rounded-lg text-white font-bold"
        >
          Back to Chess Lobby
        </button>
      )}
    </div>
  );
}
