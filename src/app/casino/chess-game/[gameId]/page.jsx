"use client";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Chess } from "chess.js";
import { useSocket } from "../../../../context/SocketProvider";

const Chessboard = dynamic(
  async () => {
    const mod = await import("react-chessboard");
    return mod.Chessboard;
  },
  { ssr: false }
);


const CONFETTI_COLORS = ["#facc15", "#22c55e", "#38bdf8", "#fb7185", "#a78bfa"];

function playUiTone(type = "move") {
  if (typeof window === "undefined") return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  const config = {
    move: { freq: 420, duration: 0.08 },
    win: { freq: 680, duration: 0.18 },
  }[type] || { freq: 420, duration: 0.08 };
  osc.frequency.value = config.freq;
  gain.gain.setValueAtTime(0.001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + config.duration);
  osc.start();
  osc.stop(ctx.currentTime + config.duration);
}

function formatClock(seconds) {
  const safe = Math.max(0, Number(seconds || 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export default function ChessGamePage() {
  const { gameId } = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const color = searchParams.get("color") || "white";
  const isSpectator = searchParams.get("spectator") === "1";
  const [spectatorFocus, setSpectatorFocus] = useState(searchParams.get("focus") || "white");

  const [liveFen, setLiveFen] = useState("start");
  const [status, setStatus] = useState("Loading match...");
  const [submittingMove, setSubmittingMove] = useState(false);
  const [isResigning, setIsResigning] = useState(false);
  const [gameData, setGameData] = useState(null);
  const [moves, setMoves] = useState([]);
  const [moveIndex, setMoveIndex] = useState(-1);
  const [showResultPopup, setShowResultPopup] = useState(false);
  const [spectatorCount, setSpectatorCount] = useState(0);

  const [selectedSquare, setSelectedSquare] = useState(null);
  const [legalTargets, setLegalTargets] = useState([]);
  const { socket } = useSocket();

  const normalizeFen = (fen) => {
    if (typeof fen !== "string") return "start";
    return fen.split(" ").length === 6 ? fen : "start";
  };

  const displayFen = useMemo(() => {
    if (moveIndex >= 0 && moves[moveIndex]?.fenAfter) {
      return normalizeFen(moves[moveIndex].fenAfter);
    }
    return normalizeFen(liveFen);
  }, [moveIndex, moves, liveFen]);

  const turn = useMemo(() => {
    const safeFen = normalizeFen(liveFen);
    const game = new Chess(safeFen === "start" ? undefined : safeFen);
    return game.turn() === "w" ? "white" : "black";
  }, [liveFen]);

  const activeColor = isSpectator ? spectatorFocus : color;
  const isMyTurn = turn === activeColor;

  const fetchState = async () => {
    const res = await fetch(`/api/chess/game-state?gameId=${gameId}`, { cache: "no-store" });
    const data = await res.json();

    if (!res.ok) {
      setStatus(data.error || "Unable to load game state");
      return;
    }

    const nextFen = normalizeFen(data?.data?.fen);
    setGameData(data.data);
    setMoves(data.data.moves || []);
    setLiveFen(nextFen);
    setSelectedSquare(null);
    setLegalTargets([]);

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
      setShowResultPopup(true);
      return;
    }

    const turnFromFen = new Chess(nextFen === "start" ? undefined : nextFen).turn() === "w" ? "white" : "black";
    setStatus(turnFromFen === color ? "Your turn" : "Opponent's turn");
  };

  useEffect(() => {
    fetchState();
    const id = setInterval(fetchState, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, color]);

  useEffect(() => {
    if (!socket || !gameId) return;

    const gameRoomId = String(gameId);
    socket.emit("join_game", { gameId: gameRoomId });

    const handleOpponentMove = (payload) => {
      if (String(payload?.gameId) !== gameRoomId) return;
      fetchState();
    };

    const handleDisconnect = () => {
      setStatus("Realtime connection lost. Reconnecting...");
    };

    socket.on("move", handleOpponentMove);
    socket.on("disconnect", handleDisconnect);

    return () => {
      socket.emit("leave_game", { gameId: gameRoomId });
      socket.off("move", handleOpponentMove);
      socket.off("disconnect", handleDisconnect);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, gameId]);


  useEffect(() => {
    if (moveIndex !== -1) {
      setSelectedSquare(null);
      setLegalTargets([]);
    }
  }, [moveIndex]);

  useEffect(() => {
    if (isSpectator) return;
    const pingPresence = async () => {
      await fetch("/api/presence/game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ gameKey: "chess", gameId: Number(gameId) }),
      });
    };
    pingPresence();
    const id = setInterval(pingPresence, 15000);
    return () => clearInterval(id);
  }, [gameId, isSpectator]);


  useEffect(() => {
    if (!gameData) return;
    const targetClerkId = activeColor === "white" ? gameData.whitePlayerId : gameData.blackPlayerId;
    if (!targetClerkId) return;

    const pollSpectators = async () => {
      try {
        const res = await fetch(`/api/spectators/count?gameKey=chess&gameId=${gameId}`, { credentials: "include" });
        const data = await res.json();
        if (res.ok && data.success) setSpectatorCount(Number(data.count || 0));
      } catch {}
    };

    pollSpectators();
    const id = setInterval(pollSpectators, 5000);

    let hb;
    if (isSpectator) {
      const beat = async () => {
        await fetch("/api/spectators/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ gameKey: "chess", gameId: Number(gameId), targetClerkId }),
        });
      };
      beat();
      hb = setInterval(beat, 5000);
    }

    return () => {
      clearInterval(id);
      if (hb) clearInterval(hb);
    };
  }, [gameData, activeColor, gameId, isSpectator]);


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

      setLiveFen(normalizeFen(data?.data?.fen));
      setStatus(data.data.isGameOver ? "Game over." : "Opponent's turn");
      playUiTone(data.data.isGameOver ? "win" : "move");
      socket?.emit("move", {
        gameId: String(gameId),
        move: {
          from: sourceSquare,
          to: targetSquare,
          promotion: "q",
        },
      });
      return true;
    } catch {
      setStatus("Failed to send move");
      return false;
    } finally {
      setSubmittingMove(false);
    }
  }

  async function resignGame() {
    if (!gameData || gameData.status !== "in_progress" || isResigning) return;

    setIsResigning(true);
    try {
      const res = await fetch("/api/chess/end-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: Number(gameId), result: "loss" }),
      });

      if (!res.ok) {
        const text = await res.text();
        alert(text || "Unable to resign");
        return;
      }

      await fetchState();
    } catch {
      alert("Unable to resign");
    } finally {
      setIsResigning(false);
    }
  }

  const myName = activeColor === "white" ? gameData?.whitePlayerName : gameData?.blackPlayerName;
  const opponentName = activeColor === "white" ? gameData?.blackPlayerName : gameData?.whitePlayerName;
  const canReturnToLobby = gameData?.status === "finished" || gameData?.status === "expired";

  const myClock = activeColor === "white" ? gameData?.whiteTimeRemaining : gameData?.blackTimeRemaining;
  const oppClock = activeColor === "white" ? gameData?.blackTimeRemaining : gameData?.whiteTimeRemaining;

  const isInteractiveBoard = !isSpectator && isMyTurn && !submittingMove && moveIndex === -1 && !canReturnToLobby;

  const selectSquare = (square) => {
    if (!isInteractiveBoard) return;

    const game = new Chess(normalizeFen(liveFen) === "start" ? undefined : normalizeFen(liveFen));

    const matchingMove = legalTargets.find((move) => move.to === square);
    if (selectedSquare && matchingMove) {
      onDrop(selectedSquare, square);
      setSelectedSquare(null);
      setLegalTargets([]);
      return;
    }

    const piece = game.get(square);
    if (!piece) {
      setSelectedSquare(null);
      setLegalTargets([]);
      return;
    }

    const pieceColor = piece.color === "w" ? "white" : "black";
    if (pieceColor !== activeColor) {
      setSelectedSquare(null);
      setLegalTargets([]);
      return;
    }

    const movesForPiece = game.moves({ square, verbose: true });
    if (movesForPiece.length === 0) {
      setSelectedSquare(null);
      setLegalTargets([]);
      return;
    }

    setSelectedSquare(square);
    setLegalTargets(movesForPiece);
  };

  const customSquareStyles = useMemo(() => {
    const styles = {};

    if (selectedSquare) {
      styles[selectedSquare] = {
        boxShadow: "inset 0 0 0 4px rgba(250, 204, 21, 0.95)",
        backgroundColor: "rgba(250, 204, 21, 0.35)",
      };
    }

    legalTargets.forEach((move) => {
      const isCapture = move.flags.includes("c") || move.flags.includes("e");
      styles[move.to] = {
        boxShadow: isCapture
          ? "inset 0 0 0 4px rgba(239, 68, 68, 0.95)"
          : "inset 0 0 0 4px rgba(34, 197, 94, 0.95)",
        backgroundColor: isCapture ? "rgba(239, 68, 68, 0.35)" : "rgba(34, 197, 94, 0.35)",
      };
    });

    return styles;
  }, [selectedSquare, legalTargets]);

  return (
    <div className="min-h-screen bg-[#030817] text-white flex flex-col items-center p-8 page-enter">
      <h1 className="text-3xl font-bold text-[#FFD700] mb-4">♟️ Chess Game</h1>
      <p className="mb-2">Game #{gameId} · {isSpectator ? `Spectating ${activeColor}` : `You are ${color}`}</p>
      {isSpectator && (
        <div className="mb-2 flex gap-2">
          <button onClick={() => setSpectatorFocus("white")} className="px-2 py-1 rounded bg-white/10 text-xs">View White</button>
          <button onClick={() => setSpectatorFocus("black")} className="px-2 py-1 rounded bg-white/10 text-xs">View Black</button>
        </div>
      )}
      <p className="mb-1 text-lg font-semibold text-[#FFD700]">Bet Amount: ${Number(gameData?.betAmount || 0)}</p>
      <p className="mb-4 text-md text-white/90">Timer: {gameData?.timerMode || "blitz"}</p>

      <div className="flex flex-col md:flex-row gap-6 items-start">
        <div className="casino-surface rounded-2xl p-4">
          <div className={`flex justify-between mb-2 rounded-lg px-2 py-1 ${gameData?.activeTurn !== activeColor ? "turn-active-glow" : ""}`}>
            <p className="text-left font-semibold text-yellow-200">{opponentName || "Opponent"}</p>
            <p className={`font-mono font-bold ${gameData?.activeTurn !== activeColor ? "text-green-300" : "text-white"} ${Number(oppClock || 0) <= 10 ? "low-time-pulse" : ""}`}>{formatClock(oppClock)}</p>
          </div>
          <div className="mb-2 rounded-xl overflow-hidden shadow-2xl">
            <Chessboard
              position={displayFen}
              onPieceDrop={onDrop}
              onSquareClick={selectSquare}
              boardWidth={400}
              boardOrientation={activeColor}
              arePiecesDraggable={isInteractiveBoard}
              customSquareStyles={customSquareStyles}
            />
          </div>
          <div className={`flex justify-between rounded-lg px-2 py-1 ${gameData?.activeTurn === activeColor ? "turn-active-glow" : ""}`}>
            <p className="text-right font-semibold text-yellow-200">{myName || "You"}</p>
            <p className={`font-mono font-bold ${gameData?.activeTurn === activeColor ? "text-green-300" : "text-white"} ${Number(myClock || 0) <= 10 ? "low-time-pulse" : ""}`}>{formatClock(myClock)}</p>
          </div>
        </div>
          <p className="text-xs text-white/80 mt-2">Click a piece to preview moves. <span className="text-green-300">Green</span> = legal move, <span className="text-red-300">Red</span> = capture.</p>

        <div className="w-full md:w-72 casino-surface rounded-xl p-4">
          <h3 className="text-xl font-bold text-[#FFD700] mb-2">Move History</h3>
          <div className="max-h-80 overflow-y-auto pr-1 text-sm">
            {moves.length === 0 ? (
              <p className="text-white/70">No moves yet.</p>
            ) : (
              moves.map((move, index) => (
                <button
                  key={move.id}
                  className={`block w-full text-left px-2 py-1 rounded ${moveIndex === index ? "bg-[#FFD700] text-[#030817] font-bold" : "hover:bg-white/10"}`}
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
              className="bg-[#FFD700] text-[#030817] px-3 py-1 rounded font-bold disabled:opacity-50 hover-lift"
              disabled={moveIndex <= -1}
            >
              ←
            </button>
            <button
              onClick={() => setMoveIndex((prev) => (prev >= moves.length - 1 ? -1 : prev + 1))}
              className="bg-[#FFD700] text-[#030817] px-3 py-1 rounded font-bold disabled:opacity-50 hover-lift"
              disabled={moves.length === 0}
            >
              →
            </button>
          </div>
          <p className="text-xs mt-2 text-white/70">{moveIndex === -1 ? "Live position" : `Viewing move ${moveIndex + 1}`}</p>

          {!canReturnToLobby && (
            <button
              onClick={resignGame}
              disabled={isResigning}
              className="w-full mt-4 bg-red-600 hover:bg-red-700 disabled:bg-red-900 px-4 py-2 rounded-lg font-bold hover-lift"
            >
              {isResigning ? "Resigning..." : "Resign"}
            </button>
          )}
        </div>
      </div>

      {status && <div className="text-lg text-yellow-300 mt-4 mb-2">{status}</div>}
      {!isSpectator && spectatorCount > 0 && <div className="text-xs text-cyan-300 mb-2">👀 {spectatorCount} spectator{spectatorCount > 1 ? "s" : ""}</div>}

      {showResultPopup && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4">
          <div className="bg-white text-[#030817] w-full max-w-md rounded-xl p-6 text-center relative overflow-hidden">
            <h2 className="text-2xl font-bold mb-3">Game Finished</h2>
            <p className="text-xl mb-5">
              {status.includes("won") ? "You won!" : status.includes("lost") ? "You lost." : "Draw."}
            </p>

            {status.includes("won") && (
              <div className="confetti-overlay">
                {Array.from({ length: 24 }).map((_, index) => (
                  <span
                    key={`confetti-${index}`}
                    className="confetti-piece"
                    style={{
                      left: `${(index * 17) % 100}%`,
                      backgroundColor: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
                      animationDelay: `${(index % 8) * 0.05}s`,
                    }}
                  />
                ))}
              </div>
            )}
            <button
              onClick={() => router.push("/casino/chess")}
              className="bg-green-600 hover:bg-green-700 text-white px-6 py-2 rounded-lg font-bold hover-lift"
            >
              Return to Lobby
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
