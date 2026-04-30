"use client";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Chess } from "chess.js";
import { useSocket } from "../../../../context/SocketProvider";
import useGamePresence from "../../../../hooks/useGamePresence";

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
    move: { freq: 430, duration: 0.08 },
    win: { freq: 700, duration: 0.18 },
  }[type];

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
  const router = useRouter();
  const searchParams = useSearchParams();

  const color = searchParams.get("color") || "white";
  const isSpectator = searchParams.get("spectator") === "1";

  const focusTarget = searchParams.get("focusTarget") || "";
  const [spectatorFocus, setSpectatorFocus] = useState(searchParams.get("focus") || "white");

  const [liveFen, setLiveFen] = useState("start");
  const [status, setStatus] = useState("Loading match...");
  const [gameData, setGameData] = useState(null);
  const [moves, setMoves] = useState([]);
  const [moveIndex, setMoveIndex] = useState(-1);
  const [isResigning, setIsResigning] = useState(false);
const [showResultPopup, setShowResultPopup] = useState(false);
const [resultText, setResultText] = useState("");

  const { socket } = useSocket();

  const activeColor = isSpectator ? spectatorFocus : color;

  useGamePresence({
    gameKey: "chess",
    gameId: Number(gameId),
    enabled: !isSpectator && Boolean(gameId),
  });

  const boardSize =
    typeof window !== "undefined"
      ? Math.min(window.innerWidth - 32, 640)
      : 640;

  const displayFen = useMemo(() => {
    if (moveIndex >= 0 && moves[moveIndex]?.fenAfter) {
      return moves[moveIndex].fenAfter;
    }
    return liveFen;
  }, [moveIndex, moves, liveFen]);

async function fetchState() {
  const res = await fetch(`/api/chess/game-state?gameId=${gameId}`, {
    cache: "no-store",
  });

  const data = await res.json();

  if (!res.ok) {
    setStatus("Unable to load game");
    return;
  }

  const game = data.data;
  if (isSpectator && focusTarget) {
    const normalizedTarget = String(focusTarget);
    if (normalizedTarget === String(game.whitePlayerId)) setSpectatorFocus("white");
    else if (normalizedTarget === String(game.blackPlayerId)) setSpectatorFocus("black");
  }

  setGameData(game);
  setMoves(game.moves || []);
  setLiveFen(game.fen || "start");

  if (!game.blackPlayerId) {
    setStatus("Waiting for opponent...");
    return;
  }

  if (game.status === "finished" || game.status === "expired") {
    const myId =
      color === "white"
        ? game.whitePlayerId
        : game.blackPlayerId;

    let text = "Game Over.";

    if (game.result === "draw") {
      text = "Draw.";
    } else if (game.winnerId) {
      text = game.winnerId === myId
        ? "You won!"
        : "You lost.";
    }

    setResultText(text);
    setStatus(text);
    setShowResultPopup(true);

    if (text.includes("won")) {
      playUiTone("win");
    }

    return;
  }

  setStatus("Game active");
}

  useEffect(() => {
    fetchState();
    const id = setInterval(fetchState, 1000);
    return () => clearInterval(id);
  }, [gameId]);

  useEffect(() => {
    if (!socket) return;

    socket.emit("join_game", { gameId });

    socket.on("move", fetchState);

    return () => {
      socket.emit("leave_game", { gameId });
      socket.off("move", fetchState);
    };
  }, [socket, gameId]);

  async function onDrop(sourceSquare, targetSquare) {
    const res = await fetch("/api/chess/move", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        gameId: Number(gameId),
        from: sourceSquare,
        to: targetSquare,
        promotion: "q",
      }),
    });

    const data = await res.json();

    if (!res.ok) return false;

    setLiveFen(data.data.fen);
    playUiTone("move");

    socket?.emit("move", { gameId });

    return true;
  }

async function resignGame() {
  if (!gameData || gameData.status !== "in_progress" || isResigning) return;

  setIsResigning(true);

  try {
    const res = await fetch("/api/chess/end-game", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        gameId: Number(gameId),
        result: "loss",
      }),
    });

    if (!res.ok) {
      setStatus("Failed to resign.");
      return;
    }

    await fetchState();
  } catch {
    setStatus("Failed to resign.");
  } finally {
    setIsResigning(false);
  }
}

  const myName =
    activeColor === "white"
      ? gameData?.whitePlayerName
      : gameData?.blackPlayerName;

  const opponentName =
    activeColor === "white"
      ? gameData?.blackPlayerName
      : gameData?.whitePlayerName;

  const myClock =
    activeColor === "white"
      ? gameData?.whiteTimeRemaining
      : gameData?.blackTimeRemaining;

  const oppClock =
    activeColor === "white"
      ? gameData?.blackTimeRemaining
      : gameData?.whiteTimeRemaining;

  return (
    <div className="min-h-screen bg-[#050816] text-white px-4 py-8 overflow-x-hidden">
      <div className="max-w-7xl mx-auto">

        {/* HEADER */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-black tracking-widest text-cyan-400 drop-shadow-[0_0_20px_#00ffff]">
            CHESS ARENA
          </h1>

          <p className="text-white/70 mt-3">
            Game #{gameId} • {isSpectator ? "Spectating" : `Playing as ${color}`}
          </p>
        </div>

        {/* MAIN */}
        <div className="grid lg:grid-cols-[1fr_340px] gap-8 items-start">

          {/* BOARD AREA */}
          <div className="flex justify-center">
            <div className="w-full max-w-[660px]">

              {/* OPPONENT */}
              <div className="mb-3 rounded-xl border border-cyan-400/30 bg-cyan-500/10 px-4 py-3 flex justify-between backdrop-blur-md">
                <span className="font-bold text-cyan-300">
                  {opponentName || "Opponent"}
                </span>
                <span className="font-mono text-xl text-cyan-100">
                  {formatClock(oppClock)}
                </span>
              </div>

             
              {/* BOARD */}
<div className="p-[2px] rounded-2xl bg-gradient-to-r from-cyan-400 via-fuchsia-500 to-cyan-400 shadow-[0_0_35px rgba(0,255,255,0.35)] w-full max-w-[90vh] aspect-square mx-auto">
  <div className="rounded-2xl overflow-hidden bg-[#0b1020] w-full h-full">
    <Chessboard
      id="CyberBoard"
      animationDuration={320}
      arePiecesDraggable={!isSpectator}
      boardOrientation={activeColor}
      position={displayFen}
      onPieceDrop={onDrop}
      customDarkSquareStyle={{
        background: "linear-gradient(135deg,#131b3a,#1b2554)",
      }}
      customLightSquareStyle={{
        background: "linear-gradient(135deg,#0ff6,#13d8ff)",
      }}
      // Removed fixed boardWidth
      // Added styling to ensure it fills the container
      customBoardStyle={{
        width: "100%",
        height: "100%",
        display: "block",
      }}
    />
  </div>
</div>


              {/* YOU */}
              <div className="mt-3 rounded-xl border border-fuchsia-400/30 bg-fuchsia-500/10 px-4 py-3 flex justify-between backdrop-blur-md">
                <span className="font-bold text-fuchsia-300">
                  {myName || "You"}
                </span>
                <span className="font-mono text-xl text-fuchsia-100">
                  {formatClock(myClock)}
                </span>
              </div>

              {/* STATUS */}
              <div className="mt-4 text-center font-semibold text-cyan-300 tracking-wide">
                {status}
              </div>
            </div>
          </div>

          {/* SIDEBAR */}
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-xl">

            <h2 className="text-2xl font-bold text-cyan-400 mb-4">
              Move History
            </h2>

            <div className="max-h-[420px] overflow-y-auto space-y-2 pr-1">
              {moves.length === 0 ? (
                <p className="text-white/60">No moves yet.</p>
              ) : (
                moves.map((move, i) => (
                  <button
                    key={move.id}
                    onClick={() => setMoveIndex(i)}
                    className="w-full text-left px-3 py-2 rounded-lg bg-white/5 hover:bg-cyan-400 hover:text-black transition-all duration-200"
                  >
                    {i + 1}. {move.moveSan}
                  </button>
                ))
              )}
            </div>

            {/* RESIGN BUTTON */}
            {!isSpectator && (
              <button
                onClick={resignGame}
                disabled={isResigning}
                className="mt-5 w-full bg-red-600 hover:bg-red-700 py-3 rounded-xl font-bold transition"
              >
                {isResigning ? "Resigning..." : "Resign"}
              </button>
            )}

            {/* RETURN */}
            <button
              onClick={() => router.push("/casino/chess")}
              className="mt-4 w-full bg-cyan-400 text-black font-bold py-3 rounded-xl hover:scale-[1.02] transition"
            >
              Return Lobby
            </button>

          </div>
        </div>
      </div>
         {showResultPopup && (
        <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center px-4">
          <div className="relative w-full max-w-md rounded-2xl border border-cyan-400/30 bg-[#0b1020] p-6 text-center overflow-hidden shadow-[0_0_40px_rgba(0,255,255,0.25)]">

            <h2 className="text-3xl font-black text-cyan-300 mb-3">
              MATCH FINISHED
            </h2>

            <p className="text-xl text-white mb-6">
              {resultText}
            </p>

            {resultText.includes("won") && (
              <div className="absolute inset-0 pointer-events-none">
                {Array.from({ length: 24 }).map((_, i) => (
                  <span
                    key={i}
                    className="absolute w-2 h-5 animate-bounce"
                    style={{
                      left: `${(i * 17) % 100}%`,
                      top: `${(i % 6) * 10}%`,
                      backgroundColor:
                        CONFETTI_COLORS[i % CONFETTI_COLORS.length],
                      animationDelay: `${i * 0.05}s`,
                    }}
                  />
                ))}
              </div>
            )}

            <button
              onClick={() => router.push("/casino/chess")}
              className="w-full bg-cyan-400 hover:bg-cyan-300 text-black font-bold py-3 rounded-xl transition"
            >
              Return to Lobby
            </button>

          </div>
        </div>
      )}
    </div>
  );
}
